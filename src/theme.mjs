// Terminal look: Turkish flag red and white, with gray for secondary text.
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';

export const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
// The framed prompt, the live command menu and the welcome panel need a real terminal on both ends.
// UMAY_ARAYUZ=sade keeps the plain prompt.
export const fancy = color && Boolean(process.stdin.isTTY) && process.env.TERM !== 'dumb' && process.env.UMAY_ARAYUZ !== 'sade';
const rgb = (r, g, b) => `38;2;${r};${g};${b}`;
const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : String(text);
const mix = (from, to, k) => from.map((value, i) => Math.round(value + (to[i] - value) * Math.max(0, Math.min(1, k))));
const RED = [227, 10, 23];

export const t = {
  red: text => paint(rgb(227, 10, 23), text),
  redBold: text => paint(`1;${rgb(227, 10, 23)}`, text),
  darkRed: text => paint(rgb(165, 7, 16), text),
  white: text => paint('1;97', text),
  text: text => paint('97', text),
  dim: text => paint('90', text),
  italic: text => paint('3;90', text),
  green: text => paint('92', text),
  yellow: text => paint('93', text),
  code: text => paint(`97;48;2;48;48;56`, text),
  badge: text => paint(`1;97;48;2;227;10;23`, ` ${text} `),
  softBadge: text => paint(`97;48;2;60;20;24`, ` ${text} `),
  faint: text => paint(rgb(98, 98, 108), text),
  // A typed message in the transcript, and the two sides of a diff.
  user: text => paint('97;48;2;44;44;52', text),
  userMark: text => paint(`1;${rgb(255, 84, 94)};48;2;44;44;52`, text),
  added: text => paint(`${rgb(170, 240, 180)};48;2;18;52;30`, text),
  removed: text => paint(`${rgb(255, 170, 170)};48;2;66;20;26`, text),
};

// Colors a text along a list of RGB stops; `at` maps a character index to a position between 0 and 1.
function gradient(text, stops, at = i => i / Math.max(1, text.length - 1)) {
  if (!color) return text;
  let out = '';
  let last = '';
  [...text].forEach((char, i) => {
    if (char === ' ') { out += char; return; }
    const position = Math.max(0, Math.min(0.9999, at(i))) * (stops.length - 1);
    const code = rgb(...mix(stops[Math.floor(position)], stops[Math.floor(position) + 1], position % 1));
    if (code !== last) { out += `\x1b[${code}m`; last = code; }
    out += char;
  });
  return out + '\x1b[0m';
}

// Cuts a styled line to a visible width; escape sequences are kept whole and the styling is closed.
export function fit(text, size) {
  if (visible(text) <= size) return text;
  let out = '';
  let shown = 0;
  for (const part of text.split(/(\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x1b\x07]*(?:\x07|\x1b\\))/)) {
    if (part.startsWith('\x1b')) { out += part; continue; }
    const room = size - 1 - shown;
    if (part.length > room) { out += part.slice(0, Math.max(0, room)) + '…'; break; }
    out += part; shown += part.length;
  }
  return out + (color ? '\x1b[0m' : '');
}

// Server and file text is untrusted terminal content. Strip escapes before display.
export const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export const visible = text => stripVTControlCharacters(text).length;
export const width = () => Math.max(40, Math.min(process.stdout.columns || 100, 110));

// Clickable link in terminals that support OSC 8; plain text elsewhere.
export function fileLink(file) {
  if (!color) return file;
  return `\x1b]8;;${pathToFileURL(file).href}\x1b\\${t.white(file)}\x1b]8;;\x1b\\`;
}

const LOGO = [
  '██╗   ██╗███╗   ███╗ █████╗ ██╗   ██╗',
  '██║   ██║████╗ ████║██╔══██╗╚██╗ ██╔╝',
  '██║   ██║██╔████╔██║███████║ ╚████╔╝ ',
  '██║   ██║██║╚██╔╝██║██╔══██║  ╚██╔╝  ',
  '╚██████╔╝██║ ╚═╝ ██║██║  ██║   ██║   ',
  ' ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝   ',
];

// The logo runs from deep red on the left to a pale glow on the right, slanted a little from row to row.
const LOGO_STOPS = [[176, 6, 16], RED, [255, 62, 72], [255, 128, 122], [255, 214, 208]];
function logoLines() {
  const span = LOGO[0].length + LOGO.length * 2;
  return LOGO.map((line, row) => gradient(line, LOGO_STOPS, i => (i + row * 2) / span));
}

// Opening panel for wide terminals: logo and slogan on the left, first steps and the session on the right.
// Returns null when the terminal is too narrow; the caller then prints banner().
export function welcome({ version, tips = [], session = [] }) {
  const columns = Math.min(process.stdout.columns || 100, 118);
  const left = LOGO[0].length + 6;
  const right = columns - 4 - left - 3;
  if (!color || right < 40) return null;
  const leftRows = [
    '', ...logoLines(), '',
    `${t.white('☾★')}  ${t.badge('MİLLİ AI')}`,
    t.text('Türkiye\'nin bağımsız yapay zekası'),
    t.dim('kodlama · araştırma · belge üretimi'),
    '',
  ];
  const rightRows = [
    '', t.redBold('Başlarken'), ...tips,
    t.faint('─'.repeat(right - 2)),
    t.redBold('Oturum'), ...session, '',
  ];
  const height = Math.max(leftRows.length, rightRows.length);
  const edge = text => t.red(text);
  const cell = (text = '', size, center) => {
    const cut = fit(text, size);
    const gap = Math.max(0, size - visible(cut));
    const before = center ? Math.floor(gap / 2) : 0;
    return ' '.repeat(before) + cut + ' '.repeat(gap - before);
  };
  const title = ` ☾★ Umay CLI${version ? ` v${version}` : ''} `;
  const lines = [`  ${edge('╭─')}${t.white(title)}${edge(`${'─'.repeat(Math.max(0, left - 1 - title.length))}┬${'─'.repeat(right)}╮`)}`];
  for (let i = 0; i < height; i++) {
    lines.push(`  ${edge('│')}${cell(leftRows[i], left, true)}${edge('│')} ${cell(rightRows[i], right - 2)} ${edge('│')}`);
  }
  lines.push(`  ${edge(`╰${'─'.repeat(left)}┴${'─'.repeat(right)}╯`)}`);
  return `\n${lines.join('\n')}`;
}

export function banner() {
  const logo = logoLines();
  const side = [
    '',
    `${t.white('☾★')}  ${t.badge('MİLLİ AI')}`,
    '',
    t.text('Türkiye\'nin bağımsız yapay zekası'),
    t.dim('kodlama · araştırma · belge üretimi'),
    '',
  ];
  const wide = width() >= 80;
  const lines = logo.map((line, i) => `  ${line}${wide ? `   ${side[i]}` : ''}`);
  if (!wide) lines.push('', `  ${t.white('☾★')}  ${t.badge('MİLLİ AI')}  ${t.dim('Türkiye\'nin bağımsız yapay zekası')}`);
  return `\n${lines.join('\n')}\n`;
}

export function rule(label = '') {
  const size = Math.min(width() - 4, 72);
  if (!label) return `  ${t.darkRed('─'.repeat(size))}`;
  const text = ` ${label} `;
  return `  ${t.darkRed('──')}${t.white(text)}${t.darkRed('─'.repeat(Math.max(2, size - visible(text) - 2)))}`;
}

// A framed panel; lines may contain color codes.
export function box(lines, title = '') {
  const inner = Math.min(width() - 6, Math.max(30, ...lines.map(visible), visible(title) + 4));
  const top = title
    ? t.darkRed('╭─ ') + t.white(title) + t.darkRed(` ${'─'.repeat(Math.max(0, inner - visible(title) - 1))}╮`)
    : t.darkRed(`╭${'─'.repeat(inner + 2)}╮`);
  const body = lines.map(line => {
    const cut = visible(line) > inner ? truncateVisible(line, inner) : line;
    return `${t.darkRed('│')} ${cut}${' '.repeat(Math.max(0, inner - visible(cut)))} ${t.darkRed('│')}`;
  });
  return ['  ' + top, ...body.map(line => '  ' + line), '  ' + t.darkRed(`╰${'─'.repeat(inner + 2)}╯`)].join('\n');
}

function truncateVisible(text, size) {
  const plain = stripVTControlCharacters(text);
  return plain.slice(0, Math.max(0, size - 1)) + '…';
}

// One-line status for waits: a crescent with a twinkling star, the activity with a light passing over it, the
// seconds, and how to stop. "düşünüyor · son cümle" shows the part after the dot dimmed. Writes only on an
// interactive terminal.
const STAR = ['⋆', '✧', '✦', '★', '✦', '✧'];
let cursorHidden = false;
process.once('exit', () => { if (cursorHidden) process.stdout.write('\x1b[?25h'); });

export function spinner(label, { hint = 'Ctrl+C durdurur' } = {}) {
  const start = Date.now();
  let text = label;
  let tick = 0;
  let timer;
  const draw = () => {
    const cut = text.indexOf(' · ');
    const activity = (cut < 0 ? text : text.slice(0, cut)).replace(/^./u, first => first.toLocaleUpperCase('tr')) + '…';
    const detail = cut < 0 ? '' : text.slice(cut + 3);
    const seconds = `${((Date.now() - start) / 1000).toFixed(0)} sn`;
    // The light moves two letters per frame and rests off-screen for a moment between passes.
    const light = (tick * 2) % (activity.length + 24) - 6;
    const glow = gradient(activity, [RED, [255, 236, 232]], i => 1 - Math.abs(i - light) / 5);
    const head = `${t.red('☾')}${t.white(STAR[Math.floor(tick / 2) % STAR.length])} ${glow} ${t.dim(`(${seconds}${hint ? ` · ${hint}` : ''})`)}`;
    const room = width() - 4 - visible(head);
    const tail = detail && room > 12 ? ` ${t.faint(`┊ ${detail.length > room - 3 ? '…' + detail.slice(-(room - 4)) : detail}`)}` : '';
    // The line must never wrap, or it could not be redrawn in place; a few columns stay free in case the
    // terminal draws one of the symbols two cells wide.
    process.stdout.write(`\r\x1b[2K${fit(head + tail, (process.stdout.columns || 100) - 4)}`);
    tick++;
  };
  const active = color;
  if (active) {
    if (!cursorHidden) { process.stdout.write('\x1b[?25l'); cursorHidden = true; }
    draw(); timer = setInterval(draw, 80);
  }
  return {
    update(next) { text = next; },
    stop() {
      if (!active || !timer) return;
      clearInterval(timer); timer = undefined;
      process.stdout.write('\r\x1b[2K\x1b[?25h'); cursorHidden = false;
    },
    get running() { return Boolean(timer); },
  };
}

// "süre 4.2 sn · 312 token · 74 tok/sn"; token parts appear only when the server reports usage.
// Speed needs streaming: without it the time includes waiting, so it is not shown.
// Context size is not shown: Umay's prompt_tokens counts only the last message (8 Nov 2026), not the conversation.
export function formatStats(seconds, usage, stats) {
  const parts = [`süre ${seconds.toFixed(1)} sn`];
  const output = usage?.outputTokens;
  if (Number.isFinite(output)) {
    parts.push(`${output} token`);
    if (stats?.streamed && stats.generationMs > 200 && output > 0) parts.push(`${Math.round(output / (stats.generationMs / 1000))} tok/sn`);
  }
  return parts.join(' · ');
}
