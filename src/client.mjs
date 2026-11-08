import { ToolLoopAgent, isStepCount } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { textToolInstructions, visibleFilter, parseToolCalls, formatCall, formatResults } from './texttools.mjs';

// SDK warnings (unsupported settings, deprecations) are developer notes, not messages for the chat screen.
globalThis.AI_SDK_LOG_WARNINGS = false;

export const DEFAULT_BASE_URL = 'https://umayzeka.com/v1';
export const DEFAULT_MODEL = 'umay-akilli';

export function validateBaseURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('API adresi geçerli bir URL olmalı.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('API adresi HTTPS olmalı. Yerel testler için HTTP kullanılabilir.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API adresinde kullanıcı bilgisi, sorgu veya # işareti kullanma.');
  }
  return url.href.replace(/\/+$/, '');
}

class ResponseError extends Error {
  constructor(message, status) { super(message); this.statusCode = status; }
}

export function friendlyError(error, apiKey = '') {
  const status = error?.statusCode;
  let message;
  if (error?.name === 'AbortError') message = 'İstek iptal edildi.';
  else if (error?.name === 'TimeoutError') message = 'Sunucu zamanında yanıt vermedi. Tekrar deneyebilirsin.';
  else if (status === 401 && apiKey.trim() && !apiKey.trim().startsWith('umay-sk-')) {
    message = 'API anahtarı kabul edilmedi (HTTP 401). Girilen anahtar umay-sk- ile başlamıyor; başka bir servisin anahtarı olabilir. umayzeka.com → Geliştirici & API Paneli\'nden oluşturduğun anahtarı /anahtar ile gir.';
  }
  else if (status === 401) message = 'API anahtarı kabul edilmedi (HTTP 401). umayzeka.com → Geliştirici & API Paneli\'nden oluşturduğun umay-sk-... anahtarını /anahtar ile gir.';
  else if (status === 403) message = 'Erişim reddedildi. Anahtarın yetkisini ve API erişimini kontrol et.';
  else if (status === 429) message = 'İstek sınırı veya kota doldu. Bir süre bekleyip kotanı kontrol et.';
  else if (status === 503) message = 'Umay API şu anda bakımda veya kullanılamıyor. Daha sonra tekrar dene.';
  else if (error instanceof ResponseError) message = error.message;
  else if (status === 404) message = 'API adresi veya model bulunamadı. --base-url ve /model ayarını kontrol et.';
  else if (status === 400 || status === 422) message = `API isteği kabul etmedi (HTTP ${status}). /model ile modeli, /akis kapat ile akışı, /dusunme kapat ile düşünme modunu, /araclar kapat ile araçları dene.`;
  else if (status >= 500) message = `Umay sunucusunda hata oluştu (HTTP ${status}). Daha sonra tekrar dene.`;
  else if (error instanceof TypeError || /fetch|network|ENOTFOUND|ECONN|socket/i.test(error?.message ?? '')) {
    message = 'API bağlantısı kurulamadı. İnternet bağlantını ve API adresini kontrol et.';
  } else message = 'Yanıt işlenemedi. API, beklenen OpenAI uyumlu yanıtı döndürmedi.';
  return apiKey ? message.replaceAll(apiKey, '[gizli]') : message;
}

// Servers that reject stream_options are remembered for the session; requests then go without usage.
let usageRejected = false;

// Streamed requests ask for token usage (stream_options.include_usage). If the server refuses that field
// before any output, the request is repeated once without it.
export async function chat(options) {
  const includeUsage = options.stream !== false && !usageRejected;
  try {
    return await chatOnce({ ...options, includeUsage });
  } catch (error) {
    if (!includeUsage || ![400, 422].includes(error?.statusCode) || error.outputStarted || error.toolActivity) throw error;
    const result = await chatOnce({ ...options, includeUsage: false });
    usageRejected = true;
    return result;
  }
}

async function chatOnce({ apiKey, baseURL = DEFAULT_BASE_URL, model = DEFAULT_MODEL,
  messages, stream = true, timeout = 120_000, signal, onText = () => {},
  runtime, maxSteps = 25, toolMode = 'native', thinking = null, onReasoning = () => {}, includeUsage = false }) {
  baseURL = validateBaseURL(baseURL);
  if (!apiKey?.trim()) throw new Error('API anahtarı gerekli.');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const provider = createOpenAICompatible({
    name: 'umay', baseURL, apiKey, includeUsage,
    // thinking: true/false is sent as enable_thinking (the website's field) and chat_template_kwargs (Qwen-style
    // servers); null sends neither and the server decides. Umay reasons by default; false really turns it off,
    // which avoids cut-off replies but lowered benchmark scores by 11–18 points (8 Nov 2026).
    transformRequestBody: body => typeof thinking === 'boolean'
      ? { ...body, enable_thinking: thinking, chat_template_kwargs: { enable_thinking: thinking } } : body,
    // Do not forward credentials to a redirect or show an HTML page as an AI answer.
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, redirect: 'manual' });
      const contentType = response.headers.get('content-type') ?? '';
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ResponseError('API adresi başka bir sayfaya yönlendiriyor. Doğru API adresini kontrol et.', response.status);
      }
      if (!/application\/(?:[\w.-]+\+)?json|text\/event-stream/i.test(contentType)) {
        await response.body?.cancel();
        throw new ResponseError(`Sunucu JSON veya olay akışı yerine web sayfası döndürdü (HTTP ${response.status}). API adresini kontrol et.`, response.status);
      }
      return response;
    },
  });
  let sideEffects = false;
  let outputStarted = false;
  const started = (callback) => (text) => { outputStarted = true; callback(text); };
  onText = started(onText);
  onReasoning = started(onReasoning);
  const instructions = messages.filter(message => message.role === 'system');
  const textMode = runtime && toolMode === 'text';
  if (runtime) instructions.push({ role: 'system', content: runtime.instructions() });
  if (textMode) instructions.push({ role: 'system', content: textToolInstructions(runtime.metadata.tools) });
  const options = {
    model: provider(model),
    instructions,
    maxRetries: 0,
    onError: () => {},
    stopWhen: isStepCount(runtime && !textMode ? maxSteps : 1),
    ...(runtime && !textMode ? { tools: runtime.definitions(requestSignal), onToolExecutionStart: () => { sideEffects = true; } } : {}),
  };
  const agent = new ToolLoopAgent(options);
  const conversation = messages.filter(message => message.role !== 'system');
  const runStep = async (history, show) => {
    const call = { messages: history, abortSignal: requestSignal };
    // Reasoning may arrive as reasoning_content or inside <think> tags; neither is part of the answer.
    let thought = 0;
    const think = text => { thought += text.length; onReasoning(text); };
    const split = thinkSplitter(show, think);
    const begin = performance.now();
    if (!stream) {
      const result = await agent.generate(call);
      if (result.reasoningText) think(result.reasoningText);
      split.push(result.text);
      return { result, text: split.end(), ms: performance.now() - begin, thought };
    }
    // Reading fullStream ensures errors after partial output are surfaced as errors.
    const result = await agent.stream(call);
    let finished = false;
    // Generation speed is measured from the first streamed token, so waiting in the queue does not count.
    let first;
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error;
      if (part.type === 'abort') throw requestSignal.reason ?? new DOMException('Aborted', 'AbortError');
      if (part.type === 'text-delta') { first ??= performance.now(); split.push(part.text); }
      if (part.type === 'reasoning-delta') { first ??= performance.now(); think(part.text); }
      if (part.type === 'finish-step') {
        if (part.finishReason === 'error') throw new ResponseError('Yanıt akışı sunucu hatasıyla kesildi.');
        finished = true;
      }
    }
    requestSignal.throwIfAborted();
    if (!finished) throw new ResponseError('API yanıtı tamamlanmadan kesildi.');
    return { result, text: split.end(), ms: performance.now() - (first ?? begin), thought };
  };
  try {
    if (textMode) {
      const result = await runTextTools({ runtime, signal: requestSignal, maxSteps, conversation, runStep, onText,
        onToolStart: () => { sideEffects = true; } });
      return { ...result, stats: { ...result.stats, streamed: stream } };
    }
    const { result, text, ms, thought } = await runStep(conversation, onText);
    const history = await result.responseMessages;
    const finishReason = await result.finishReason;
    const stepLimit = finishReason === 'tool-calls';
    if (!text.trim() && !stepLimit) throw emptyAnswer(finishReason, thought);
    const usage = await result.usage;
    return { text, usage, finishReason, messages: history, stepLimit, stats: { ...stepStats(usage, ms), streamed: stream } };
  } catch (error) {
    const failure = requestSignal.aborted ? requestSignal.reason : error;
    if (failure && typeof failure === 'object') { failure.toolActivity = sideEffects; failure.outputStarted = outputStarted; }
    throw failure;
  }
}

// No answer text: either the length limit was hit, or the reply was all reasoning and stopped before the answer.
// Umay ends such replies without finish_reason "length" (8 Nov 2026), so reasoning without an answer counts too.
function emptyAnswer(finishReason, thought = 0) {
  return new ResponseError(finishReason === 'length' || thought > 0
    ? 'Model yanıt uzunluk sınırına cevap yazamadan ulaştı (çoğunlukla düşünürken). /dusunme kapat ile veya isteği bölerek tekrar dene.'
    : 'API boş bir yanıt döndürdü.');
}

// Generation time, and the conversation size after the last request (its input plus its output), in tokens.
function stepStats(usage, ms, previous = { generationMs: 0 }) {
  const known = Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens);
  return { generationMs: previous.generationMs + (ms ?? 0), contextTokens: known ? usage.inputTokens + usage.outputTokens : undefined };
}

// Routes <think>…</think> segments to onReasoning and returns the remaining answer text at the end.
export function thinkSplitter(onContent, onReasoning) {
  const tags = { false: '<think>', true: '</think>' };
  let inside = false;
  let buffer = '';
  let content = '';
  const emit = text => {
    if (!text) return;
    if (inside) onReasoning(text); else { content += text; onContent(text); }
  };
  const drain = final => {
    for (;;) {
      const tag = tags[inside];
      const index = buffer.indexOf(tag);
      if (index >= 0) { emit(buffer.slice(0, index)); buffer = buffer.slice(index + tag.length); inside = !inside; continue; }
      let keep = 0;
      if (!final) for (let size = Math.min(tag.length - 1, buffer.length); size > 0; size--) {
        if (tag.startsWith(buffer.slice(-size))) { keep = size; break; }
      }
      emit(buffer.slice(0, buffer.length - keep)); buffer = buffer.slice(buffer.length - keep);
      return;
    }
  };
  return {
    push(text) { buffer += text; drain(false); },
    end() { drain(true); return content; },
  };
}

// Agent loop for the text protocol: run one model step, execute its <tool_call> blocks, send results back.
async function runTextTools({ runtime, signal, maxSteps, conversation, runStep, onText, onToolStart }) {
  const tools = runtime.definitions(signal);
  const history = [];
  // Counts stay undefined when the server reports no usage, so the CLI shows no token total.
  const usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };
  let stats = { generationMs: 0 };
  for (let step = 1; ; step++) {
    const filter = visibleFilter(onText);
    const { result, text, ms, thought } = await runStep([...conversation, ...history], delta => filter.push(delta));
    filter.flush();
    const stepUsage = await result.usage;
    stats = stepStats(stepUsage, ms, stats);
    for (const key of Object.keys(usage)) {
      if (Number.isFinite(stepUsage?.[key])) usage[key] = (usage[key] ?? 0) + stepUsage[key];
    }
    const parsed = parseToolCalls(text);
    if (!parsed) {
      if (!text.trim()) throw emptyAnswer(await result.finishReason, thought);
      history.push({ role: 'assistant', content: text });
      return { text, usage, finishReason: await result.finishReason, messages: history, stepLimit: false, stats };
    }
    const valid = parsed.calls.filter(call => !call.error);
    history.push({ role: 'assistant',
      content: [parsed.before, ...valid.map(formatCall)].filter(Boolean).join('\n\n') || text.trim() });
    const results = [];
    for (const call of parsed.calls) {
      signal.throwIfAborted();
      let result;
      if (call.error) result = `Hata: ${call.error}`;
      else if (!tools[call.name]) {
        result = `Hata: Bilinmeyen araç: ${call.name}. Geçerli araçlar: ${Object.keys(tools).join(', ')}`;
      } else {
        onToolStart();
        result = await tools[call.name].execute(call.args);
      }
      if (call.error || !tools[call.name]) runtime.onEvent({ type: 'result', name: call.name ?? 'araç', result });
      results.push({ name: call.name ?? 'hata', result });
    }
    signal.throwIfAborted();
    history.push({ role: 'user', content: formatResults(results) });
    if (step >= maxSteps) return { text: parsed.before, usage, finishReason: 'tool-calls', messages: history, stepLimit: true, stats };
  }
}
