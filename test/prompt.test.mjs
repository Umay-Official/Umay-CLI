import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createFrame, userBlock } from '../src/prompt.mjs';

const COMMANDS = [
  { name: '/model', args: '[akilli|hizli|ultra|zeki]', desc: 'Modeli gör veya değiştir' },
  { name: '/sunum', args: '<konu>', desc: 'Sunum üret' },
  { name: '/yeni', desc: 'Yeni sohbet başlat' },
  { name: '/yardim', desc: 'Tüm komutları göster' },
];

function suggest(line) {
  const space = line.indexOf(' ');
  if (space < 0) {
    return { command: true, exact: COMMANDS.some(command => command.name === line), from: 0,
      items: COMMANDS.filter(command => command.name.startsWith(line)).map(command => ({ ...command, value: command.name })) };
  }
  const partial = line.slice(space + 1);
  const options = line.startsWith('/model ') ? ['akilli', 'hizli', 'ultra', 'zeki'].filter(option => option.startsWith(partial)) : [];
  return { from: line.length - partial.length, items: options.length === 1 && options[0] === partial ? [] : options.map(option => ({ value: option, name: option })) };
}

// A frame on a fake keyboard and a fake screen. `out` collects everything written to the screen.
function setup(t) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  const stdout = new EventEmitter();
  stdout.columns = 80;
  stdout.rows = 24;
  const screen = { out: '' };
  stdout.write = data => { screen.out += data; return true; };
  const frame = createFrame({ suggest, status: () => ['  durum satırı'], hint: () => 'ipucu', stdin, stdout });
  const rl = createInterface({ input: frame.input, output: frame.output, terminal: true, historySize: 50 });
  rl.queued = [];
  rl.on('line', line => rl.queued.push(line));
  frame.attach(rl);
  t.after(() => { rl.close(); stdin.destroy(); });
  // Keys reach readline a tick after they are written; a lone Esc waits for readline's escape timeout.
  const keys = async (text, wait = 15) => { stdin.write(text); await new Promise(resolve => setTimeout(resolve, wait)); };
  return { frame, rl, screen, keys };
}

test('typing a slash lists matching commands and Tab completes the highlighted one', async t => {
  const { frame, rl, screen, keys } = setup(t);
  const answer = frame.question();
  await keys('');
  assert.match(screen.out, /ipucu/, 'the empty input shows its hint');
  assert.match(screen.out, /durum satırı/, 'the status line is under the input');
  await keys('/mo');
  assert.match(screen.out, /\/model \[akilli\|hizli\|ultra\|zeki\]\s+Modeli gör veya değiştir/);
  assert.match(screen.out, /Tab tamamla/);
  await keys('\t');
  assert.equal(rl.line, '/model ', 'a command with an argument is completed with a space');
  await keys('\x1b[B');
  await keys('\x1b[B');
  await keys('\r');
  assert.equal(await answer, '/model ultra', 'arrow keys choose an argument and Enter sends it');
});

test('Enter takes the highlighted command; a command that needs an argument waits for it', async t => {
  const { frame, rl, keys } = setup(t);
  let answer = frame.question();
  await keys('/su');
  await keys('\r');
  assert.equal(rl.line, '/sunum ', 'completed, not sent');
  await keys('Ay');
  await keys('\r');
  assert.equal(await answer, '/sunum Ay');

  answer = frame.question();
  await keys('/ye');
  await keys('\r');
  assert.equal(await answer, '/yeni', 'a command without arguments runs at once');

  answer = frame.question();
  await keys('/y');
  await keys('\x1b[B');
  await keys('\r');
  assert.equal(await answer, '/yardim', 'the entry moved to with the arrow keys is the one that runs');

  answer = frame.question();
  await keys('/');
  await keys('\r');
  assert.equal(await answer, '/', 'a lone slash is sent as typed: it opens the full command list');

  answer = frame.question();
  await keys('/model ');
  await keys('\r');
  assert.equal(await answer, '/model ', 'an argument nobody chose is not filled in');
});

test('history, Esc and Ctrl+C: the menu stays out of the way', async t => {
  const { frame, rl, screen, keys } = setup(t);
  let answer = frame.question();
  await keys('/model zeki');
  await keys('\r');
  assert.equal(await answer, '/model zeki');

  answer = frame.question();
  await keys('');
  let mark = screen.out.length;
  await keys('\x1b[A');
  assert.equal(rl.line, '/model zeki', 'Up recalls the last line');
  assert.doesNotMatch(screen.out.slice(mark), /Tab tamamla/, 'a recalled line does not open the menu');
  await keys('\x03');
  assert.equal(rl.line, '', 'Ctrl+C clears a typed line');
  assert.ok(!rl.closed, 'and does not leave the prompt');

  await keys('/m');
  mark = screen.out.length;
  await keys('\x1b', 650);
  assert.doesNotMatch(screen.out.slice(mark), /Tab tamamla/, 'Esc closes the menu');
  assert.equal(rl.line, '/m', 'and keeps the text');
  await keys('\t');
  assert.equal(rl.line, '/m', 'Tab does nothing while the menu is closed');
  await keys('o');
  assert.match(screen.out.slice(mark), /Tab tamamla/, 'typing opens it again');

  await keys('\x03');
  await keys('\x03');
  assert.equal(await answer, null, 'Ctrl+C on an empty line closes the prompt');
});

test('a sent line becomes a message block, and keys typed while nothing is asked are not echoed', async t => {
  const { frame, rl, screen, keys } = setup(t);
  let answer = frame.question();
  await keys('selam');
  const mark = screen.out.length;
  await keys('\r');
  assert.equal(await answer, 'selam');
  const sent = screen.out.slice(mark);
  assert.match(sent, /\x1b\[1A\r\x1b\[J/, 'the frame is erased from its first row');
  assert.match(sent, /❯ selam/);
  assert.doesNotMatch(sent, /durum satırı/);

  const quiet = screen.out.length;
  await keys('erken');
  assert.equal(screen.out.length, quiet, 'nothing is written between questions');
  answer = frame.question();
  await keys('');
  assert.equal(rl.line, 'erken', 'the keys typed ahead are in the next prompt');
  assert.equal(rl.cursor, 5, 'with the cursor after them');
  await keys('\r');
  assert.equal(await answer, 'erken');

  // A whole line typed ahead waits in the queue and is shown as a message when its turn comes.
  await keys('sıradaki\r');
  const before = screen.out.length;
  assert.equal(await frame.question(), 'sıradaki');
  assert.match(screen.out.slice(before), /❯ sıradaki/);
});

test('message blocks wrap long lines and keep line breaks', () => {
  const block = userBlock(`${'kelime '.repeat(30).trim()}\nikinci`, 60);
  const rows = block.split('\n');
  assert.ok(rows.length >= 5);
  assert.ok(rows.every(row => row.length <= 60));
  assert.match(rows[0], /^ {2} ❯ kelime/);
  assert.match(rows.at(-1), /^ {5}ikinci/);
});
