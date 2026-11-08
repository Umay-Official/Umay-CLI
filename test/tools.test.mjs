import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { ToolRuntime } from '../src/tools.mjs';
import { chat } from '../src/client.mjs';

async function setup(t, options = {}) {
  // Keep all tests and generated files in this checkout.
  const folder = path.resolve('.test-tmp');
  await mkdir(folder, { recursive: true });
  const cwd = await mkdtemp(path.join(folder, 'tools-'));
  const runtime = new ToolRuntime({ cwd, ...options });
  t.after(async () => {
    await runtime.close();
    assert.ok(cwd.startsWith(folder + path.sep), 'cleanup stays inside the test folder');
    await rm(cwd, { recursive: true, force: true });
  });
  await runtime.start();
  return { runtime, cwd, tools: runtime.definitions() };
}

test('copied read/search/list tools and schemas work through Python', async t => {
  const { tools, runtime, cwd } = await setup(t);
  assert.equal(runtime.metadata.tools.length, 7);
  await writeFile(path.join(cwd, 'örnek.txt'), 'Merhaba\nİkinci satır\n');
  assert.match(await tools.list_dir.execute({}), /örnek.txt/);
  assert.match(await tools.read_file.execute({ path: 'örnek.txt', start_line: 2, max_lines: 1 }), /2→İkinci satır/);
  assert.match(await tools.search_files.execute({ pattern: 'İkinci', path: '.', file_pattern: '*.txt' }), /örnek.txt:2/);
  const invalid = await tools.read_file.execute({ path: 123 });
  assert.match(invalid, /^Hata:.*Geçersiz argüman türü/);
});

test('writes and edits require approval, preserve CRLF, and undo restores both changes', async t => {
  const approvals = [];
  const { tools, runtime, cwd } = await setup(t, { confirm: async item => { approvals.push(item); return true; } });
  const destination = path.join(cwd, 'note.txt');
  await writeFile(destination, 'bir\r\niki\r\n');
  const edit = await tools.edit_file.execute({ path: 'note.txt', old_text: 'iki', new_text: 'üç' });
  assert.match(edit, /düzenlendi/);
  assert.match(approvals[0].preview, /-iki[\s\S]*\+üç/);
  assert.equal(await readFile(destination, 'utf8'), 'bir\r\nüç\r\n');
  await tools.write_file.execute({ path: 'new.txt', content: 'yeni' });
  assert.match(await runtime.undo(), /silindi/);
  await assert.rejects(access(path.join(cwd, 'new.txt')));
  assert.match(await runtime.undo(), /eski hâline döndü/);
  assert.equal(await readFile(destination, 'utf8'), 'bir\r\niki\r\n');
  assert.equal(approvals.length, 2);
});

test('denied writes do not create a file or an undo entry', async t => {
  const { tools, runtime, cwd } = await setup(t, { confirm: async () => false });
  assert.match(await tools.write_file.execute({ path: 'denied.txt', content: 'no' }), /reddetti/);
  await assert.rejects(access(path.join(cwd, 'denied.txt')));
  assert.match(await runtime.undo(), /Geri alınacak.*yok/);
});

test('session approval is scoped to one tool and prompts never overlap', async t => {
  const prompts = [];
  let concurrent = 0;
  const { tools } = await setup(t, { confirm: async ({ name }) => {
    assert.equal(concurrent++, 0);
    prompts.push(name);
    await new Promise(resolve => setTimeout(resolve, 5));
    concurrent--;
    return 'always';
  } });
  await Promise.all([
    tools.write_file.execute({ path: 'a.txt', content: 'a' }),
    tools.write_file.execute({ path: 'b.txt', content: 'b' }),
  ]);
  await tools.edit_file.execute({ path: 'a.txt', old_text: 'a', new_text: 'c' });
  assert.deepEqual(prompts, ['write_file', 'edit_file']);
});

test('UMAY_PROTECTED_DIRS folders are read-only and edits changed after preview are refused', async t => {
  const protectedDir = path.resolve('.test-tmp', 'protected-src');
  process.env.UMAY_PROTECTED_DIRS = protectedDir;
  t.after(() => { delete process.env.UMAY_PROTECTED_DIRS; });
  const { tools, runtime, cwd } = await setup(t, { confirm: async ({ args }) => {
    await writeFile(path.join(cwd, args.path), 'external edit');
    return true;
  } });
  assert.deepEqual(runtime.metadata.protected, [protectedDir]);
  assert.match(runtime.instructions(), /These folders are read-only: .*protected-src/);
  assert.match(await tools.write_file.execute({ path: path.join(protectedDir, 'do-not-create.txt'), content: 'no' }), /salt okunur/);
  await assert.rejects(access(path.join(protectedDir, 'do-not-create.txt')));
  await writeFile(path.join(cwd, 'concurrent.txt'), 'old');
  assert.match(await tools.write_file.execute({ path: 'concurrent.txt', content: 'new' }), /önizlemeden sonra değişmiş/);
  assert.equal(await readFile(path.join(cwd, 'concurrent.txt'), 'utf8'), 'external edit');
});

test('undo refuses to overwrite an external edit', async t => {
  const { tools, runtime, cwd } = await setup(t, { auto: true });
  await tools.write_file.execute({ path: 'edited.txt', content: 'agent' });
  await writeFile(path.join(cwd, 'edited.txt'), 'human');
  await assert.rejects(runtime.undo(), /sonra değişmiş/);
  assert.equal(await readFile(path.join(cwd, 'edited.txt'), 'utf8'), 'human');
});

test('Python and shell commands use the working folder; repeated failing commands are blocked', async t => {
  const { tools, cwd, runtime } = await setup(t, { auto: true });
  const python = await tools.run_python.execute({ code: "import pathlib; print(pathlib.Path.cwd()); print('İyi günler')" });
  assert.match(python, /çıkış kodu: 0/);
  assert.ok(python.includes(cwd));
  assert.match(python, /İyi günler/);
  const command = runtime.metadata.shell.includes('PowerShell') ? "Write-Output 'shell-ok'" : "printf shell-ok";
  assert.match(await tools.run_command.execute({ command }), /shell-ok/);
  const failed = { code: "raise ValueError('test failure')" };
  assert.match(await tools.run_python.execute(failed), /çıkış kodu: 1/);
  assert.match(await tools.run_python.execute(failed), /yeniden çalıştırılmadı/);
  await tools.write_file.execute({ path: 'changed.txt', content: 'change' });
  assert.match(await tools.run_python.execute(failed), /çıkış kodu: 1/);
});

test('cancelling a running command stops it and keeps the Python bridge and undo usable', async t => {
  const { runtime, tools, cwd } = await setup(t, { auto: true });
  await tools.write_file.execute({ path: 'undo.txt', content: 'undoable' });
  const abort = new AbortController();
  const pending = runtime.definitions(abort.signal).run_python.execute({
    code: "import time, pathlib; pathlib.Path('started.txt').write_text('started'); time.sleep(20); pathlib.Path('late.txt').write_text('bad')",
  });
  for (let i = 0; i < 100; i++) {
    try { await access(path.join(cwd, 'started.txt')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  await access(path.join(cwd, 'started.txt'));
  abort.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.match(await tools.list_dir.execute({}), /started.txt/);
  assert.match(await runtime.undo(), /silindi/);
  await assert.rejects(access(path.join(cwd, 'late.txt')));
});

test('changing work folders keeps relative paths explicit', async t => {
  const { runtime, cwd, tools } = await setup(t, { auto: true });
  await mkdir(path.join(cwd, 'sub'));
  await runtime.changeDirectory('sub');
  await tools.write_file.execute({ path: 'here.txt', content: 'here' });
  assert.equal(await readFile(path.join(cwd, 'sub', 'here.txt'), 'utf8'), 'here');
});

async function modelServer(t, handler) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    bodies.push(JSON.parse(text));
    handler(res, bodies);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, bodies };
}
function send(res, message, finish_reason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }] }));
}
function call(name, args, id = 'call-1') {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('agent calls copied tools, receives results, and returns persistable tool history', async t => {
  const { runtime, cwd } = await setup(t, { auto: true });
  await writeFile(path.join(cwd, 'input.txt'), 'merhaba');
  const { baseURL, bodies } = await modelServer(t, (res, bodies) => {
    if (bodies.length === 1) send(res, { content: null, tool_calls: [call('read_file', { path: 'input.txt' })] }, 'tool_calls');
    else if (bodies.length === 2) send(res, { content: null, tool_calls: [call('write_file', { path: 'output.txt', content: 'düzenlendi' }, 'call-2')] }, 'tool_calls');
    else send(res, { content: 'Dosyayı okudum ve çıktıyı yazdım.' });
  });
  const result = await chat({ apiKey: 'mock', baseURL, runtime, stream: false,
    messages: [{ role: 'user', content: 'Giriş dosyasını okuyup çıktıyı yaz.' }] });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].tools.length, 7);
  assert.ok(bodies[1].messages.some(m => m.role === 'tool' && m.content.includes('merhaba')));
  assert.equal(await readFile(path.join(cwd, 'output.txt'), 'utf8'), 'düzenlendi');
  assert.equal(result.text, 'Dosyayı okudum ve çıktıyı yazdım.');
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 2);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result.messages)));
});

test('streamed native tool calls are executed before the final answer', async t => {
  const { runtime, cwd } = await setup(t);
  await writeFile(path.join(cwd, 'input.txt'), 'stream test');
  const { baseURL, bodies } = await modelServer(t, (res, bodies) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\n');
    if (bodies.length === 1) {
      event({ tool_calls: [{ index: 0, id: 'stream-call', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] });
      event({ tool_calls: [{ index: 0, function: { arguments: '"input.txt"}' } }] });
      event({}, 'tool_calls');
    } else { event({ content: 'Dosyayı okudum.' }); event({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  const output = [];
  const result = await chat({ apiKey: 'mock', baseURL, runtime,
    messages: [{ role: 'user', content: 'Oku' }], onText: text => output.push(text) });
  assert.equal(bodies.length, 2);
  assert.equal(result.text, 'Dosyayı okudum.');
  assert.equal(output.join(''), result.text);
  assert.ok(bodies[1].messages.some(m => m.role === 'tool' && m.content.includes('stream test')));
});

test('agent stops at its step bound and preserves completed tool results', async t => {
  const { runtime } = await setup(t);
  const { baseURL, bodies } = await modelServer(t, (res, bodies) => {
    send(res, { content: null, tool_calls: [call('list_dir', {}, `call-${bodies.length}`)] }, 'tool_calls');
  });
  const result = await chat({ apiKey: 'mock', baseURL, runtime, stream: false, maxSteps: 2,
    messages: [{ role: 'user', content: 'Listele' }] });
  assert.equal(bodies.length, 2);
  assert.equal(result.stepLimit, true);
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 2);
});

test('CLI one-shot refuses a write without approval and --yes enables it explicitly', async t => {
  const { cwd } = await setup(t);
  let target = 'denied.txt';
  const { baseURL } = await modelServer(t, (res, bodies) => {
    if (bodies.at(-1).messages.at(-1).role !== 'tool') send(res, { content: null, tool_calls: [call('write_file', { path: target, content: 'ok' })] }, 'tool_calls');
    else send(res, { content: 'İşlem sonucu alındı.' });
  });
  const run = extra => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.mjs', '--prompt', 'Yaz', '--no-stream', '--tool-mode', 'native', '--cwd', cwd, '--base-url', baseURL, ...extra],
      { env: { ...process.env, UMAY_API_KEY: 'mock', UMAY_SETTINGS: 'none.json' } });
    let stderr = '';
    child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', text => stderr += text);
    child.stdin.end(); child.on('error', reject); child.on('exit', code => resolve({ code, stderr }));
  });
  assert.equal((await run([])).code, 0);
  await assert.rejects(access(path.join(cwd, target)));
  target = 'approved.txt';
  assert.equal((await run(['--yes'])).code, 0);
  assert.equal(await readFile(path.join(cwd, target), 'utf8'), 'ok');
});

test('arguments a tool does not have are dropped with a note; tool errors read as plain sentences', async t => {
  const { tools, cwd } = await setup(t, { auto: true });
  const result = await tools.write_file.execute({ path: 'a.txt', content: 'veri', project_name: 'oyun' });
  assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'veri');
  assert.match(result, /yok sayıldı: project_name/);
  const missing = await tools.read_file.execute({ path: 'yok.txt' });
  assert.match(missing, /^Hata: /);
  assert.doesNotMatch(missing, /ToolError/);
});
