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

const GATEWAY = new Set([502, 504, 520, 521, 522, 523, 524]);

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

class ResponseError extends Error {
  constructor(message, status) { super(message); this.statusCode = status; }
}

// Ends a request when the user cancels it, or when the server has sent nothing for `ms`. The clock runs only
// while a model request is in flight: every streamed part restarts it and it is held while tools run or wait
// for approval. A long agent turn, a long answer or a slow reader is therefore not taken for a silent server.
function watchdog(signal, ms) {
  const controller = new AbortController();
  let timer;
  let running = false; // a model request is in flight
  let held = 0;        // tools busy inside that request
  const cancel = () => controller.abort(signal.reason);
  const disarm = () => { clearTimeout(timer); timer = undefined; };
  const arm = () => {
    disarm();
    if (!running || held) return;
    timer = setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
  };
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  return {
    signal: controller.signal,
    begin() { running = true; arm(); },
    touch: arm,
    end() { running = false; disarm(); },
    hold() { held++; disarm(); },
    release() { held--; arm(); },
    close() { running = false; disarm(); signal?.removeEventListener('abort', cancel); },
  };
}

// In native mode the SDK runs the tools inside the request, so the clock is held while any tool is busy.
function holdDuringTools(tools, watch, onStart) {
  for (const entry of Object.values(tools)) {
    const execute = entry.execute;
    entry.execute = async (...args) => {
      onStart(); watch.hold();
      try { return await execute(...args); } finally { watch.release(); }
    };
  }
  return tools;
}

// Failures that arrive inside an HTTP 200 answer. Umay reports overload and its own time limits this way
// (9 Nov 2026); they are not a sign of a wrong address or model, so each gets its own message.
function streamFailure(error, outputStarted) {
  if (error?.name === 'AI_StreamProviderError' && error.message) {
    return new ResponseError(`Umay sunucusu hata bildirdi: ${String(error.message).split('\n')[0].slice(0, 300)}`);
  }
  if (error?.name === 'AI_InvalidResponseDataError' && /finish reason/i.test(error.message)) {
    return new ResponseError(outputStarted
      ? 'Yanıt tamamlanmadan kesildi: sunucu akışı bitirmeden kapattı. Tekrar deneyebilirsin.'
      : 'Sunucu hiçbir şey göndermeden bağlantıyı kapattı. Umay tarafında yoğunluk olabilir; biraz sonra tekrar dene.');
  }
  const cause = error?.cause;
  if (error?.name === 'AI_APICallError' && (cause?.message === 'terminated' || /ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(`${cause?.code} ${cause?.cause?.code}`))) {
    return new ResponseError('Bağlantı yanıt tamamlanmadan koptu. İnternet bağlantını kontrol edip tekrar dene.');
  }
  return error;
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
  const watch = watchdog(signal, timeout);
  const requestSignal = watch.signal;
  const provider = createOpenAICompatible({
    name: 'umay', baseURL, apiKey, includeUsage,
    // thinking: true/false is sent as enable_thinking (the website's field) and chat_template_kwargs (Qwen-style
    // servers); null sends neither and the server decides. Umay reasons by default; false really turns it off,
    // which avoids cut-off replies but lowered benchmark scores by 11–18 points (8 Nov 2026).
    transformRequestBody: body => typeof thinking === 'boolean'
      ? { ...body, enable_thinking: thinking, chat_template_kwargs: { enable_thinking: thinking } } : body,
    // Do not forward credentials to a redirect or show an HTML page as an AI answer.
    fetch: async (url, init) => {
      let response = await fetch(url, { ...init, redirect: 'manual' });
      // Gateway errors (Cloudflare 52x, 502, 504) are usually momentary: the request did not reach the model,
      // so it is sent once more after a short wait. 503 is Umay's maintenance answer and is not repeated.
      if (GATEWAY.has(response.status)) {
        await response.body?.cancel();
        await pause(2000, init?.signal);
        response = await fetch(url, { ...init, redirect: 'manual' });
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ResponseError('API adresi başka bir sayfaya yönlendiriyor. Doğru API adresini kontrol et.', response.status);
      }
      if (!/application\/(?:[\w.-]+\+)?json|text\/event-stream/i.test(contentType)) {
        await response.body?.cancel();
        if (GATEWAY.has(response.status)) {
          throw new ResponseError(`Umay sunucusuna şu an ulaşılamıyor (HTTP ${response.status}). Bu Umay tarafında geçici bir sorun; biraz sonra tekrar dene.`, response.status);
        }
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
    ...(runtime && !textMode
      ? { tools: holdDuringTools(runtime.definitions(requestSignal), watch, () => { sideEffects = true; }) } : {}),
  };
  const agent = new ToolLoopAgent(options);
  const conversation = messages.filter(message => message.role !== 'system');
  // One model request (in native mode: the SDK's whole tool loop).
  const runStep = async (history, show) => {
    const call = { messages: history, abortSignal: requestSignal };
    // Reasoning may arrive as reasoning_content or inside <think> tags; neither is part of the answer.
    let thought = 0;
    const think = text => { thought += text.length; onReasoning(text); };
    const split = thinkSplitter(show, think);
    const begin = performance.now();
    watch.begin();
    try {
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
        watch.touch();
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
    } finally { watch.end(); }
  };
  // Text mode: the steps finished before a failure, so an interrupted turn can stay in the conversation.
  const partial = [];
  try {
    if (textMode) {
      const result = await runTextTools({ runtime, signal: requestSignal, maxSteps, conversation, runStep, onText,
        history: partial, onToolStart: () => { sideEffects = true; } });
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
    const failure = requestSignal.aborted ? requestSignal.reason : streamFailure(error, outputStarted);
    if (failure && typeof failure === 'object') {
      failure.toolActivity = sideEffects;
      failure.outputStarted = outputStarted;
      // The conversation must not end on tool results: the next user message would follow them directly.
      if (partial.length) failure.partialMessages = [...partial, { role: 'assistant', content: 'Tur burada kesildi; görev tamamlanmadı.' }];
    }
    throw failure;
  } finally { watch.close(); }
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
// `history` receives the finished steps as they happen; the caller keeps it when the turn fails midway.
async function runTextTools({ runtime, signal, maxSteps, conversation, runStep, onText, onToolStart, history = [] }) {
  const tools = runtime.definitions(signal);
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
    const parsed = parseToolCalls(text, runtime.metadata.tools);
    if (!parsed) {
      if (!text.trim()) throw emptyAnswer(await result.finishReason, thought);
      history.push({ role: 'assistant', content: text });
      return { text, usage, finishReason: await result.finishReason, messages: history, stepLimit: false, stats };
    }
    const valid = parsed.calls.filter(call => !call.error);
    history.push({ role: 'assistant',
      content: [parsed.before, ...valid.map(formatCall)].filter(Boolean).join('\n\n') || text.trim() });
    const results = [];
    try {
      for (const call of parsed.calls) {
        signal.throwIfAborted();
        let result;
        // hasOwn: a made-up name such as "constructor" must not find a method of the object.
        const known = !call.error && Object.hasOwn(tools, call.name);
        if (call.error) result = `Hata: ${call.error}`;
        else if (!known) {
          result = `Hata: Bilinmeyen araç: ${call.name}. Geçerli araçlar: ${Object.keys(tools).join(', ')}`;
        } else {
          onToolStart();
          result = await tools[call.name].execute(call.args);
        }
        if (!known) runtime.onEvent({ type: 'result', name: call.name ?? 'araç', result });
        results.push({ name: call.name ?? 'hata', result });
      }
      signal.throwIfAborted();
    } catch (error) {
      // Stopped between or inside tools: the calls above are already in the history, so their outcome is too.
      const pending = parsed.calls.slice(results.length).map(call => ({ name: call.name ?? 'hata',
        result: 'Tur kesildi; bu çağrı tamamlanmadı. Sonucu bilinmiyor: gerekiyorsa durumu kontrol et.' }));
      history.push({ role: 'user', content: formatResults([...results, ...pending]) });
      throw error;
    }
    history.push({ role: 'user', content: formatResults(results) });
    if (step >= maxSteps) return { text: parsed.before, usage, finishReason: 'tool-calls', messages: history, stepLimit: true, stats };
  }
}
