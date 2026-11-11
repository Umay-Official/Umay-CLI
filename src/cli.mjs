#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { chat, friendlyError, validateBaseURL, DEFAULT_BASE_URL, DEFAULT_MODEL } from './client.mjs';
import { ToolRuntime } from './tools.mjs';
import { t, color, clean, banner, box, rule, spinner, fileLink, width, formatStats } from './theme.mjs';
import { markdownStream } from './markdown.mjs';
import { loadAttachment, buildUserContent, importGitHub, UserError } from './attachments.mjs';
import { GENERATORS, generate } from './documents.mjs';
import { Memory } from './memory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const MODELS = { 'umay-akilli': 'Umay Akıllı', 'umay-hizli': 'Umay Hızlı', 'umay-ultra-hizli': 'Umay Ultra Hızlı', 'umay-daha-zeki': 'Umay Daha Zeki' };
const modelName = id => MODELS[id] ?? id;
const ON = ['on', 'ac', 'aç', 'acik', 'açık', 'evet'];
const OFF = ['off', 'kapat', 'kapali', 'kapalı', 'hayir', 'hayır'];
const settingsFile = process.env.UMAY_SETTINGS || path.join(os.homedir(), '.umay', 'ayarlar.json');
const showError = text => console.error(`  ${t.red('✗')} ${t.red(clean(text))}`);
const note = text => console.log(`  ${t.dim(text)}`);
const ok = text => console.log(`  ${t.green('✓')} ${text}`);
let runtime;

function resolveModel(value) {
  const name = value.trim().toLocaleLowerCase('tr');
  if (['akilli', 'akıllı', 'smart', 'umay-akilli'].includes(name)) return 'umay-akilli';
  if (['hizli', 'hızlı', 'fast', 'umay-hizli'].includes(name)) return 'umay-hizli';
  if (['ultra', 'ultra-hizli', 'ultra-hızlı', 'ultra-fast', 'umay-ultra-hizli'].includes(name)) return 'umay-ultra-hizli';
  if (['zeki', 'daha-zeki', 'smarter', 'umay-zeki', 'umay-daha-zeki'].includes(name)) return 'umay-daha-zeki';
  return value.trim();
}

// Thinking: true sends enable_thinking true, false sends false, null sends nothing (the server decides).
const thinkingName = value => value === true ? 'açık' : value === false ? 'kapalı' : 'otomatik';
function parseThinking(value) {
  const name = String(value ?? '').trim().toLocaleLowerCase('tr');
  if (ON.includes(name) || ['1', 'true'].includes(name)) return true;
  if (OFF.includes(name) || ['0', 'false'].includes(name)) return false;
  if (['otomatik', 'oto', 'auto', 'varsayilan', 'varsayılan'].includes(name)) return null;
  return undefined;
}

function toggle(arg, current, usage) {
  const value = arg.toLocaleLowerCase('tr');
  if (!value) return !current;
  if (ON.includes(value)) return true;
  if (OFF.includes(value)) return false;
  throw new UserError(`Kullanım: ${usage} [ac|kapat]`);
}

const isDirectory = target => statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;

function loadSettings() {
  try { return JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return {}; }
}

async function saveSettings(config) {
  try {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ model: config.model, thinkingMode: thinkingName(config.thinking), stream: config.stream, memory: config.memory }, null, 2) + '\n');
  } catch { /* Preferences are a convenience; failing to save them must not stop the session. */ }
}

// ---------- Commands ----------

const COMMANDS = [
  { group: 'Sohbet', name: '/yardim', aliases: ['/help', '/?', '/komutlar'], desc: 'Tüm komutları göster' },
  { group: 'Sohbet', name: '/yeni', aliases: ['/new', '/temizle'], desc: 'Yeni sohbet başlat' },
  { group: 'Sohbet', name: '/gecmis', aliases: ['/history', '/geçmiş'], desc: 'Bu oturumdaki mesajları göster' },
  { group: 'Sohbet', name: '/kaydet', aliases: ['/save'], args: '[dosya.json]', desc: 'Sohbeti kaydet' },
  { group: 'Sohbet', name: '/yukle', aliases: ['/load', '/yükle'], args: '<dosya.json>', desc: 'Kaydedilmiş sohbeti aç' },
  { group: 'Sohbet', name: '/bellek', aliases: ['/hafiza', '/hafıza', '/memory'], args: '[ekle|sil|temizle|ac|kapat]', desc: 'Kalıcı notlar; her sohbette Umay\'a hatırlatılır' },
  { group: 'Sohbet', name: '/cok-satir', aliases: ['/multi', '/çok-satır'], desc: 'Çok satırlı mesaj yaz' },
  { group: 'Sohbet', name: '/cikis', aliases: ['/exit', '/quit', '/çıkış'], desc: 'Çık' },
  { group: 'Model', name: '/model', aliases: ['/models', '/modeller'], args: '[akilli|hizli|ultra|zeki]', desc: 'Modeli gör veya değiştir' },
  { group: 'Model', name: '/akilli', aliases: ['/akıllı'], desc: 'Umay Akıllı: daha güçlü yanıtlar' },
  { group: 'Model', name: '/hizli', aliases: ['/hızlı'], desc: 'Umay Hızlı: daha çabuk yanıtlar' },
  { group: 'Model', name: '/dusunme', aliases: ['/düşünme', '/think'], args: '[ac|kapat|otomatik]', desc: 'Düşünme: açık, kapalı ya da Umay karar versin' },
  { group: 'Model', name: '/dusunce', aliases: ['/düşünce'], desc: 'Son yanıtın düşüncelerini tam göster' },
  { group: 'Model', name: '/akis', aliases: ['/stream', '/akış'], args: '[ac|kapat]', desc: 'Yanıtı canlı yazdır' },
  { group: 'Model', name: '/anahtar', aliases: ['/key'], desc: 'API anahtarını değiştir' },
  { group: 'Dosya ve kod', name: '/ekle', aliases: ['/dosya', '/gorsel', '/görsel', '/attach'], args: '<dosya>', desc: 'Sonraki mesaja metin, kod, Word, Excel ekle' },
  { group: 'Dosya ve kod', name: '/ekler', aliases: [], args: '[temizle]', desc: 'Bekleyen ekleri gör veya kaldır' },
  { group: 'Dosya ve kod', name: '/github', aliases: ['/kod-aktar'], args: '<depo>', desc: 'GitHub deposunu indirip incele' },
  { group: 'Dosya ve kod', name: '/cd', aliases: ['/klasor', '/klasör'], args: '[klasör]', desc: 'Çalışma klasörünü gör/değiştir' },
  { group: 'Dosya ve kod', name: '/araclar', aliases: ['/tools', '/araçlar'], args: '[ac|kapat]', desc: 'Yerel dosya/komut araçlarını aç/kapat' },
  { group: 'Dosya ve kod', name: '/oto', aliases: ['/auto'], args: '[ac|kapat]', desc: 'Yazma ve komutları onaysız çalıştır' },
  { group: 'Dosya ve kod', name: '/geri-al', aliases: ['/undo'], desc: 'Son dosya değişikliğini geri al' },
  ...Object.entries(GENERATORS).map(([kind, gen]) => ({
    group: 'Üretim', name: `/${kind}`, aliases: { dokuman: ['/doküman', '/belge'], rapor: ['/excel'], sema: ['/şema'] }[kind] ?? [],
    args: '<konu>', desc: gen.desc, kind })),
  { group: 'Üretim', name: '/konsey', aliases: [], args: '<konu>', desc: 'Yazılımcı, tasarımcı ve pazarlamacı tartışır' },
  { group: 'Üretim', name: '/ac', aliases: ['/aç'], desc: 'Son üretilen dosyayı aç' },
];
const LOOKUP = new Map(COMMANDS.flatMap(command => [command.name, ...command.aliases].map(name => [name, command])));
const SITE_ONLY = {
  '/derin-arastirma': 'canlı web araması', '/derin-araştırma': 'canlı web araması', '/yt-ozetle': 'YouTube erişimi',
  '/yt-özetle': 'YouTube erişimi', '/mail': 'Gmail bağlantısı',
};

function help() {
  const groups = [...new Set(COMMANDS.map(command => command.group))];
  const lines = ['', rule('Komutlar')];
  for (const group of groups) {
    lines.push('', `  ${t.redBold(group)}`);
    for (const command of COMMANDS.filter(item => item.group === group)) {
      const label = `${command.name}${command.args ? ' ' + command.args : ''}`;
      lines.push(`    ${t.white(command.name)}${t.dim(command.args ? ' ' + command.args : '')}${' '.repeat(Math.max(2, 26 - label.length))}${t.text(command.desc)}`);
    }
  }
  lines.push('', `  ${t.redBold('Kısayollar')}`,
    `    ${t.white('Tab')}                       Komutu veya dosya yolunu tamamla`,
    `    ${t.white('/')} + Enter                 Komut menüsünü aç`,
    `    ${t.white('Ctrl+C')}                    Yanıtı durdur; boş satırda çıkış`,
    '', `  ${t.dim('Sitedeki /derin-arastirma, /yt-özetle ve /mail Umay sunucusunda çalışır; API ile kullanılamaz.')}`, '');
  console.log(lines.join('\n'));
}

function usage() {
  console.log(`${banner()}
  ${t.redBold('Kullanım')}
    umay                              Sohbeti başlat
    umay --hizli                      Umay Hızlı ile başlat
    umay --dusunme                    Düşünme açık başlat (--dusunme-kapali: kapalı)
    umay --prompt "soru"              Tek soru sor ve çık
    umay --prompt "/sunum konu"       Tek komutla belge üret

  ${t.redBold('Seçenekler')}
    --model <ad>, --hizli, --dusunme, --dusunme-kapali, --no-stream, --no-tools, --tool-mode text|native,
    --cwd <klasör>, --system <metin>, --timeout <sn>, --max-steps <n>, --yes, --base-url <url>
    --timeout: sunucudan hiç veri gelmeden beklenecek süre (varsayılan 120 sn); yanıt akarken ve onay beklerken sayılmaz

  ${t.redBold('Ortam')}
    UMAY_API_KEY, UMAY_MODEL, UMAY_THINKING, UMAY_BASE_URL, UMAY_PYTHON, UMAY_TOOL_MODE
    Tercihler (model, düşünme, akış) ${settingsFile} dosyasında tutulur.`);
  help();
}

function completer(line) {
  if (!line.startsWith('/')) return [[], line];
  const space = line.indexOf(' ');
  if (space < 0) {
    const primary = COMMANDS.map(command => command.name).filter(name => name.startsWith(line));
    const hits = primary.length ? primary : [...LOOKUP.keys()].filter(name => name.startsWith(line));
    return [hits.length ? hits : COMMANDS.map(command => command.name), line];
  }
  const command = LOOKUP.get(line.slice(0, space).toLowerCase())?.name;
  const arg = line.slice(space + 1);
  const pick = options => [options.filter(option => option.startsWith(arg)), arg];
  if (command === '/model') return pick(['akilli', 'hizli', 'ultra', 'zeki']);
  if (command === '/dusunme') return pick(['ac', 'kapat', 'otomatik']);
  if (['/akis', '/oto'].includes(command)) return pick(['ac', 'kapat']);
  if (command === '/araclar') return pick(['ac', 'kapat', 'text', 'native']);
  if (command === '/ekler') return pick(['temizle']);
  if (command === '/bellek') return pick(['ekle ', 'sil ', 'temizle', 'ac', 'kapat']);
  if (['/ekle', '/cd', '/yukle', '/kaydet'].includes(command)) return [completePath(arg, command === '/cd'), arg];
  return [[], line];
}

let currentDir = process.cwd();
function completePath(partial, directoriesOnly) {
  const cut = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf('\\'));
  const head = partial.slice(0, cut + 1);
  const base = partial.slice(cut + 1).toLocaleLowerCase('tr');
  try {
    return readdirSync(path.resolve(currentDir, head || '.'), { withFileTypes: true })
      .filter(entry => entry.name.toLocaleLowerCase('tr').startsWith(base) && (!directoriesOnly || entry.isDirectory()))
      .map(entry => head + entry.name + (entry.isDirectory() ? path.sep : ''));
  } catch { return []; }
}

// ---------- Input ----------

// `fresh` is for approvals: only a line typed after the question appeared may answer it. Lines typed ahead are
// dropped, since an early "e" would approve a change nobody has seen yet.
function ask(rl, prompt, signal, { fresh = false } = {}) {
  if (fresh && rl.queued?.length) {
    process.stdout.write(`  ${t.dim(`Önceden yazılmış ${rl.queued.length} satır yok sayıldı.`)}\n`);
    rl.queued.length = 0;
  }
  // Lines that arrived while no question was waiting (a multi-line paste, piped input).
  if (rl.queued?.length) {
    const line = rl.queued.shift();
    process.stdout.write(prompt + line + '\n');
    return Promise.resolve(line);
  }
  if (rl.closed) return Promise.resolve(null);
  return new Promise(resolve => {
    const done = value => { rl.off('close', close); signal?.removeEventListener('abort', close); resolve(value); };
    const close = () => done(null);
    rl.once('close', close);
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) { close(); return; }
    rl.question(prompt, { signal }, done);
  });
}

async function readKey() {
  if (!process.stdin.isTTY) throw new Error('UMAY_API_KEY ortam değişkenini ayarla.');
  process.stdout.write(`  ${t.red('◆')} ${t.white('Umay API anahtarı')} ${t.dim('(gizli, ekranda görünmez)')}: `);
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const secret = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  secret.on('SIGINT', () => secret.close());
  try { return (await ask(secret, '') ?? '').trim(); }
  finally { secret.close(); process.stdout.write('\n'); }
}

function previewLines(preview) {
  // Trailing blank lines of a diff would only add empty rows to the box.
  const lines = clean(preview).replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, 40).map(line => {
    if (/^(\+\+\+|---)/.test(line)) return t.white(line);
    if (line.startsWith('+')) return t.green(line);
    if (line.startsWith('-')) return t.red(line);
    if (line.startsWith('@@')) return t.dim(line);
    return t.text(line);
  });
  if (lines.length > 40) shown.push(t.dim(`… ${lines.length - 40} satır daha`));
  return shown;
}

function argSummary(args = {}) {
  // Arguments come from the model and may have any type.
  const value = args.path ?? args.pattern ?? args.command ?? String(args.code ?? '').split('\n')[0];
  const text = clean(String(value)).replace(/\s+/g, ' ');
  return text.length > 70 ? text.slice(0, 69) + '…' : text;
}

function openFile(file) {
  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

// ---------- Main ----------

async function main() {
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, model: { type: 'string' }, hizli: { type: 'boolean', default: false },
    dusunme: { type: 'boolean', default: false }, 'dusunme-kapali': { type: 'boolean', default: false },
    'base-url': { type: 'string' }, timeout: { type: 'string', default: '120' },
    prompt: { type: 'string', short: 'p' }, system: { type: 'string' },
    'no-stream': { type: 'boolean', default: false },
    'no-tools': { type: 'boolean', default: false }, cwd: { type: 'string' },
    'tool-mode': { type: 'string' },
    'max-steps': { type: 'string', default: '25' }, yes: { type: 'boolean', default: false },
  } });
  if (values.help) { usage(); return; }
  const saved = loadSettings();
  // null is a real choice here ("otomatik"), so only an unset or unknown value falls through to the saved one.
  const envThinking = parseThinking(process.env.UMAY_THINKING);
  const config = {
    model: resolveModel(values.model ?? (values.hizli ? 'umay-hizli' : undefined) ?? process.env.UMAY_MODEL ?? saved.model ?? DEFAULT_MODEL),
    baseURL: validateBaseURL(values['base-url'] ?? process.env.UMAY_BASE_URL ?? DEFAULT_BASE_URL),
    timeout: Number(values.timeout) * 1000,
    stream: !values['no-stream'] && saved.stream !== false,
    // Older settings files stored thinking: true/false, where false meant "send nothing" (now: otomatik).
    thinking: values.dusunme ? true : values['dusunme-kapali'] ? false
      : envThinking !== undefined ? envThinking
        : saved.thinkingMode !== undefined ? parseThinking(saved.thinkingMode) ?? null : saved.thinking === true ? true : null,
    apiKey: process.env.UMAY_API_KEY?.trim(),
    maxSteps: Number(values['max-steps']),
    toolMode: values['tool-mode'] ?? process.env.UMAY_TOOL_MODE ?? 'text',
    memory: saved.memory !== false,
  };
  if (!['text', 'native'].includes(config.toolMode)) throw new Error('--tool-mode text veya native olmalı.');
  if (!Number.isFinite(config.timeout) || config.timeout < 1000 || config.timeout > 3_600_000) {
    throw new Error('--timeout 1 ile 3600 saniye arasında olmalı.');
  }
  if (!config.model) throw new Error('Model adı boş olamaz.');
  if (!Number.isInteger(config.maxSteps) || config.maxSteps < 1 || config.maxSteps > 100) {
    throw new Error('--max-steps 1 ile 100 arasında bir tam sayı olmalı.');
  }

  currentDir = path.resolve(values.cwd || process.cwd());
  // Otherwise the tool bridge fails to start in it and blames the Python installation.
  if (!isDirectory(currentDir)) throw new Error(`--cwd klasörü bulunamadı: ${currentDir}`);
  let toolsOn = !values['no-tools'];
  let rl;
  let view;
  let active;
  let attachments = [];
  let lastFiles = [];
  let lastThought = '';
  const memory = new Memory(path.join(path.dirname(settingsFile), 'bellek.md')).load();
  // Notes are added to every request (chat, generators, council) but not stored in the conversation history.
  const remember = list => memory.apply(list, config.memory);
  // The model does not know the current date; documents and answers need it.
  const todayText = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const system = values.system ?? `Sen Umay'sın: Türkiye'nin bağımsız yapay zeka asistanı. Kullanıcının dilinde açık, doğru ve anlaşılır yanıtlar ver; uygun olduğunda Markdown başlıkları, maddeler ve tablolar kullan. Bugünün tarihi: ${todayText}.`;
  let messages = [{ role: 'system', content: system }];

  // One answer on screen: spinner, reasoning, Markdown text and tool progress.
  function createView(title = 'Umay') {
    const interactive = color;
    if (process.stdout.isTTY && title) {
      console.log(`\n  ${t.red('☾★')} ${t.white(title)} ${t.dim(`· ${modelName(config.model)}${config.thinking === null ? '' : ` · düşünme ${thinkingName(config.thinking)}`}`)}`);
    }
    let spin = interactive ? spinner(config.thinking === true ? 'düşünüyor' : 'yanıt bekleniyor') : null;
    let ended = true;
    const md = markdownStream(text => { if (!text) return; process.stdout.write(text); ended = text.endsWith('\n'); });
    let state = 'wait';
    // Reasoning is shown as one live line, then collapsed; /dusunce prints it in full.
    let thought = '';
    let stepThought = '';
    let thinkStart = 0;
    const stop = () => { spin?.stop(); spin = null; };
    const closeThinking = () => {
      if (state !== 'reasoning') return;
      stop();
      const words = stepThought.trim().split(/\s+/).filter(Boolean).length;
      console.log(`  ${t.dim(`┊ düşündü · ${((Date.now() - thinkStart) / 1000).toFixed(1)} sn · ${words} kelime · /dusunce`)}`);
      state = 'wait';
    };
    const pause = () => { stop(); md.end(); closeThinking(); };
    return {
      text(chunk) {
        stop();
        closeThinking();
        state = 'content';
        md.push(clean(chunk));
      },
      reasoning(chunk) {
        thought += chunk;
        if (!interactive) return;
        if (state !== 'reasoning') {
          md.end(); stop();
          state = 'reasoning'; stepThought = ''; thinkStart = Date.now();
          spin = spinner('düşünüyor');
        }
        stepThought += chunk;
        const tail = clean(stepThought).trim().split('\n').at(-1).trim();
        spin?.update(`düşünüyor${tail ? ` · ${tail.length > 70 ? '…' + tail.slice(-69) : tail}` : ''}`);
      },
      get thought() { return thought; },
      tool(event) {
        pause();
        if (event.type === 'start') {
          console.error(`  ${t.red('›')} ${t.white(event.name)} ${t.dim(argSummary(event.args))}`);
          return;
        }
        const bad = /^(Hata:|Kullanıcı|çıkış kodu: (?!0\b))/.test(event.result);
        const first = clean(event.result.split('\n')[0]);
        console.error(`  ${bad ? t.red('✗') : t.green('✓')} ${t.dim(first.length > width() - 8 ? first.slice(0, width() - 9) + '…' : first)}`);
        if (interactive) spin = spinner('düşünüyor');
      },
      pause,
      finish() {
        pause();
        // Plain output (no color) has no Markdown renderer to end the line.
        if (!interactive && state === 'content' && !ended) process.stdout.write('\n');
      },
    };
  }

  const ensureRuntime = async () => {
    if (runtime) return runtime;
    runtime = new ToolRuntime({
      cwd: currentDir, auto: values.yes,
      onEvent: event => {
        if (view) { view.tool(event); return; }
        console.error(t.dim(`  › ${event.name}: ${clean(event.type === 'start' ? 'çalışıyor…' : event.result.split('\n')[0]).slice(0, 200)}`));
      },
      confirm: async ({ name, preview, signal }) => {
        if (!process.stdin.isTTY) return false;
        view?.pause();
        console.error(box(previewLines(preview), `Onay gerekiyor · ${name}`));
        const terminal = rl ?? createInterface({ input: process.stdin, output: process.stderr });
        if (!rl) terminal.on('SIGINT', () => terminal.close());
        try {
          const answer = (await ask(terminal, `  ${t.yellow('?')} ${t.white('Onaylıyor musun?')} ${t.dim('[e] evet · [h] hayır · [t] bu araç için hep evet')} ${t.red('❯')} `, signal, { fresh: true }) ?? '').trim().toLocaleLowerCase('tr');
          return ['e', 'evet', 'y', 'yes'].includes(answer) ? true : answer === 't' ? 'always' : false;
        } finally { if (!rl) terminal.close(); }
      },
    });
    try { await runtime.start(); }
    catch (error) { await runtime.close(); runtime = undefined; throw error; }
    return runtime;
  };
  if (toolsOn) await ensureRuntime();

  const footer = (start, usage, stats) => {
    console.log(`\n  ${t.dim(formatStats((Date.now() - start) / 1000, usage, stats))}`);
  };

  async function sendChat(input) {
    const used = attachments;
    attachments = [];
    const pending = [...messages, { role: 'user', content: buildUserContent(input, used) }];
    active = new AbortController();
    view = createView();
    const start = Date.now();
    try {
      const response = await chat({ ...config, runtime: toolsOn ? runtime : undefined, messages: remember(pending), signal: active.signal,
        onText: view.text, onReasoning: view.reasoning });
      view.finish();
      messages = [...pending, ...response.messages];
      footer(start, response.usage, response.stats);
      if (response.finishReason === 'length') note('Yanıt uzunluk sınırında bitti. "devam et" yazabilirsin.');
      if (response.stepLimit) note('Ajan adım sınırına ulaştı. Tamamlanan işlemler korundu; sürdürmek için "devam et" yaz.');
    } catch (error) {
      view.finish();
      showError(friendlyError(error, config.apiKey));
      // The finished tool steps stay in the conversation; without them Umay would not know what it already did.
      if (error.partialMessages?.length) messages = [...pending, ...error.partialMessages];
      else if (!error.toolActivity) attachments = used;
      note(error.partialMessages?.length
        ? 'Tur kesildi. Yapılan işlemler ve sonuçları sohbette duruyor; sürdürmek için "devam et" yaz. /geri-al son dosya değişikliğini geri alır.'
        : error.toolActivity
          ? 'Tur kesildi. Yapılan dosya/komut işlemleri korunuyor; /geri-al son dosya değişikliğini geri alır.'
          : 'Bu mesaj geçmişe eklenmedi. Tekrar gönderebilirsin.');
    } finally { if (view?.thought) lastThought = view.thought; active = undefined; view = undefined; }
  }

  async function runGenerator(kind, topic) {
    const gen = GENERATORS[kind];
    if (!topic.trim() && !attachments.length) throw new UserError(`Konu yaz. Örnek: ${gen.example}`);
    const used = attachments;
    attachments = [];
    active = new AbortController();
    if (process.stdout.isTTY) console.log(`\n  ${t.red('☾★')} ${t.white(gen.label)} ${t.dim(`· ${modelName(config.model)}`)}`);
    const spin = spinner(`${gen.label} hazırlanıyor`);
    const start = Date.now();
    const askModel = async (list, generator) => {
      let size = 0;
      const result = await chat({ ...config, timeout: Math.max(config.timeout, 600_000), runtime: undefined, messages: remember(list),
        thinking: generator?.noThinking ? false : config.thinking, signal: active.signal,
        onText: text => { size += text.length; spin.update(`${gen.label} yazılıyor · ${(size / 1024).toFixed(1)} KB`); },
        onReasoning: () => spin.update(`${gen.label} için düşünüyor`) });
      return { text: result.text, finishReason: result.finishReason };
    };
    try {
      const result = await generate(kind, { topic, attachments: used, ask: askModel, cwd: currentDir,
        failureFile: path.join(path.dirname(settingsFile), 'son-uretim-hatasi.txt'),
        onRepair: () => spin.update('Biçim düzeltiliyor') });
      spin.stop();
      // /ac opens the main file (for a project, its index.html), not the folder or the zip.
      lastFiles = [result.file, ...result.files.filter(file => file !== result.file)];
      console.log(box([
        t.white(clean(result.title)),
        '',
        ...result.files.map(file => `${t.red('▸')} ${fileLink(file)}`),
        ...(result.details.length ? ['', ...result.details.slice(0, 14).map(line => t.dim(clean(line)))] : []),
      ], `✓ ${gen.label} hazır`));
      note(`süre ${((Date.now() - start) / 1000).toFixed(1)} sn · açmak için /ac`);
      messages.push({ role: 'user', content: buildUserContent(`/${kind} ${topic}`, used) }, { role: 'assistant', content: result.note });
      return result;
    } catch (error) {
      spin.stop();
      if (error.name !== 'AbortError') attachments = used;
      throw error;
    } finally { active = undefined; }
  }

  async function runCouncil(topic) {
    if (!topic.trim()) throw new UserError('Konu yaz. Örnek: /konsey Yerli bir sosyal medya uygulaması nasıl büyür?');
    const experts = [
      { name: 'Yazılımcı', focus: 'teknik uygulanabilirlik, mimari, maliyet ve riskler' },
      { name: 'Tasarımcı', focus: 'kullanıcı deneyimi, erişilebilirlik ve görsel kimlik' },
      { name: 'Pazarlamacı', focus: 'hedef kitle, konumlandırma, büyüme ve gelir' },
    ];
    const transcript = [];
    active = new AbortController();
    const start = Date.now();
    const speak = async (title, systemText, userText) => {
      view = createView(title);
      try {
        const result = await chat({ ...config, runtime: undefined, signal: active.signal,
          messages: remember([{ role: 'system', content: systemText }, { role: 'user', content: userText }]),
          onText: view.text, onReasoning: view.reasoning });
        view.finish();
        return result.text;
      } finally { if (view?.thought) lastThought = view.thought; view = undefined; }
    };
    try {
      console.log(`\n${rule('Uzmanlar Konseyi')}\n  ${t.dim(`Konu: ${clean(topic)}`)}`);
      for (const expert of experts) {
        const said = transcript.map(item => `${item.name}: ${item.text}`).join('\n\n');
        const text = await speak(expert.name,
          `Bir uzmanlar konseyinde ${expert.name} olarak konuşuyorsun. Odağın: ${expert.focus}. Türkçe, en fazla 120 kelime, somut ve maddeli yaz. Önceki konuşmacılara katıl veya itiraz et; onları tekrar etme. Bugünün tarihi: ${todayText}.`,
          `Konu: ${topic}\n\n${said ? `Şimdiye kadar söylenenler:\n${said}` : 'İlk sen konuşuyorsun.'}`);
        transcript.push({ name: expert.name, text });
      }
      const summary = await speak('Moderatör',
        `Uzmanlar konseyinin moderatörüsün. Tartışmayı Türkçe özetle: ortak noktalar, ayrışmalar, net tavsiye ve ilk 3 adım. Başlık ve maddeler kullan; en fazla 250 kelime yaz, geniş tablo kullanma. Bugünün tarihi: ${todayText}.`,
        `Konu: ${topic}\n\n${transcript.map(item => `${item.name}: ${item.text}`).join('\n\n')}`);
      footer(start);
      messages.push({ role: 'user', content: `/konsey ${topic}` },
        { role: 'assistant', content: `${transcript.map(item => `**${item.name}:** ${item.text}`).join('\n\n')}\n\n**Moderatör özeti:**\n${summary}` });
    } finally { active = undefined; }
  }

  // Returns text to send as a chat message, or undefined when the command is complete.
  async function runCommand(input) {
    const split = input.indexOf(' ');
    // Trailing punctuation typed by habit ("/cikis," or "/yardim?") is not part of the command name.
    const typed = (split < 0 ? input : input.slice(0, split)).toLowerCase().replace(/(?<=.)[.,;:!?]+$/, '');
    const arg = split < 0 ? '' : input.slice(split + 1).trim();
    if (typed === '/') { help(); return; }
    if (SITE_ONLY[typed]) {
      console.log(box([
        `${t.white(typed)} Umay sitesinde sunucu tarafında çalışır (${SITE_ONLY[typed]}).`,
        'API anahtarı yalnızca sohbet uç noktasına erişir; bu komut CLI\'de yok.',
        '', t.dim('Benzer işler: /dokuman ile rapor, /konsey ile çok yönlü analiz,'),
        t.dim('/ekle ile kendi verini veya metnini ekleyip özetlet.'),
      ], 'Bu komut sitede'));
      return;
    }
    const command = LOOKUP.get(typed);
    if (!command) {
      const guess = COMMANDS.find(item => item.name.startsWith(typed.slice(0, 3)));
      throw new UserError(`Bilinmeyen komut: ${typed}.${guess ? ` ${guess.name} mi demek istedin?` : ''} Komutlar için / yazıp Enter'a bas.`);
    }
    switch (command.name) {
      case '/yardim': help(); return;
      case '/cikis': return { exit: true };
      case '/bellek': {
        const space = arg.indexOf(' ');
        const action = (space < 0 ? arg : arg.slice(0, space)).toLocaleLowerCase('tr');
        const rest = space < 0 ? '' : arg.slice(space + 1).trim();
        if (action === 'ekle') {
          if (!rest) throw new UserError('Kullanım: /bellek ekle Python projelerimde tip ipuçları kullanırım');
          ok(await memory.add(rest) ? `Not eklendi (${memory.items.length}).` : 'Bu not zaten var.');
          if (!config.memory) note('Bellek kapalı; notların gönderilmesi için /bellek ac');
          return;
        }
        if (action === 'sil') {
          const removed = await memory.remove(rest);
          ok(`Silindi: ${clean(removed)}`); return;
        }
        if (action === 'temizle') {
          if (!memory.items.length) { note('Bellek zaten boş.'); return; }
          const answer = (await ask(rl, `  ${t.yellow('?')} ${memory.items.length} notun hepsi silinsin mi? ${t.dim('[e/h]')} ${t.red('❯')} `) ?? '').trim().toLocaleLowerCase('tr');
          if (!['e', 'evet'].includes(answer)) { note('Vazgeçildi.'); return; }
          await memory.clear(); ok('Bellek temizlendi.'); return;
        }
        if (ON.includes(action) || OFF.includes(action)) {
          config.memory = ON.includes(action);
          await saveSettings(config);
          ok(`Bellek ${config.memory ? 'açık: notlar her istekte Umay\'a gönderilir' : 'kapalı: notlar saklanır ama gönderilmez'}.`);
          return;
        }
        if (action) throw new UserError('Kullanım: /bellek, /bellek ekle <not>, /bellek sil <no>, /bellek temizle, /bellek ac|kapat');
        console.log(`  ${t.white('Bellek:')} ${config.memory ? t.green('açık') : 'kapalı'} ${t.dim(`· ${memory.file}`)}`);
        if (!memory.items.length) note('Henüz not yok. Örnek: /bellek ekle Adım Eray, dilekçelerde bu adı kullan');
        memory.items.forEach((item, i) => console.log(`  ${t.red(`${i + 1}.`)} ${clean(item)}`));
        if (memory.items.length) note('Notlar her istekte Umay API\'ye gönderilir; dosyayı elle de düzenleyebilirsin.');
        return;
      }
      case '/yeni':
        messages = [{ role: 'system', content: system }]; attachments = [];
        ok('Yeni sohbet başladı.'); return;
      case '/gecmis': {
        const shown = messages.filter(message => message.role !== 'system');
        if (!shown.length) { note('Henüz mesaj yok.'); return; }
        for (const message of shown) {
          let text = typeof message.content === 'string' ? message.content
            : message.content.map(part => part.type === 'text' ? part.text : ['image', 'file'].includes(part.type) ? '[görsel]'
              : part.type === 'tool-call' ? `[araç: ${part.toolName}]` : part.type === 'tool-result' ? `[${part.toolName} sonucu]` : `[${part.type}]`).join(' ');
          // Text-protocol tool traffic is shown as short markers, not raw blocks.
          const toolResults = [...text.matchAll(/<tool_result name="([^"]+)">/g)].map(match => match[1]);
          if (message.role === 'tool' || toolResults.length) {
            console.log(`  ${t.dim(`  › ${toolResults.length ? toolResults.join(', ') + ' sonucu' : 'araç sonucu'}`)}`);
            continue;
          }
          text = text.replace(/<tool_call>\s*\{"name":\s*"([^"]+)"[\s\S]*?<\/tool_call>/g, '[araç: $1]').trim();
          const who = message.role === 'user' ? t.redBold('sen') : t.white('umay');
          console.log(`\n  ${who} ${t.red('❯')} ${clean(text).slice(0, 2000)}`);
        }
        return;
      }
      case '/kaydet': {
        const destination = path.resolve(currentDir, arg || path.join(root, 'sohbetler', `umay-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
        await mkdir(path.dirname(destination), { recursive: true });
        const data = { version: 2, savedAt: new Date().toISOString(), model: config.model, messages };
        await writeFile(destination, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        ok(`Kaydedildi: ${fileLink(destination)}`); return;
      }
      case '/yukle': {
        if (!arg) throw new UserError('Kullanım: /yukle dosya.json');
        const data = JSON.parse(await readFile(path.resolve(currentDir, arg), 'utf8'));
        if (![1, 2].includes(data.version) || !Array.isArray(data.messages) || !data.messages.length ||
          !data.messages.every(m => ['system', 'user', 'assistant', 'tool'].includes(m?.role) &&
            (typeof m.content === 'string' || Array.isArray(m.content)))) {
          throw new UserError('Geçerli bir Umay sohbet dosyası değil.');
        }
        // The saved system message carries the day it was written; the model must see today's date.
        messages = data.messages.map(({ role, content }) => ({ role, content: role === 'system' && typeof content === 'string'
          ? content.replace(/Bugünün tarihi: [^.\n]*\./, `Bugünün tarihi: ${todayText}.`) : content }));
        ok(`${messages.filter(m => m.role === 'user').length} mesajlık sohbet yüklendi. Sonraki mesajınla devam eder.`); return;
      }
      case '/cok-satir': {
        note('Mesajını yaz. /gonder gönderir, /iptal vazgeçer.');
        const lines = [];
        let line;
        while ((line = await ask(rl, t.dim('    │ '))) !== null && !['/gonder', '/gönder', '/send', '/iptal', '/cancel'].includes(line.trim())) lines.push(line);
        if (!['/gonder', '/gönder', '/send'].includes(line?.trim()) || !lines.join('\n').trim()) { note('Vazgeçildi.'); return; }
        return { send: lines.join('\n') };
      }
      case '/model':
        if (arg) { config.model = resolveModel(arg); await saveSettings(config); }
        console.log(`  ${t.white('Model:')} ${t.redBold(modelName(config.model))} ${t.dim(`(${config.model})`)}`);
        if (!arg) note('Seçenekler: /akilli (Umay Akıllı, güçlü) · /hizli (Umay Hızlı, çabuk) · /model ultra (Umay Ultra Hızlı) · /model zeki (Umay Daha Zeki)');
        return;
      case '/akilli': case '/hizli':
        config.model = command.name === '/akilli' ? 'umay-akilli' : 'umay-hizli';
        await saveSettings(config);
        ok(`Model: ${t.redBold(modelName(config.model))}`); return;
      case '/dusunme':
      {
        if (!arg) {
          console.log(`  ${t.white('Düşünme:')} ${t.redBold(thinkingName(config.thinking))}`);
          note('/dusunme ac: en iyi sonuç, biraz yavaş · /dusunme otomatik: Umay karar verir · /dusunme kapat: hızlı ama zayıf');
          return;
        }
        const next = parseThinking(arg);
        if (next === undefined) throw new UserError('Kullanım: /dusunme ac | kapat | otomatik');
        config.thinking = next;
        await saveSettings(config);
        ok(`Düşünme: ${t.white(thinkingName(config.thinking))}.`);
        if (next === true) note('Model yanıttan önce düşünür; düşünce tek satırda özetlenir, tamamı için /dusunce.');
        if (next === false) note('Düşünme kapalıyken yanıtlar daha hızlı ama zor görevlerde belirgin şekilde daha zayıf.');
        return;
      }
      case '/akis':
        config.stream = toggle(arg, config.stream, '/akis');
        await saveSettings(config);
        ok(`Canlı akış ${config.stream ? 'açık' : 'kapalı'}.`); return;
      case '/anahtar': {
        // Checked before the prompt is closed: a failure after that would end the whole session.
        if (!process.stdin.isTTY) throw new UserError('Anahtar yalnızca etkileşimli terminalde girilebilir; UMAY_API_KEY ortam değişkenini kullan.');
        rl.close();
        let key;
        try { key = await readKey(); } finally { rl = makeInterface(); }
        if (key) config.apiKey = key;
        ok(key ? 'Anahtar güncellendi.' : 'Anahtar değiştirilmedi.'); return;
      }
      case '/ekle': {
        if (!arg) throw new UserError('Kullanım: /ekle dosya.txt (metin, kod, .docx, .xlsx, .pptx)');
        const item = await loadAttachment(arg, currentDir);
        attachments.push(item);
        ok(`Eklendi: ${t.white(item.name)} ${t.dim(item.kind === 'image' ? '(görsel)' : `(${item.text.length.toLocaleString('tr-TR')} karakter${item.truncated ? ', kısaltıldı' : ''})`)}`);
        note(item.kind === 'image'
          ? 'Görsel sonraki mesajla gönderilecek (UMAY_IMAGES=1 ile açılan deneysel destek).'
          : 'Sonraki mesajınla veya /sunum, /rapor gibi bir komutla gönderilecek.');
        return;
      }
      case '/ekler':
        if (arg && ['temizle', 'sil', 'clear'].includes(arg.toLocaleLowerCase('tr'))) { attachments = []; ok('Ekler kaldırıldı.'); return; }
        if (!attachments.length) { note('Bekleyen ek yok. Eklemek için: /ekle dosya'); return; }
        attachments.forEach((item, i) => console.log(`  ${t.red(`${i + 1}.`)} ${t.white(item.name)} ${t.dim(item.kind === 'image' ? 'görsel' : 'metin')}`));
        return;
      case '/github': {
        if (!arg) throw new UserError('Kullanım: /github https://github.com/kullanici/depo');
        active = new AbortController();
        const spin = spinner('GitHub deposu indiriliyor');
        try {
          const result = await importGitHub(arg, currentDir, { signal: active.signal });
          spin.stop();
          currentDir = result.dir;
          if (runtime) await runtime.changeDirectory(result.dir);
          attachments.push(result.attachment);
          console.log(box([
            `${t.white(result.name)} ${t.dim(result.reused ? '(daha önce indirilmiş)' : '')}`,
            `${t.red('▸')} ${fileLink(result.dir)}`,
            t.dim(`${result.files} dosya · çalışma klasörü bu depoya geçti`),
            '', t.text('Şimdi sor: "Bu proje ne yapıyor?" veya "Hataları bul"'),
          ], '✓ Depo içe aktarıldı'));
        } finally { spin.stop(); active = undefined; }
        return;
      }
      case '/cd':
        if (arg) {
          const target = path.resolve(currentDir, arg);
          if (runtime) currentDir = await runtime.changeDirectory(target);
          else if (isDirectory(target)) currentDir = target;
          else throw new UserError(`Klasör bulunamadı: ${target}`);
        }
        console.log(`  ${t.white('Klasör:')} ${fileLink(currentDir)}`); return;
      case '/araclar':
        if (['text', 'native'].includes(arg)) config.toolMode = arg;
        else if (arg) toolsOn = toggle(arg, toolsOn, '/araclar');
        // If the bridge cannot start, the tools are off; saying "on" would send chats without them silently.
        if (toolsOn) { try { await ensureRuntime(); } catch (error) { toolsOn = false; throw error; } }
        console.log(`  ${t.white('Araçlar:')} ${toolsOn ? t.green('açık') : 'kapalı'}${toolsOn ? t.dim(` · ${runtime.metadata.tools.map(tool => tool.name).join(', ')}`) : ''}`);
        return;
      case '/oto':
        await ensureRuntime();
        runtime.auto = toggle(arg, runtime.auto, '/oto');
        if (!runtime.auto) runtime.always.clear();
        ok(runtime.auto ? 'Otomatik onay açık: yazma ve komutlar sormadan çalışır.' : 'Otomatik onay kapalı: yazma ve komutlar onay ister.');
        return;
      case '/geri-al':
        await ensureRuntime();
        note(clean(await runtime.undo())); return;
      case '/konsey':
        await runCouncil(arg); return;
      case '/dusunce': {
        if (!lastThought.trim()) { note('Son yanıtta düşünce yok. Düşünme modunu açmak için: /dusunme ac'); return; }
        console.log(`
${rule('Son düşünce')}`);
        const md = markdownStream(text => process.stdout.write(text));
        md.push(clean(lastThought.trim())); md.end();
        return;
      }
      case '/ac':
        if (!lastFiles.length) throw new UserError('Henüz üretilmiş dosya yok.');
        openFile(lastFiles[0]); ok(`Açılıyor: ${fileLink(lastFiles[0])}`); return;
      default:
        if (command.kind) { await runGenerator(command.kind, arg); return; }
    }
  }

  // ----- One question mode -----
  // UMAY_INTERACTIVE=1 keeps the command loop with piped input, for scripted checks.
  const oneShot = values.prompt !== undefined || (!process.stdin.isTTY && process.env.UMAY_INTERACTIVE !== '1');
  if (oneShot) {
    if (!config.apiKey && values.prompt !== undefined && process.stdin.isTTY) config.apiKey = await readKey();
    if (!config.apiKey) throw new Error('Tek soru veya boru girişi için UMAY_API_KEY ortam değişkenini ayarla.');
    let prompt = values.prompt;
    if (prompt === undefined) {
      process.stdin.setEncoding('utf8');
      prompt = '';
      for await (const chunk of process.stdin) prompt += chunk;
    }
    if (!prompt.trim()) throw new Error('Mesaj boş olamaz.');
    const abort = new AbortController();
    const cancel = () => { abort.abort(); active?.abort(); };
    process.on('SIGINT', cancel);
    try {
      // Looked up like a typed command, so /şema, /excel and /belge work here as they do in the chat.
      const typed = /^\/\S+/.exec(prompt.trim())?.[0];
      const kind = typed && LOOKUP.get(typed.toLowerCase())?.kind;
      if (kind) {
        const result = await runGenerator(kind, prompt.trim().slice(typed.length).trim());
        if (!process.stdout.isTTY) console.log(result.files.join('\n'));
        return;
      }
      view = createView(null);
      const result = await chat({ ...config, runtime: toolsOn ? runtime : undefined,
        messages: remember([...messages, { role: 'user', content: prompt }]), signal: abort.signal,
        onText: view.text, onReasoning: view.reasoning });
      view.finish();
      if (result.stepLimit) { showError('Ajan adım sınırına ulaştı. Yapılan işlemler korunuyor; devam etmek için sınırı artır.'); process.exitCode = 1; }
    } catch (error) {
      view?.finish();
      showError(error instanceof UserError ? error.message : friendlyError(error, config.apiKey));
      process.exitCode = 1;
    } finally { process.off('SIGINT', cancel); view = undefined; }
    return;
  }

  // ----- Interactive mode -----
  console.log(banner());
  const chip = (label, value, on = true) => on ? t.softBadge(`${label} ${value}`) : t.dim(` ${label} ${value} `);
  console.log(`  ${chip('◆', modelName(config.model))} ${chip('düşünme', thinkingName(config.thinking), config.thinking === true)} ${chip('araçlar', toolsOn ? 'açık' : 'kapalı', toolsOn)}${memory.items.length ? ` ${chip('bellek', config.memory ? `${memory.items.length} not` : 'kapalı', config.memory)}` : ''}  ${t.dim(currentDir)}`);
  console.log(`  ${t.dim('İpucu:')} ${t.white('/')} ${t.dim('yaz + Tab → komutlar  ·  /sunum /dokuman /rapor /sema /proje /konsey  ·  /yardim')}\n`);
  if (!config.apiKey) {
    note('Anahtar: umayzeka.com → Geliştirici & API Paneli → Yeni Anahtar Oluştur');
    config.apiKey = await readKey();
  }
  if (!config.apiKey) throw new Error('API anahtarı girilmedi.');
  console.log(`\n  ${t.white('Bugün senin için ne yapabilirim?')}`);

  function makeInterface() {
    const created = createInterface({ input: process.stdin, output: process.stdout, historySize: 200, completer });
    created.on('SIGINT', () => active ? active.abort() : created.close());
    created.queued = [];
    created.on('line', line => created.queued.push(line));
    return created;
  }
  rl = makeInterface();
  try {
    while (!rl.closed || rl.queued?.length) {
      console.log();
      let input = await ask(rl, `  ${t.redBold('sen')}${attachments.length ? t.dim(` +${attachments.length} ek`) : ''} ${t.red('❯')} `);
      if (input === null) break;
      input = input.trim();
      if (!input) continue;
      if (input.startsWith('/')) {
        try {
          const result = await runCommand(input);
          if (result?.exit) break;
          if (result?.send === undefined) continue;
          input = result.send;
        } catch (error) {
          if (error.code === 'EEXIST') showError('Bu dosya zaten var. Başka bir dosya adı seç.');
          else if (error instanceof UserError || error instanceof SyntaxError || error.code === 'ENOENT') showError(error.message);
          else if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.statusCode) showError(friendlyError(error, config.apiKey));
          else showError(error.message || friendlyError(error, config.apiKey));
          continue;
        }
      }
      await sendChat(input);
    }
  } finally { rl.close(); }
  console.log(`\n  ${t.red('☾★')} ${t.dim('Görüşürüz.')}\n`);
}

main().catch(error => { showError(error.message); process.exitCode = 1; }).finally(async () => { await runtime?.close(); });
