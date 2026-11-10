import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Memory, MEMORY_LIMIT } from '../src/memory.mjs';

async function folder(t) {
  const base = path.resolve('.test-tmp');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'bellek-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('notes are stored as plain lines, deduplicated, removed by number and survive reloads', async t => {
  const file = path.join(await folder(t), 'alt', 'bellek.md');
  const memory = new Memory(file).load();
  assert.deepEqual(memory.items, []);
  assert.equal(await memory.add('  Adım   Eray '), true);
  assert.equal(await memory.add('adım eray'), false, 'case-insensitive duplicate');
  await memory.add('Python projelerimde tip ipuçları kullanırım');
  assert.match(await readFile(file, 'utf8'), /^# Umay CLI belleği[\s\S]*\n- Adım Eray\n- Python projelerimde tip ipuçları kullanırım\n$/);
  assert.equal(await memory.remove(1), 'Adım Eray');
  await assert.rejects(memory.remove(5), /1–1/);
  assert.deepEqual(new Memory(file).load().items, ['Python projelerimde tip ipuçları kullanırım']);
  await writeFile(file, '# not\nserbest metin satırı\n- elle eklenen not\n');
  assert.deepEqual(new Memory(file).load().items, ['elle eklenen not'], 'only "- " lines are notes');
});

test('notes go in as a system message after the leading ones, newest kept within the limit', () => {
  const memory = new Memory('unused');
  const list = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
  assert.equal(memory.apply(list), list, 'no notes: unchanged');
  memory.items = ['bir', 'iki'];
  const applied = memory.apply(list);
  assert.deepEqual(applied.map(m => m.role), ['system', 'system', 'user']);
  assert.match(applied[1].content, /kalıcı notlar[\s\S]*\n- bir\n- iki$/);
  assert.equal(memory.apply(list, false), list, 'disabled: unchanged');
  memory.items = ['eski ' + 'x'.repeat(MEMORY_LIMIT), 'yeni'];
  assert.doesNotMatch(memory.systemText(), /eski/);
  assert.match(memory.systemText(), /- yeni$/);
  memory.items = ['x'.repeat(MEMORY_LIMIT + 1)];
  assert.equal(memory.apply(list), list, 'nothing fits: no heading without notes');
});

test('CLI: /bellek ekle, notes reach the model, /bellek kapat stops them, one-shot uses them too', async t => {
  const dir = await folder(t);
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Tamam' }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, UMAY_API_KEY: 'mock', NO_COLOR: '1', UMAY_SETTINGS: path.join(dir, 'ayarlar.json'), UMAY_INTERACTIVE: '1' };
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const run = (args, input) => new Promise(resolve => {
    const child = spawn(process.execPath, ['src/cli.mjs', '--no-tools', '--no-stream', '--base-url', baseURL, ...args], { env });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', d => out += d);
    child.stderr.resume();
    child.stdin.end(input);
    child.on('close', () => resolve(out));
  });
  const out = await run([], '/bellek ekle Adım Eray, dilekçelerde bu adı kullan\nselam\n/bellek kapat\nselam\n/bellek\n/cikis\n');
  assert.match(out, /Not eklendi \(1\)/);
  const notes = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  assert.match(notes(bodies[0]), /- Adım Eray, dilekçelerde bu adı kullan/);
  assert.doesNotMatch(notes(bodies[1]), /Adım Eray/, 'off after /bellek kapat');
  assert.match(out, /Bellek: kapalı[\s\S]*1\. Adım Eray/);
  assert.equal(await readFile(path.join(dir, 'bellek.md'), 'utf8').then(s => s.includes('- Adım Eray')), true);
  await run([], '/bellek ac\n/cikis\n');
  await run(['--prompt', 'adımı yaz'], '');
  assert.match(notes(bodies.at(-1)), /Adım Eray/, 'one-shot requests carry the notes');
});
