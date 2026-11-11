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
import { chat, friendlyError, verifyKey, listModels, probeModel, validateBaseURL, DEFAULT_BASE_URL, DEFAULT_MODEL } from './client.mjs';
import { loadKey, saveKey, deleteKey, storeName } from './keystore.mjs';
import { ToolRuntime } from './tools.mjs';
import { t, color, fancy, clean, banner, welcome, box, rule, spinner, fileLink, width, visible, formatStats } from './theme.mjs';
import { createFrame } from './prompt.mjs';
import { markdownStream } from './markdown.mjs';
import { loadAttachment, buildUserContent, importGitHub, UserError } from './attachments.mjs';
import { GENERATORS, generate } from './documents.mjs';
import { Memory } from './memory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const VERSION = (() => { try { return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return ''; } })();
// Models: the menu, /model and /durum follow Umay's GET /v1/models, so models the server adds or drops show
// up without a new release. The list is kept in modeller.json beside the settings for the next start.
const MODEL_NAMES = {
  'umay-akilli': 'Umay Akıllı', 'umay-hizli': 'Umay Hızlı', 'umay-ultra-hizli': 'Umay Ultra Hızlı', 'umay-daha-zeki': 'Umay Daha Zeki',
  'umay-mistral-large': 'Mistral Large 4', 'umay-deepseek-flash': 'DeepSeek v4.1 Flash', 'umay-minimax-flash': 'MiniMax M3.1 Flash', 'umay-glm-flash': 'GLM 5.3 Flash',
};
const SHORT_NAMES = { 'umay-akilli': 'akilli', 'umay-hizli': 'hizli', 'umay-ultra-hizli': 'ultra', 'umay-daha-zeki': 'zeki' };
const FALLBACK_MODELS = ['umay-akilli', 'umay-hizli', 'umay-ultra-hizli', 'umay-daha-zeki'].map(id => ({ id, owner: 'umay' }));
let serverModels = null;
const modelName = id => MODEL_NAMES[id] ?? id;
const shortName = id => SHORT_NAMES[id] ?? id.replace(/^umay-/, '');
// The menu shows Umay's own names; the providers' names in the list (mistralai/...) lead to the same models.
const menuModels = () => {
  const own = (serverModels ?? FALLBACK_MODELS).filter(item => item.owner === 'umay').map(item => item.id);
  return own.length ? own : (serverModels ?? FALLBACK_MODELS).map(item => item.id);
};
const knownModel = id => (serverModels ?? FALLBACK_MODELS).some(item => item.id === id);
// Tool names as shown in color; the plain output keeps the real names.
const TOOL_LABELS = { read_file: 'Oku', list_dir: 'Listele', search_files: 'Ara', write_file: 'Yaz', edit_file: 'Düzenle', run_command: 'Çalıştır', run_python: 'Python' };
const toolLabel = name => TOOL_LABELS[name] ?? name;
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
  // "mistral" → umay-mistral-large, "glm-flash" → umay-glm-flash; a full id from the list is kept as it is.
  if (knownModel(value.trim())) return value.trim();
  const own = menuModels();
  return own.find(id => id === `umay-${name}`) ?? own.find(id => id.startsWith(`umay-${name}`)) ?? value.trim();
}

const modelsFile = () => path.join(path.dirname(settingsFile), 'modeller.json');
function loadModelCache() {
  try {
    const list = JSON.parse(readFileSync(modelsFile(), 'utf8'));
    if (Array.isArray(list) && list.every(item => typeof item?.id === 'string')) serverModels = list;
  } catch { /* no list yet */ }
}
// Fetches the list in the background; the cache is rewritten only when the list changed.
async function refreshModels(config) {
  const list = await listModels({ apiKey: config.apiKey, baseURL: config.baseURL });
  if (!list) return false;
  const changed = JSON.stringify(list) !== JSON.stringify(serverModels);
  serverModels = list;
  if (changed) {
    try { await mkdir(path.dirname(modelsFile()), { recursive: true }); await writeFile(modelsFile(), `${JSON.stringify(list, null, 2)}\n`); }
    catch { /* a convenience only */ }
  }
  return true;
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

// A folder for a narrow place: the home folder becomes ~, and a long path keeps its last folders.
function shortPath(dir, max = 40) {
  const home = os.homedir();
  const text = dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
  if (text.length <= max) return text;
  const parts = text.split(path.sep);
  let tail = parts.pop();
  while (parts.length > 1 && tail.length + parts.at(-1).length + 3 <= max) tail = `${parts.pop()}${path.sep}${tail}`;
  return tail.length + 2 <= max ? `…${path.sep}${tail}` : `…${tail.slice(-(max - 1))}`;
}

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
  { group: 'Model', name: '/model', aliases: ['/models', '/modeller'], args: '[ad]', desc: 'Modelleri listele veya değiştir (Umay\'ın güncel listesi)' },
  { group: 'Model', name: '/durum', aliases: ['/saglik', '/sağlık', '/status'], desc: 'Her modele kısa bir soru sor, hangisi çalışıyor gör' },
  { group: 'Model', name: '/akilli', aliases: ['/akıllı'], desc: 'Umay Akıllı: daha güçlü yanıtlar' },
  { group: 'Model', name: '/hizli', aliases: ['/hızlı'], desc: 'Umay Hızlı: daha çabuk yanıtlar' },
  { group: 'Model', name: '/dusunme', aliases: ['/düşünme', '/think'], args: '[ac|kapat|otomatik]', desc: 'Düşünme: açık, kapalı ya da Umay karar versin' },
  { group: 'Model', name: '/dusunce', aliases: ['/düşünce'], desc: 'Son yanıtın düşüncelerini tam göster' },
  { group: 'Model', name: '/akis', aliases: ['/stream', '/akış'], args: '[ac|kapat]', desc: 'Yanıtı canlı yazdır' },
  { group: 'Model', name: '/anahtar', aliases: ['/key'], args: '[sil|durum]', desc: 'API anahtarını değiştir; bu bilgisayarda şifreli saklanır' },
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
    ...(fancy ? [`    ${t.white('/')}                         Yazdıkça eşleşen komutlar listelenir; ↑↓ seçer, Esc kapatır`] : []),
    `    ${t.white('Tab')}                       Komutu veya dosya yolunu tamamla`,
    `    ${t.white('/')} + Enter                 Tüm komutları göster`,
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
    Anahtar ilk açılışta bir kez sorulur ve bu bilgisayarda saklanır (${storeName()}); UMAY_API_KEY varsa o kullanılır.
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
  if (command === '/model') return pick(menuModels().map(shortName));
  if (command === '/dusunme') return pick(['ac', 'kapat', 'otomatik']);
  if (['/akis', '/oto'].includes(command)) return pick(['ac', 'kapat']);
  if (command === '/araclar') return pick(['ac', 'kapat', 'text', 'native']);
  if (command === '/ekler') return pick(['temizle']);
  if (command === '/anahtar') return pick(['sil', 'durum']);
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
    // `asking` tells the framed prompt's output that this question's echo belongs on screen.
    rl.asking = (rl.asking ?? 0) + 1;
    const done = value => { rl.asking--; rl.off('close', close); signal?.removeEventListener('abort', close); resolve(value); };
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

// What an approval box shows: a diff with line numbers and tinted rows for file changes, the command or code
// for the rest.
function previewLines(name, preview) {
  // Trailing blank lines of a diff would only add empty rows to the box.
  const lines = clean(preview).replace(/\s+$/, '').replace(/\t/g, '    ').split('\n');
  const more = lines.length > 40 ? [t.dim(`… ${lines.length - 40} satır daha`)] : [];
  if (!color) return [...lines.slice(0, 40), ...more];
  if (name === 'run_command') return [...lines.slice(0, 40).map((line, i) => `${t.red(i ? ' ' : '$')} ${t.text(line)}`), ...more];
  if (name === 'run_python') return [...lines.slice(0, 40).map((line, i) => `${t.faint(String(i + 1).padStart(3))}  ${t.text(line)}`), ...more];
  const room = width() - 6;
  let before = 1;
  let after = 1;
  let named = false;    // the "+++ file" line was seen; every later line is content, whatever it starts with
  let hunks = 0;
  const rows = [];
  for (const line of lines.slice(0, 40)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      if (hunks++) rows.push({ text: t.faint('    ⋯') });
      before = Number(hunk[1]); after = Number(hunk[2]);
    } else if (!named && line.startsWith('--- ')) { /* the file is named by the +++ line */ }
    else if (!named && line.startsWith('+++ ')) { named = true; rows.push({ text: t.white(line.slice(4).replace(/^b\//, '')) }); }
    else if (!named) rows.push({ text: line.startsWith('#') ? t.yellow(line) : t.text(line) });
    else if (line.startsWith('+')) rows.push({ sign: '+', number: after++, body: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ sign: '-', number: before++, body: line.slice(1) });
    else { rows.push({ sign: ' ', number: after++, body: line.slice(1) }); before++; }
  }
  // Tinted rows share one width so the color forms a block.
  const size = Math.min(room, Math.max(...rows.map(row => row.text ? visible(row.text) : row.body.length + 7)));
  return [...rows.map(row => {
    if (row.text) return row.text;
    const text = `${String(row.number).padStart(4)} ${row.sign} ${row.body}`;
    const cut = (text.length > size ? text.slice(0, size - 1) + '…' : text).padEnd(size);
    return row.sign === '+' ? t.added(cut) : row.sign === '-' ? t.removed(cut) : `${t.faint(cut.slice(0, 5))}${t.text(cut.slice(5))}`;
  }), ...more];
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
  // Reading the stored key starts PowerShell on Windows (~0.4 s); it runs while the rest starts up.
  const storedKey = process.env.UMAY_API_KEY?.trim() ? Promise.resolve(null) : loadKey();
  const saved = loadSettings();
  loadModelCache();
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
    // Where the key came from: env (UMAY_API_KEY or .env), stored (saved on this computer) or typed.
    keySource: process.env.UMAY_API_KEY?.trim() ? 'env' : undefined,
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

  async function useStoredKey() {
    if (config.apiKey) return;
    const key = await storedKey;
    if (key) { config.apiKey = key; config.keySource = 'stored'; }
  }

  // Asks for the key, checks it with the server and keeps it on this computer, so it is asked only once.
  // Returns false when nothing was entered or the server refused three keys in a row.
  async function enterKey() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = await readKey();
      if (!key) return false;
      const spin = color ? spinner('anahtar kontrol ediliyor', { hint: '' }) : null;
      let accepted;
      try { accepted = await verifyKey({ apiKey: key, baseURL: config.baseURL, model: config.model }); }
      finally { spin?.stop(); }
      if (accepted === false) {
        showError(`Umay bu anahtarı kabul etmedi (HTTP 401).${key.startsWith('umay-sk-') ? '' : ' Anahtar umay-sk- ile başlamalı.'} Panelden kopyalayıp tekrar yapıştır.`);
        continue;
      }
      config.apiKey = key; config.keySource = 'typed';
      try {
        await saveKey(key);
        config.keySource = 'stored';
        ok(`Anahtar ${accepted ? 'doğrulandı ve ' : ''}bu bilgisayara kaydedildi ${t.dim(`(${storeName()})`)}`);
        if (accepted === null) note('Sunucuya ulaşılamadı, anahtar denenemedi. Yanlışsa /anahtar ile değiştir.');
        note('Bir daha sorulmayacak. Silmek için /anahtar sil.');
      } catch (error) {
        showError(`Anahtar kaydedilemedi (${error.message}); bu oturumda kullanılacak.`);
      }
      return true;
    }
    return false;
  }

  // The model list needs no key. In a terminal it is asked for at once and arrives while the rest starts up;
  // a one-shot run asks only when it needs it, so a quick question does not wait for it to end.
  let modelsPromise;
  const modelsFetched = () => (modelsPromise ??= refreshModels(config));
  if (process.stdin.isTTY && values.prompt === undefined) modelsFetched();
  // A short name given before the list was known ("--model mistral") is settled once it arrives.
  async function settleModel() {
    if (knownModel(config.model)) return;
    await modelsFetched();
    config.model = resolveModel(config.model);
    if (serverModels && !knownModel(config.model)) warnUnknown(config.model);
  }
  const warnUnknown = id => console.error(`  ${t.yellow('!')} ${t.yellow(`"${clean(id)}" Umay'ın model listesinde yok; Umay bilinmeyen adları sessizce Umay Akıllı'ya yönlendiriyor. /model ile listeyi gör.`)}`);

  // /durum: asks every model on the list for one word and shows which ones answer properly.
  async function modelStatus(signal) {
    await modelsFetched();
    const ids = menuModels();
    const spin = color ? spinner(`modeller deneniyor · 0/${ids.length}`, { hint: 'Ctrl+C durdurur' }) : null;
    let done = 0;
    const results = [];
    try {
      // Umay takes at most three requests a second, so the questions leave 400 ms apart and run together.
      for (const id of ids) {
        results.push(probeModel({ apiKey: config.apiKey, baseURL: config.baseURL, model: id, signal })
          .then(result => { spin?.update(`modeller deneniyor · ${++done}/${ids.length}`); return result; }));
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      return await Promise.all(results);
    } finally { spin?.stop(); }
  }
  function showStatus(results) {
    const seconds = value => `${value.toFixed(1).replace('.', ',')} sn`;
    const width = Math.max(...results.map(result => modelName(result.model).length)) + 2;
    console.log(`\n  ${t.white('Model durumu')} ${t.dim(`· ${new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} · her modele düşünme kapalı tek kelimelik bir soru`)}`);
    const good = [];
    for (const result of results) {
      const answer = clean(result.reply ?? '').trim();
      const right = answer.toLocaleUpperCase('tr').includes('ANKARA');
      let icon, detail;
      if (result.error === 'timeout') { icon = t.red('✗'); detail = `${seconds(result.seconds)} içinde yanıt yok`; }
      else if (result.error === 'connection') { icon = t.red('✗'); detail = 'bağlantı kurulamadı veya koptu'; }
      else if (result.status === 401) { icon = t.red('✗'); detail = 'anahtar kabul edilmedi (/anahtar)'; }
      else if (result.error) { icon = t.red('✗'); detail = `sunucu hatası: ${clean(result.error).slice(0, 60)}`; }
      else if (!answer) { icon = t.red('✗'); detail = 'boş yanıt'; }
      else if (!right) { icon = t.red('✗'); detail = `beklenmeyen yanıt: "${answer.replace(/\s+/g, ' ').slice(0, 28)}…"`; }
      else if (result.seconds > 20) { icon = t.yellow('◐'); detail = 'çalışıyor ama yavaş'; good.push(result); }
      else { icon = t.green('✓'); detail = 'çalışıyor'; good.push(result); }
      if (result.routed && result.routed !== result.model && result.routed.startsWith('umay-')) detail += ` · yanıtı ${modelName(result.routed)} verdi`;
      const mark = result.model === config.model ? t.red('◆') : ' ';
      const time = result.error === 'timeout' || result.error === 'connection' ? '' : seconds(result.seconds);
      console.log(`  ${mark} ${icon} ${t.text(modelName(result.model).padEnd(width))}${t.dim(time.padStart(8))}  ${t.dim(detail)}`);
    }
    console.log();
    note(`${good.length}/${results.length} model düzgün yanıt verdi. ◆ seçili model.`);
    // The chosen model is on the list and failed: name the quickest one that works.
    const quickest = good.toSorted((a, b) => a.seconds - b.seconds)[0];
    if (results.some(result => result.model === config.model) && !good.some(result => result.model === config.model) && quickest) {
      console.log(`  ${t.yellow('!')} ${t.yellow(`Seçili model (${modelName(config.model)}) şu an düzgün yanıt vermiyor. Çalışan birine geç: /model ${shortName(quickest.model)}`)}`);
    }
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
    // In the framed prompt the model is on the status line, so Umay's own answer needs no header: a crescent in
    // the margin marks where each piece of text starts. Other speakers (the council) keep their header.
    const marked = fancy && title === 'Umay';
    // Marks sit in the margin of a marked answer; under a header they line up with the text.
    const pad = marked ? '' : '  ';
    if (process.stdout.isTTY && title) {
      console.log(marked ? '' : `\n  ${t.red('☾★')} ${t.white(title)} ${t.dim(`· ${modelName(config.model)}${config.thinking === null ? '' : ` · düşünme ${thinkingName(config.thinking)}`}`)}`);
    }
    let spin = interactive ? spinner(config.thinking === true ? 'düşünüyor' : 'yanıt bekleniyor') : null;
    let ended = true;
    let lead = marked;
    const md = markdownStream(text => {
      if (!text) return;
      // Every block the renderer starts begins with its two-space indent; the first one gets the mark instead.
      if (lead && text.startsWith('  ')) { text = `${t.red('☾')} ${text.slice(2)}`; lead = false; }
      process.stdout.write(text); ended = text.endsWith('\n');
    });
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
      const summary = `düşündü · ${((Date.now() - thinkStart) / 1000).toFixed(1)} sn · ${words} kelime · /dusunce`;
      console.log(color ? `${pad}${t.faint('✦')} ${t.italic(summary)}` : `  ┊ ${summary}`);
      state = 'wait';
    };
    const pause = () => { stop(); md.end(); closeThinking(); lead = marked; };
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
          console.error(color ? `${pad}${t.red('●')} ${t.white(toolLabel(event.name))}${t.dim(`(${argSummary(event.args)})`)}`
            : `  › ${event.name} ${argSummary(event.args)}`);
          if (interactive) spin = spinner('çalışıyor');
          return;
        }
        const bad = /^(Hata:|Kullanıcı|çıkış kodu: (?!0\b))/.test(event.result);
        const short = text => text.length > width() - 10 ? text.slice(0, width() - 11) + '…' : text;
        // The note about line numbers in a read_file result is for the model, and a path inside the working
        // folder reads better without the folder.
        const [head, ...rest] = clean(event.result).replace('; soldaki numaralar ve → işareti dosyaya ait değildir', '')
          .replaceAll(currentDir + path.sep, '').split('\n');
        if (!color) { console.error(`  ${bad ? '✗' : '✓'} ${short(head)}`); return; }
        console.error(`${pad}  ${t.faint('└')} ${bad ? t.red('✗') : t.green('✓')} ${bad ? t.red(short(head)) : t.dim(short(head))}`);
        // A command's exit code says little on its own; the first lines of its output follow.
        if (['run_command', 'run_python'].includes(event.name)) {
          const output = rest.filter(line => line.trim());
          for (const line of output.slice(0, 3)) console.error(`${pad}      ${t.faint(short(line))}`);
          if (output.length > 3) console.error(`${pad}      ${t.faint(`… ${output.length - 3} satır daha`)}`);
        }
        spin = spinner('düşünüyor');
      },
      // After an approval the tool is still running.
      resume() { if (interactive && !spin) spin = spinner('çalışıyor'); },
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
        console.error(box(previewLines(name, preview), `Onay gerekiyor · ${color ? toolLabel(name) : name}`));
        const terminal = rl ?? createInterface({ input: process.stdin, output: process.stderr });
        if (!rl) terminal.on('SIGINT', () => terminal.close());
        const choice = (key, label) => color ? `${t.softBadge(key)} ${t.dim(label)}` : `[${key}] ${label}`;
        try {
          const answer = (await ask(terminal, `  ${t.yellow('?')} ${t.white('Onaylıyor musun?')} ${[choice('e', 'evet'), choice('h', 'hayır'), choice('t', 'bu araç için hep evet')].join(color ? '  ' : ' · ')} ${t.red('❯')} `, signal, { fresh: true }) ?? '').trim().toLocaleLowerCase('tr');
          return ['e', 'evet', 'y', 'yes'].includes(answer) ? true : answer === 't' ? 'always' : false;
        } finally { if (!rl) terminal.close(); view?.resume(); }
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
      case '/model': {
        await modelsFetched();
        if (arg) {
          config.model = resolveModel(arg);
          await saveSettings(config);
          ok(`Model: ${t.redBold(modelName(config.model))} ${t.dim(`(${config.model})`)}`);
          if (serverModels && !knownModel(config.model)) warnUnknown(config.model);
          return;
        }
        console.log(`  ${t.white('Model:')} ${t.redBold(modelName(config.model))} ${t.dim(`(${config.model})`)}\n`);
        const ids = menuModels();
        const size = Math.max(...ids.map(id => shortName(id).length)) + 3;
        for (const id of ids) console.log(`  ${id === config.model ? t.red('◆') : ' '} ${t.white(shortName(id).padEnd(size))}${t.text(modelName(id))}`);
        console.log();
        note(`${serverModels ? 'Liste Umay\'dan alındı.' : 'Umay\'ın listesi alınamadı; bilinen modeller gösteriliyor.'} Değiştirmek için /model <ad>, hangisi çalışıyor görmek için /durum.`);
        return;
      }
      case '/durum': {
        active = new AbortController();
        try { showStatus(await modelStatus(active.signal)); }
        finally { active = undefined; }
        return;
      }
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
        const sub = arg.toLocaleLowerCase('tr');
        const envNote = () => note('UMAY_API_KEY ortam değişkeni (veya .env) ayarlı olduğu sürece açılışta o kullanılır.');
        if (sub === 'sil') {
          const removed = await deleteKey();
          ok(removed ? 'Kayıtlı anahtar bu bilgisayardan silindi.' : 'Bu bilgisayarda kayıtlı anahtar yok.');
          if (config.keySource === 'stored') config.keySource = 'typed';
          if (config.keySource === 'env') envNote();
          else note('Bu oturum sürüyor; sonraki açılışta anahtar sorulur.');
          return;
        }
        if (sub === 'durum') {
          note(`Anahtar: ${{ env: 'UMAY_API_KEY ortam değişkeninden (veya .env dosyasından)', stored: `bu bilgisayarda kayıtlı, ${storeName()}`, typed: 'bu oturumda girildi, kayıtlı değil' }[config.keySource] ?? 'yok'}`);
          return;
        }
        if (sub) throw new UserError('Kullanım: /anahtar (değiştir), /anahtar sil, /anahtar durum');
        // Checked before the prompt is closed: a failure after that would end the whole session.
        if (!process.stdin.isTTY) throw new UserError('Anahtar yalnızca etkileşimli terminalde girilebilir; UMAY_API_KEY ortam değişkenini kullan.');
        const fromEnv = config.keySource === 'env';
        rl.close();
        let changed;
        try { changed = await enterKey(); } finally { rl = makeInterface(); }
        if (!changed) ok('Anahtar değiştirilmedi.');
        else if (fromEnv) envNote();
        return;
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
    await useStoredKey();
    if (!config.apiKey && values.prompt !== undefined && process.stdin.isTTY) await enterKey();
    if (!config.apiKey) throw new Error('Anahtar yok: umay ile bir kez anahtarını gir (bu bilgisayarda saklanır) veya UMAY_API_KEY ortam değişkenini ayarla.');
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
      if (typed && LOOKUP.get(typed.toLowerCase())?.name === '/durum') { showStatus(await modelStatus(abort.signal)); return; }
      await settleModel();
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
  const memoryText = memory.items.length ? (config.memory ? `${memory.items.length} not` : 'kapalı') : '';
  const tip = (keys, text) => `${t.white(keys)} ${t.dim(text)}`;
  const panel = fancy && welcome({
    version: VERSION,
    tips: [
      tip('/', 'yaz, komut menüsü açılır; ↑↓ ile seç'),
      tip('/sunum /dokuman /rapor', 'ile belge üret'),
      tip('/ekle', 'ile dosya ver, sonra sorunu yaz'),
    ],
    session: [
      `${t.red('◆')} ${t.text(modelName(config.model))} ${t.dim(`· düşünme ${thinkingName(config.thinking)}`)}`,
      t.dim(`araçlar ${toolsOn ? 'açık' : 'kapalı'}${memoryText ? ` · bellek ${memoryText}` : ''}`),
      t.dim(shortPath(currentDir, 44)),
    ],
  });
  if (panel) console.log(panel);
  else {
    console.log(banner());
    const chip = (label, value, on = true) => on ? t.softBadge(`${label} ${value}`) : t.dim(` ${label} ${value} `);
    console.log(`  ${chip('◆', modelName(config.model))} ${chip('düşünme', thinkingName(config.thinking), config.thinking === true)} ${chip('araçlar', toolsOn ? 'açık' : 'kapalı', toolsOn)}${memoryText ? ` ${chip('bellek', memoryText, config.memory)}` : ''}  ${t.dim(fancy ? shortPath(currentDir, 36) : currentDir)}`);
    console.log(`  ${t.dim('İpucu:')} ${t.white('/')} ${t.dim(fancy ? 'yaz → komut menüsü  ·  /sunum /dokuman /rapor /sema /proje /konsey  ·  /yardim' : 'yaz + Tab → komutlar  ·  /sunum /dokuman /rapor /sema /proje /konsey  ·  /yardim')}\n`);
  }
  await useStoredKey();
  if (!config.apiKey) {
    if (panel) console.log();
    note('Anahtarını bir kez gir; bu bilgisayarda saklanır ve bir daha sorulmaz.');
    note('Anahtar: umayzeka.com → Geliştirici & API Paneli → Yeni Anahtar Oluştur');
    await enterKey();
  }
  if (!config.apiKey) throw new Error('API anahtarı girilmedi.');
  await settleModel();
  if (!fancy) console.log(`\n  ${t.white('Bugün senin için ne yapabilirim?')}`);

  // The framed prompt: its status line, the gray text in the empty input and the entries of the live menu.
  let asked = 0;
  const frame = fancy ? createFrame({
    hint: () => asked > 1 ? 'Umay\'a yaz · / ile komutlar' : 'Bugün senin için ne yapabilirim?',
    status: columns => {
      const parts = [`${t.red('◆')} ${t.text(modelName(config.model))}`, t.dim(`düşünme ${thinkingName(config.thinking)}`), t.dim(`araçlar ${toolsOn ? 'açık' : 'kapalı'}`)];
      if (runtime?.auto) parts.push(t.yellow('oto onay açık'));
      if (attachments.length) parts.push(t.yellow(`+${attachments.length} ek`));
      const left = `  ${parts.join(t.faint(' · '))}`;
      const keys = t.faint('/ komutlar · Ctrl+C çıkış');
      // The folder and the key hints are dropped, in that order, when the line gets too narrow for them.
      const spread = (start, end) => {
        const gap = columns - 2 - visible(start) - visible(end);
        return gap >= 2 ? `${start}${' '.repeat(gap)}${end}` : null;
      };
      const room = columns - visible(left) - visible(keys) - 9;
      return [(room >= 12 && spread(`${left}${t.faint(` · ${shortPath(currentDir, room)}`)}`, keys)) || spread(left, keys) || left];
    },
    suggest: line => {
      const space = line.indexOf(' ');
      if (space < 0) {
        const typed = line.toLowerCase();
        const found = COMMANDS.filter(command => command.name.startsWith(typed));
        const more = COMMANDS.filter(command => !found.includes(command) &&
          (command.aliases.some(alias => alias.startsWith(typed)) || (typed.length > 2 && command.name.includes(typed.slice(1)))));
        return { command: true, exact: LOOKUP.has(typed), from: 0,
          items: [...found, ...more].map(command => ({ value: command.name, name: command.name, args: command.args, desc: command.desc })) };
      }
      const [hits, partial] = completer(line);
      const about = LOOKUP.get(line.slice(0, space).toLowerCase())?.name === '/model'
        ? name => modelName(resolveModel(name)) : () => '';
      return { from: line.length - partial.length,
        items: hits.length === 1 && hits[0] === partial ? [] : hits.map(hit => ({ value: hit, name: hit, desc: about(hit) })) };
    },
  }) : null;

  function makeInterface() {
    const created = frame
      ? createInterface({ input: frame.input, output: frame.output, terminal: true, historySize: 200 })
      : createInterface({ input: process.stdin, output: process.stdout, historySize: 200, completer });
    frame?.attach(created);
    created.on('SIGINT', () => active ? active.abort() : created.close());
    created.queued = [];
    created.on('line', line => created.queued.push(line));
    return created;
  }
  rl = makeInterface();
  try {
    let gap = true;
    while (!rl.closed || rl.queued?.length) {
      // An empty Enter redraws the prompt where it was instead of walking down the screen.
      if (gap || !frame) console.log();
      gap = true;
      asked++;
      let input = frame ? await frame.question()
        : await ask(rl, `  ${t.redBold('sen')}${attachments.length ? t.dim(` +${attachments.length} ek`) : ''} ${t.red('❯')} `);
      if (input === null) break;
      input = input.trim();
      if (!input) { gap = false; continue; }
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
