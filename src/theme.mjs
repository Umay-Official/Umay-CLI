// Terminal look: Turkish flag red and white, with gray for secondary text.
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';

export const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const rgb = (r, g, b) => `38;2;${r};${g};${b}`;
const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : String(text);

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
};

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

export function banner() {
  const shades = [[255, 40, 50], [240, 25, 35], [227, 10, 23], [205, 8, 20], [185, 7, 18], [150, 6, 14]];
  const logo = LOGO.map((line, i) => color ? `\x1b[${rgb(...shades[i])}m${line}\x1b[0m` : line);
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

// One-line spinner for waits. Writes only on an interactive terminal.
export function spinner(label) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const start = Date.now();
  let text = label;
  let i = 0;
  let timer;
  const draw = () => {
    const seconds = ((Date.now() - start) / 1000).toFixed(0);
    const room = width() - 16 - seconds.length;
    const shown = text.length > room ? text.slice(0, Math.max(10, room - 1)) + '…' : text;
    process.stdout.write(`\r\x1b[2K  ${t.red(frames[i++ % frames.length])} ${t.dim(`${shown} · ${seconds} sn`)}`);
  };
  const active = color;
  if (active) { draw(); timer = setInterval(draw, 90); }
  return {
    update(next) { text = next; },
    stop() {
      if (!active || !timer) return;
      clearInterval(timer); timer = undefined;
      process.stdout.write('\r\x1b[2K');
    },
    get running() { return Boolean(timer); },
  };
}
