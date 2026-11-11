// The interactive prompt: a rule above and below the line being typed, a status line under it and a live menu
// of matching commands. readline still edits the line. This module stands between readline and the terminal:
// it draws the lines below the input after readline's own writes, and takes the keys that move through the menu.
import { EventEmitter } from 'node:events';
import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { t, clean, fit } from './theme.mjs';

const CSI = '\x1b[';
const NO_MENU = { items: [], from: 0 };
const MENU_ROWS = 7;

function wrap(line, size) {
  const rows = [];
  let row = '';
  for (let word of line.replace(/\t/g, '  ').split(' ')) {
    while (word.length > size) {
      if (row) { rows.push(row); row = ''; }
      rows.push(word.slice(0, size)); word = word.slice(size);
    }
    if (row && row.length + 1 + word.length > size) { rows.push(row); row = word; }
    else row = row ? `${row} ${word}` : word;
  }
  rows.push(row);
  return rows;
}

// A sent message as it stays in the transcript.
export function userBlock(text, columns = process.stdout.columns || 100) {
  const rows = clean(text).split('\n').flatMap(line => wrap(line, Math.max(20, Math.min(columns, 120) - 8)));
  const size = Math.max(...rows.map(row => row.length));
  return rows.map((row, i) => `  ${i ? t.user('   ') : t.userMark(' ❯ ')}${t.user(`${row.padEnd(size)} `)}`).join('\n');
}

// Row and column where a text ends on screen. readline's own measure is used when it is there, so both agree
// on wide characters; this one covers the common cases.
function measure(text, columns) {
  let rows = 0;
  let offset = 0;
  for (const char of stripVTControlCharacters(text)) {
    if (char === '\n') { rows += Math.ceil(offset / columns) || 1; offset = 0; continue; }
    offset += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}]/u.test(char) ? 2 : 1;
  }
  const cols = offset % columns;
  return { rows: rows + (offset - cols) / columns, cols };
}

// suggest(line) -> { items: [{ value, name, args, desc }], from, command, exact } lists what the typed line can
//   become: `value` replaces the line from index `from`; `command` marks a list of commands (not arguments) and
//   `exact` says the typed word already is one.
// status(columns) -> the lines shown under the input when no menu is open.
// hint() -> gray text shown in the empty input.
export function createFrame({ suggest, status, hint = () => '', stdin = process.stdin, stdout = process.stdout }) {
  let rl = null;
  let live = null;      // the question on screen: menu state, and where the cursor was left after the last draw
  let buffer = '';      // readline's writes since the last draw
  let waiting = false;

  const columns = () => stdout.columns || 100;
  const rule = () => `  ${t.darkRed('─'.repeat(Math.max(10, columns() - 4)))}`;
  const promptText = () => `${rule()}\n  ${t.redBold('❯')} `;

  // What readline writes to. Outside a framed question it is the terminal itself.
  const output = new EventEmitter();
  output.isTTY = true;
  Object.defineProperties(output, { columns: { get: () => stdout.columns }, rows: { get: () => stdout.rows } });
  output.write = (data, encoding, callback) => {
    if (live) { buffer += data; schedule(); }
    // Keys typed while no question is waiting are not echoed into the answer on screen; readline keeps them
    // and they show up in the next prompt.
    else if (rl?.asking) stdout.write(data);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  stdout.on('resize', () => {
    if (live) rl.setPrompt(promptText());
    output.emit('resize');
  });

  // What readline reads keys from: the terminal's keys, minus the ones the menu takes.
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = mode => { stdin.setRawMode?.(mode); return input; };
  input.resume = () => { stdin.resume(); return input; };
  input.pause = () => { stdin.pause(); return input; };
  emitKeypressEvents(stdin);
  stdin.on('keypress', (text, key = {}) => {
    if (live && take(key)) { schedule(); return; }
    input.emit('keypress', text, key);
    // A line brought back from the history is not the start of a menu.
    if (live && (key.name === 'up' || key.name === 'down')) live.closedFor = rl.line;
    if (live) schedule();
  });
  stdin.on('end', () => input.emit('end'));

  function schedule() {
    if (waiting) return;
    waiting = true;
    queueMicrotask(draw);
  }

  function menuNow() {
    const line = rl.line;
    const atEnd = rl.cursor === line.length;
    const key = `${atEnd}|${line}`;
    if (live.key !== key) {
      live.key = key;
      live.menu = line.startsWith('/') && atEnd && live.closedFor !== line ? suggest(line) : NO_MENU;
      live.selected = 0;
      live.picked = false;
    }
    return live.menu;
  }

  function menuRows(menu) {
    const count = menu.items.length;
    const first = Math.max(0, Math.min(live.selected - Math.floor(MENU_ROWS / 2), count - MENU_ROWS));
    const shown = menu.items.slice(first, first + MENU_ROWS);
    const size = Math.min(34, Math.max(...shown.map(item => item.name.length + (item.args ? item.args.length + 1 : 0))));
    const rows = shown.map((item, i) => {
      const on = first + i === live.selected;
      const gap = ' '.repeat(Math.max(2, size + 3 - item.name.length - (item.args ? item.args.length + 1 : 0)));
      const label = `${on ? t.redBold(item.name) : t.text(item.name)}${item.args ? t.faint(` ${item.args}`) : ''}`;
      return `  ${on ? t.red('❯') : ' '} ${label}${gap}${item.desc ? (on ? t.text(item.desc) : t.dim(item.desc)) : ''}`;
    });
    const keys = menu.command ? '↑↓ seç · Tab tamamla · Enter çalıştır · Esc kapat' : '↑↓ seç · Tab tamamla · Esc kapat';
    rows.push(`    ${t.faint(`${keys}${count > MENU_ROWS ? ` · ${live.selected + 1}/${count}` : ''}`)}`);
    return rows;
  }

  // Replays readline's writes, then redraws everything below the typed line and puts the cursor back.
  function draw() {
    waiting = false;
    if (!live) return;
    const cur = rl.getCursorPos();
    const text = rl.getPrompt() + rl.line;
    const end = typeof rl._getDisplayPos === 'function' ? rl._getDisplayPos(text) : measure(text, columns());
    const menu = menuNow();
    const below = [rule(), ...(menu.items.length ? menuRows(menu) : status(columns()))];
    const down = Math.max(0, end.rows - cur.rows);
    let out = buffer;
    buffer = '';
    out += `${down ? `${CSI}${down}B` : ''}${CSI}${end.cols + 1}G${CSI}J`;
    if (!rl.line) out += t.faint(fit(hint(), Math.max(10, columns() - 8)));
    for (const line of below) out += `\r\n${fit(line, columns() - 1)}`;
    out += `${CSI}${below.length + down}A${CSI}${cur.cols + 1}G`;
    stdout.write(out);
    live.cur = cur;
  }

  function setLine(text) {
    rl.write(null, { ctrl: true, name: 'e' });
    rl.write(null, { ctrl: true, name: 'u' });
    if (text) rl.write(text);
  }

  // Puts the selected entry into the line. Returns true when the line now waits for more typing.
  function accept(menu) {
    const item = menu.items[live.selected];
    setLine(rl.line.slice(0, menu.from) + item.value + (menu.command && item.args ? ' ' : ''));
    return menu.command ? Boolean(item.args?.startsWith('<')) : /[\\/ ]$/.test(item.value);
  }

  // Keys the frame handles itself. Returns false for keys readline should get.
  function take(key) {
    const name = key.name;
    if (key.ctrl && name === 'c' && rl.line) { setLine(''); return true; }
    const menu = menuNow();
    const count = menu.items.length;
    if (name === 'tab') { if (count) accept(menu); return true; }
    if (!count) return false;
    if ((name === 'up' || name === 'down') && count > 1 && !key.ctrl && !key.meta && !key.shift) {
      live.selected = (live.selected + (name === 'up' ? count - 1 : 1)) % count;
      live.picked = true;
      return true;
    }
    if (name === 'escape') { live.closedFor = rl.line; live.key = null; return true; }
    if (name === 'return') {
      // Enter runs what was typed when it is already complete; otherwise it takes the highlighted entry first.
      const asTyped = menu.command ? !live.picked && (rl.line === '/' || menu.exact) : !live.picked;
      return asTyped ? false : accept(menu);
    }
    return false;
  }

  // Removes the frame from the screen and leaves the sent message in its place.
  function finish(value) {
    const { cur } = live;
    live = null;
    buffer = '';
    let out = cur ? `${cur.rows ? `${CSI}${cur.rows}A` : ''}\r${CSI}J` : '';
    if (typeof value === 'string' && value.trim()) out += `${userBlock(value, columns())}\n`;
    if (out) stdout.write(out);
  }

  return {
    input,
    output,
    attach(created) { rl = created; },
    // Resolves with the typed line, or null when the prompt was closed.
    question() {
      if (rl.queued?.length) {
        const line = rl.queued.shift();
        if (line.trim()) stdout.write(`${userBlock(line, columns())}\n`);
        return Promise.resolve(line);
      }
      if (rl.closed) return Promise.resolve(null);
      return new Promise(resolve => {
        const done = value => { rl.off('close', close); finish(value); resolve(value); };
        const close = () => done(null);
        rl.once('close', close);
        live = { key: null, menu: NO_MENU, selected: 0, picked: false, closedFor: null, cur: null };
        rl.question(promptText(), done);
        // readline shows text typed ahead with the cursor at its start.
        if (rl.line) rl.write(null, { ctrl: true, name: 'e' });
      });
    },
  };
}
