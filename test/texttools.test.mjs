import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ToolRuntime } from '../src/tools.mjs';
import { chat } from '../src/client.mjs';
import { parseToolCalls, visibleFilter } from '../src/texttools.mjs';

async function setup(t, options = {}) {
  const folder = path.resolve('.test-tmp');
  await mkdir(folder, { recursive: true });
  const cwd = await mkdtemp(path.join(folder, 'text-'));
  const runtime = new ToolRuntime({ cwd, ...options });
  t.after(async () => {
    await runtime.close();
    assert.ok(cwd.startsWith(folder + path.sep), 'cleanup stays inside the test folder');
    await rm(cwd, { recursive: true, force: true });
  });
  await runtime.start();
  return { runtime, cwd };
}

// Replies with plain assistant text, the only thing a server without native tools returns.
async function textServer(t, reply, { stream = false } = {}) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    const content = reply(bodies);
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Small chunks split the <tool_call> tag across network events.
    for (let i = 0; i < content.length; i += 4) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 4) } }] }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, bodies };
}

const lastUser = body => body.messages.filter(m => m.role === 'user').at(-1).content;

test('parser reads canonical JSON blocks and keeps the text before them', () => {
  const parsed = parseToolCalls('Okuyorum.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.txt", "max_lines": 5}}\n</tool_call>\nuydurma sonuç');
  assert.equal(parsed.before, 'Okuyorum.');
  assert.deepEqual(parsed.calls, [{ name: 'read_file', args: { path: 'a.txt', max_lines: 5 } }]);
  assert.equal(parseToolCalls('Araç gerekmiyor.'), null);
});

test('parser accepts the format Umay produced: repeated openers, ## lines, call syntax, guessed names', () => {
  const parsed = parseToolCalls('Anladım.\n<tool_call>\n##\nlist_files(path=".")\n<tool_call>\n##\nread_file(path="test.txt")\n');
  assert.deepEqual(parsed.calls, [
    { name: 'list_dir', args: { path: '.' } },
    { name: 'read_file', args: { path: 'test.txt' } },
  ]);
});

test('parser handles quoted code, escapes, numbers and string-encoded arguments', () => {
  const code = parseToolCalls(`<tool_call>run_python(code="""print('a, b')\nprint(1)""", timeout=30)</tool_call>`);
  assert.deepEqual(code.calls[0], { name: 'run_python', args: { code: "print('a, b')\nprint(1)", timeout: 30 } });
  const escaped = parseToolCalls('<tool_call>write_file(path=\'x.txt\', content="satır 1\\nİ \\"tırnak\\"")</tool_call>');
  assert.deepEqual(escaped.calls[0].args, { path: 'x.txt', content: 'satır 1\nİ "tırnak"' });
  const fenced = parseToolCalls('<tool_call>\n```json\n{"name": "list_dir", "arguments": "{\\"path\\": \\"src\\"}"}\n```\n</tool_call>');
  assert.deepEqual(fenced.calls[0], { name: 'list_dir', args: { path: 'src' } });
  const rawNewlines = parseToolCalls('<tool_call>\n{"name": "run_python", "arguments": {"code": "print(\'can\'t\')\n\tprint(\\"b\\")"}}\n</tool_call>');
  assert.deepEqual(rawNewlines.calls[0], { name: 'run_python', args: { code: "print('can't')\n\tprint(\"b\")" } });
  const broken = parseToolCalls('<tool_call>dosyaları listele lütfen</tool_call>');
  assert.match(broken.calls[0].error, /okunamadı/);
});

test('visible filter hides tool markup split across chunks', () => {
  const shown = [];
  const filter = visibleFilter(text => shown.push(text));
  for (const chunk of ['Bakı', 'yorum <to', 'ol_ca', 'll>{"name"', ': "x"}</tool_call>']) filter.push(chunk);
  filter.flush();
  assert.equal(shown.join(''), 'Bakıyorum ');
  const plain = [];
  const other = visibleFilter(text => plain.push(text));
  for (const chunk of ['a <', 'b> c']) other.push(chunk);
  other.flush();
  assert.equal(plain.join(''), 'a <b> c');
});

for (const stream of [false, true]) {
  test(`text-mode agent runs tools and sends results back (${stream ? 'stream' : 'JSON'})`, async t => {
    const { runtime, cwd } = await setup(t);
    await writeFile(path.join(cwd, 'test.txt'), 'Gizli kelime: MAVI-KAPLUMBAGA-4817');
    const { baseURL, bodies } = await textServer(t, bodies => bodies.length === 1
      ? 'Dosyayı okuyayım.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "test.txt"}}\n</tool_call>\nSonuç: UYDURMA'
      : 'Gizli kelime MAVI-KAPLUMBAGA-4817.', { stream });
    const output = [];
    const result = await chat({ apiKey: 'mock', baseURL, runtime, stream, toolMode: 'text',
      messages: [{ role: 'user', content: 'test.txt içindeki gizli kelime ne?' }], onText: text => output.push(text) });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].tools, undefined);
    assert.ok(bodies[0].messages.some(m => m.role === 'system' && m.content.includes('TOOL CALLS') && m.content.includes('read_file')));
    assert.match(lastUser(bodies[1]), /<tool_result name="read_file">[\s\S]*MAVI-KAPLUMBAGA-4817/);
    const assistant = bodies[1].messages.find(m => m.role === 'assistant');
    assert.ok(!assistant.content.includes('UYDURMA'), 'guessed results after the call are dropped');
    assert.equal(output.join(''), 'Dosyayı okuyayım.\nGizli kelime MAVI-KAPLUMBAGA-4817.');
    assert.equal(result.text, 'Gizli kelime MAVI-KAPLUMBAGA-4817.');
    assert.deepEqual(result.messages.map(m => m.role), ['assistant', 'user', 'assistant']);
    if (!stream) { assert.equal(result.usage.totalTokens, 30); assert.equal(result.stats.contextTokens, 15, 'size after the last request'); }
  });
}

test('unknown tools and unreadable calls are reported back to the model', async t => {
  const { runtime } = await setup(t);
  const { baseURL, bodies } = await textServer(t, bodies => bodies.length === 1
    ? '<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call><tool_call>bunu yap</tool_call>'
    : 'Bu aracı kullanamıyorum.');
  const result = await chat({ apiKey: 'mock', baseURL, runtime, toolMode: 'text', stream: false,
    messages: [{ role: 'user', content: 'Sil' }] });
  assert.match(lastUser(bodies[1]), /Bilinmeyen araç: delete_everything\. Geçerli araçlar: .*list_dir/);
  assert.match(lastUser(bodies[1]), /okunamadı/);
  assert.equal(result.text, 'Bu aracı kullanamıyorum.');
});

test('text-mode writes still need approval', async t => {
  const prompts = [];
  const { runtime, cwd } = await setup(t, { confirm: async request => { prompts.push(request.name); return false; } });
  const { baseURL, bodies } = await textServer(t, bodies => bodies.length === 1
    ? '<tool_call>{"name": "write_file", "arguments": {"path": "x.txt", "content": "veri"}}</tool_call>'
    : 'Yazma reddedildi.');
  const result = await chat({ apiKey: 'mock', baseURL, runtime, toolMode: 'text', stream: false,
    messages: [{ role: 'user', content: 'Yaz' }] });
  assert.deepEqual(prompts, ['write_file']);
  await assert.rejects(access(path.join(cwd, 'x.txt')));
  assert.match(lastUser(bodies[1]), /reddetti/);
  assert.equal(result.text, 'Yazma reddedildi.');
});

test('text-mode agent stops at its step bound with completed results kept', async t => {
  const { runtime } = await setup(t);
  const { baseURL, bodies } = await textServer(t, () => '<tool_call>{"name": "list_dir", "arguments": {}}</tool_call>');
  const result = await chat({ apiKey: 'mock', baseURL, runtime, toolMode: 'text', stream: false, maxSteps: 2,
    messages: [{ role: 'user', content: 'Listele' }] });
  assert.equal(bodies.length, 2);
  assert.equal(result.stepLimit, true);
  assert.equal(result.messages.filter(m => m.role === 'user').length, 2);
});
