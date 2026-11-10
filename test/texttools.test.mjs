import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
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

test('parser repairs garbled endings after a long argument (Umay Daha Zeki output)', () => {
  const content = 'def f():\n    return {"a": 1}\n';
  const head = `{"name": "write_file", "arguments": {"path": "a.py", "content": ${JSON.stringify(content)}`;
  for (const tail of ['}', '}]', '\n})', ')}}', '}"}}', '}"/>', '\\n}}', ',"",""}}', '"""}']) {
    const parsed = parseToolCalls(`<tool_call>\n${head}${tail}\n</tool_call>`);
    assert.deepEqual(parsed.calls[0], { name: 'write_file', args: { path: 'a.py', content } }, `son: ${tail}`);
  }
  const pythonLiteral = parseToolCalls('<tool_call>{"name": "write_file", "arguments": {"path": "a", "content": "x", "requires_approval": False}]}</tool_call>');
  assert.deepEqual(pythonLiteral.calls[0].args, { path: 'a', content: 'x', requires_approval: false });
});

test('parser does not cut a call that is broken in the middle', () => {
  // Unescaped quote inside the code: repairing it would silently write half a file.
  const parsed = parseToolCalls('<tool_call>{"name": "write_file", "arguments": {"path": "a.py", "content": "x = 1\\n# Not: "tırnak" burada\\ny = 2\\n"}</tool_call>');
  assert.match(parsed.calls[0].error, /okunamadı/);
  const unterminated = parseToolCalls('<tool_call>{"name": "write_file", "arguments": {"path": "a.py", "content": "yarım kalan</tool_call>');
  assert.match(unterminated.calls[0].error, /okunamadı/);
});

test('lines of only a code fence or "#" are content inside an argument, decoration only around the call', () => {
  // Raw line breaks inside the JSON string, as models write them for file content.
  const markdown = '# Başlık\n#\n```python\nprint(1)\n```\nson';
  const json = parseToolCalls(`<tool_call>\n\`\`\`json\n{"name": "write_file", "arguments": {"path": "a.md", "content": "${markdown}"}}\n\`\`\`\n</tool_call>`);
  assert.deepEqual(json.calls[0], { name: 'write_file', args: { path: 'a.md', content: markdown } });
  const python = parseToolCalls('<tool_call>\n##\nwrite_file(path="a.py", content="""#\n# Not\n#\nx = 1\n""")\n</tool_call>');
  assert.deepEqual(python.calls[0].args, { path: 'a.py', content: '#\n# Not\n#\nx = 1\n' });
});

test('call syntax keeps the backslash of Windows paths and regular expressions', () => {
  const file = parseToolCalls(String.raw`<tool_call>read_file(path="C:\Users\eray\dosya.txt")</tool_call>`);
  assert.equal(file.calls[0].args.path, String.raw`C:\Users\eray\dosya.txt`);
  const search = parseToolCalls(String.raw`<tool_call>search_files(pattern="\d+\.\d+", path='it\'s')</tool_call>`);
  assert.deepEqual(search.calls[0].args, { pattern: String.raw`\d+\.\d+`, path: "it's" });
});

// The shapes below are from the benchmark logs of 9-10 Nov 2026 (Umay Hızlı wrote most of them).
test('arguments written in the wrong place are put where the tool expects them', () => {
  const tools = [
    { name: 'read_file', parameters: { properties: { path: {}, start_line: {}, max_lines: {} }, required: ['path'] } },
    { name: 'list_dir', parameters: { properties: { path: {}, pattern: {}, recursive: {} }, required: [] } },
    { name: 'edit_file', parameters: { properties: { path: {}, old_text: {}, new_text: {} }, required: ['path', 'old_text', 'new_text'] } },
    { name: 'run_command', parameters: { properties: { command: {}, timeout: {} }, required: ['command'] } },
    { name: 'run_python', parameters: { properties: { code: {}, timeout: {} }, required: ['code'] } },
  ];
  const read = text => parseToolCalls(`<tool_call>\n${text}\n</tool_call>`, tools).calls[0];
  // The one required argument as a bare string, other arguments beside it.
  assert.deepEqual(read('{"name":"read_file","arguments":"README.md"}'), { name: 'read_file', args: { path: 'README.md' } });
  assert.deepEqual(read('{"name": "run_command", "arguments": "Get-ChildItem -Recurse", "timeout": 60}'),
    { name: 'run_command', args: { command: 'Get-ChildItem -Recurse', timeout: 60 } });
  assert.deepEqual(read('{"name":"list_dir","arguments":"gelen","pattern":"*","recursive":true}'),
    { name: 'list_dir', args: { path: 'gelen', pattern: '*', recursive: true } });
  assert.deepEqual(read('{"name":"run_python","arguments":"code:\\nimport os\\nprint(1)","timeout":30}'),
    { name: 'run_python', args: { code: 'import os\nprint(1)', timeout: 30 } });
  // Arguments beside "arguments", or with no "arguments" at all.
  assert.deepEqual(read('{"name":"run_command","arguments":{"command":"npm test"},"timeout":300}').args, { command: 'npm test', timeout: 300 });
  assert.deepEqual(read('{"name":"read_file","path":"a.txt","max_lines":5}').args, { path: 'a.txt', max_lines: 5 });
  // The object closed early and continued in a new one.
  assert.deepEqual(read('{"name":"read_file","arguments":{"path":"a.py"},{"max_lines":200}}').args, { path: 'a.py', max_lines: 200 });
  assert.deepEqual(read('{"name":"run_python","arguments":{"code":"print(1)"}\n{"timeout": 10}').args, { code: 'print(1)', timeout: 10 });
  assert.deepEqual(read('{"name":"edit_file","arguments":{"path":"t.py","old_text":"a"},{"new_text":"b = \\"1\\""}}').args,
    { path: 't.py', old_text: 'a', new_text: 'b = "1"' });
  // The braces of the inner object left out.
  assert.deepEqual(read('{"name":"run_command","arguments":"command":"node test.js","timeout":30}').args, { command: 'node test.js', timeout: 30 });
  // Not guessed: a second value for the same key, a value that swallowed the next key, more than a path.
  assert.match(read('{"name":"read_file","arguments":{"path":"a.py"},{"path":"b.py"}}').error, /okunamadı/);
  assert.match(read('{"name":"run_python","arguments":{"code":"print(1)\\",\\"timeout":60}}').error, /okunamadı/);
  assert.match(read('{"name":"read_file","arguments":"a.py\\n,max_lines:20"}').error, /okunamadı/);
  assert.match(read('{"name":"edit_file","arguments":"t.py"}').error, /okunamadı/, 'several required arguments: no guess');
  // Without the tool list nothing is moved.
  assert.match(parseToolCalls('<tool_call>{"name":"read_file","arguments":"README.md"}</tool_call>').calls[0].error, /okunamadı/);
});

test('calls that did not run are reported instead of dropped silently', () => {
  const cut = parseToolCalls('Okuyorum.\n<tool_call>\n');
  assert.equal(cut.calls.length, 1);
  assert.match(cut.calls[0].error, /boş ya da yarım/);
  const many = parseToolCalls('<tool_call>{"name": "list_dir", "arguments": {}}</tool_call>'.repeat(10));
  assert.equal(many.calls.filter(call => !call.error).length, 8);
  assert.match(many.calls.at(-1).error, /en fazla 8/);
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

test('a made-up tool name such as "constructor" is an unknown tool, not a crash', async t => {
  const { runtime } = await setup(t);
  const { baseURL, bodies } = await textServer(t, bodies => bodies.length === 1
    ? '<tool_call>{"name": "constructor", "arguments": {}}</tool_call>' : 'Tamam.');
  const result = await chat({ apiKey: 'mock', baseURL, runtime, toolMode: 'text', stream: false,
    messages: [{ role: 'user', content: 'x' }] });
  assert.match(lastUser(bodies[1]), /Bilinmeyen araç: constructor/);
  assert.equal(result.text, 'Tamam.');
});

test('a turn that fails midway hands back its finished steps, so the conversation can continue', async t => {
  const { runtime, cwd } = await setup(t);
  await writeFile(path.join(cwd, 'not.txt'), 'içerik');
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    if (bodies.length > 1) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"x"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant',
      content: '<tool_call>{"name": "read_file", "arguments": {"path": "not.txt"}}</tool_call>' }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(chat({ apiKey: 'mock', baseURL: `http://127.0.0.1:${server.address().port}/v1`, runtime, toolMode: 'text',
    stream: false, messages: [{ role: 'user', content: 'Oku ve özetle' }] }), error => {
    assert.equal(error.toolActivity, true);
    assert.deepEqual(error.partialMessages.map(message => message.role), ['assistant', 'user', 'assistant']);
    assert.match(error.partialMessages[0].content, /read_file/);
    assert.match(error.partialMessages[1].content, /<tool_result name="read_file">[\s\S]*içerik/);
    assert.match(error.partialMessages[2].content, /kesildi/);
    return true;
  });
});

test('a turn stopped during an approval records that the call did not finish', async t => {
  const abort = new AbortController();
  const { runtime, cwd } = await setup(t, { confirm: async () => { abort.abort(); return false; } });
  const { baseURL } = await textServer(t, () =>
    '<tool_call>{"name": "list_dir", "arguments": {}}</tool_call><tool_call>{"name": "write_file", "arguments": {"path": "x.txt", "content": "veri"}}</tool_call>');
  await assert.rejects(chat({ apiKey: 'mock', baseURL, runtime, toolMode: 'text', stream: false, signal: abort.signal,
    messages: [{ role: 'user', content: 'Yaz' }] }), error => {
    assert.equal(error.name, 'AbortError');
    assert.match(error.partialMessages[1].content, /<tool_result name="list_dir">[\s\S]*<tool_result name="write_file">\nTur kesildi/);
    return true;
  });
  await assert.rejects(access(path.join(cwd, 'x.txt')));
});

test('waiting for an approval does not count towards the time limit', async t => {
  const { runtime, cwd } = await setup(t, { confirm: async () => { await new Promise(resolve => setTimeout(resolve, 600)); return true; } });
  const { baseURL } = await textServer(t, bodies => bodies.length === 1
    ? '<tool_call>{"name": "write_file", "arguments": {"path": "x.txt", "content": "veri"}}</tool_call>' : 'Yazıldı.');
  const result = await chat({ apiKey: 'mock', baseURL, runtime, toolMode: 'text', stream: false, timeout: 300,
    messages: [{ role: 'user', content: 'Yaz' }] });
  assert.equal(result.text, 'Yazıldı.');
  assert.equal(await readFile(path.join(cwd, 'x.txt'), 'utf8'), 'veri');
});

test('CLI: after a turn that failed midway, "devam et" continues with what was done; failed commands are marked', async t => {
  const { cwd } = await setup(t);
  await writeFile(path.join(cwd, 'not.txt'), 'içerik');
  const call = (name, args) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    if (bodies.length === 2) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"x"}}'); return; }
    const content = bodies.length === 1 ? call('read_file', { path: 'not.txt' })
      : bodies.length === 3 ? call('run_python', { code: 'import sys; sys.exit(3)' }) : 'Bitti.';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const child = spawn(process.execPath, ['src/cli.mjs', '--no-stream', '--yes', '--cwd', cwd, '--base-url', `http://127.0.0.1:${server.address().port}/v1`],
    { env: { ...process.env, UMAY_API_KEY: 'mock', NO_COLOR: '1', UMAY_SETTINGS: path.join(cwd, 'ayarlar.json'), UMAY_INTERACTIVE: '1', UMAY_THINKING: '' } });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => stdout += data);
  child.stderr.setEncoding('utf8').on('data', data => stderr += data);
  child.stdin.end('not.txt dosyasını oku ve özetle\ndevam et\n/cikis\n');
  await once(child, 'close');
  assert.equal(bodies.length, 4, stderr);
  assert.match(stdout, /sohbette duruyor/);
  const sent = bodies[2].messages.filter(message => message.role !== 'system');
  assert.deepEqual(sent.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(sent[1].content, /read_file/);
  assert.match(sent[2].content, /<tool_result name="read_file">[\s\S]*içerik/);
  assert.equal(sent[4].content, 'devam et');
  assert.match(stderr, /✗ çıkış kodu: 3/, 'a non-zero exit code is not shown with a check mark');
  assert.match(stdout, /Bitti\./);
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
