import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyKey } from '../src/client.mjs';

const KEY = 'umay-sk-test-anahtar-0123456789';

// The keystore reads UMAY_SETTINGS and UMAY_KEYSTORE_PLATFORM on every call, so each test points it at its own folder.
async function sandbox(t, platform) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umay-anahtar-'));
  const before = { settings: process.env.UMAY_SETTINGS, platform: process.env.UMAY_KEYSTORE_PLATFORM };
  process.env.UMAY_SETTINGS = path.join(dir, 'ayarlar.json');
  if (platform) process.env.UMAY_KEYSTORE_PLATFORM = platform; else delete process.env.UMAY_KEYSTORE_PLATFORM;
  t.after(async () => {
    for (const [name, value] of [['UMAY_SETTINGS', before.settings], ['UMAY_KEYSTORE_PLATFORM', before.platform]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store: await import('../src/keystore.mjs') };
}

test('Windows: the key is saved encrypted with DPAPI and read back', { skip: process.platform !== 'win32' }, async t => {
  const { dir, store } = await sandbox(t);
  assert.equal(await store.loadKey(), null);
  await store.saveKey(KEY);
  const file = path.join(dir, 'anahtar.dpapi');
  const saved = await readFile(file, 'utf8');
  assert.ok(!saved.includes(KEY) && !saved.includes('umay-sk'), 'the file must not hold the key in the clear');
  assert.match(saved.trim(), /^[A-Za-z0-9+/]+=*$/);
  assert.equal(await store.loadKey(), KEY);
  assert.equal(await store.deleteKey(), true);
  assert.equal(existsSync(file), false);
  assert.equal(await store.loadKey(), null);
  assert.equal(await store.deleteKey(), false);
});

test('Windows: a damaged key file counts as no key', { skip: process.platform !== 'win32' }, async t => {
  const { dir, store } = await sandbox(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'anahtar.dpapi'), 'AQAAAbozuk==\n');
  assert.equal(await store.loadKey(), null);
});

test('Other systems: the key is kept in a file and keys with spaces or quotes are refused', async t => {
  const { dir, store } = await sandbox(t, 'linux');
  await store.saveKey(`  ${KEY}\n`);
  assert.equal((await readFile(path.join(dir, 'anahtar'), 'utf8')).trim(), KEY);
  assert.equal(await store.loadKey(), KEY);
  await assert.rejects(store.saveKey(''), /Boş/);
  await assert.rejects(store.saveKey('umay-sk-a"b'), /tırnak/);
  await assert.rejects(store.saveKey('umay sk'), /boşluk/);
});

async function server(t, handler) {
  const requests = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk).on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      handler(req, res);
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => srv.close());
  return { baseURL: `http://127.0.0.1:${srv.address().port}/v1`, requests };
}
const reply = (res, status, body = {}) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('verifyKey sends an empty chat request: 401 means refused, 400 accepted, anything else unknown', async t => {
  // Umay checks the key before the body, so a request without messages reaches no model.
  const umay = await server(t, (req, res) => req.headers.authorization === `Bearer ${KEY}`
    ? reply(res, 400, { error: { message: "Geçersiz istek. 'messages' dizisi zorunludur." } })
    : reply(res, 401, { error: { code: 'invalid_api_key' } }));
  assert.equal(await verifyKey({ apiKey: KEY, baseURL: umay.baseURL, model: 'umay-hizli' }), true);
  assert.equal(await verifyKey({ apiKey: 'umay-sk-yanlis', baseURL: umay.baseURL }), false);
  assert.deepEqual(umay.requests.map(r => `${r.method} ${r.url}`), ['POST /v1/chat/completions', 'POST /v1/chat/completions']);
  assert.deepEqual(umay.requests[0].body, { model: 'umay-hizli', messages: [] });
  assert.equal(umay.requests[0].auth, `Bearer ${KEY}`);

  const odd = await server(t, (_req, res) => reply(res, 500));
  assert.equal(await verifyKey({ apiKey: KEY, baseURL: odd.baseURL }), null);
  assert.equal(await verifyKey({ apiKey: KEY, baseURL: 'http://127.0.0.1:9/v1' }), null);
});

test('CLI uses the stored key when UMAY_API_KEY is not set, and the environment wins when it is', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umay-anahtar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'anahtar'), `${KEY}\n`);
  const api = await server(t, (_req, res) => reply(res, 200, {
    id: 'x', object: 'chat.completion', model: 'umay-akilli', created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Tamam.' }, finish_reason: 'stop' }],
  }));
  const run = env => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.mjs', '--prompt', 'sa', '--no-tools', '--no-stream', '--base-url', api.baseURL], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, NO_COLOR: '1', UMAY_SETTINGS: path.join(dir, 'ayarlar.json'), UMAY_KEYSTORE_PLATFORM: 'linux', UMAY_THINKING: '', ...env },
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', data => out += data);
    child.stderr.setEncoding('utf8').on('data', data => out += data);
    child.on('error', reject).on('close', code => resolve({ code, out }));
    child.stdin.end();
  });
  assert.deepEqual(await run({ UMAY_API_KEY: '' }), { code: 0, out: 'Tamam.\n' });
  assert.equal(api.requests[0].auth, `Bearer ${KEY}`);
  assert.equal((await run({ UMAY_API_KEY: 'ortamdaki-anahtar' })).code, 0);
  assert.equal(api.requests[1].auth, 'Bearer ortamdaki-anahtar');
  await rm(path.join(dir, 'anahtar'));
  const missing = await run({ UMAY_API_KEY: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /bir kez anahtarını gir/);
});
