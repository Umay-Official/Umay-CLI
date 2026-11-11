import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listModels, probeModel } from '../src/client.mjs';

const LIST = { object: 'list', data: [
  { id: 'umay-akilli', object: 'model', owned_by: 'umay' },
  { id: 'umay-ultra-hizli', object: 'model', owned_by: 'umay' },
  { id: 'umay-mistral-large', object: 'model', owned_by: 'umay' },
  { id: 'mistralai/mistral-large-4-1t-a52b', object: 'model', owned_by: 'mistralai' },
] };
const completion = (content, model) => ({ id: 'x', object: 'chat.completion', model, created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });

async function server(t, handler) {
  const requests = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk).on('end', () => {
      const request = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
      requests.push(request);
      handler(request, res);
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { baseURL: `http://127.0.0.1:${srv.address().port}/v1`, requests };
}
const reply = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

test('listModels reads ids and owners, and gives null for pages that are not a model list', async t => {
  const good = await server(t, (_req, res) => reply(res, 200, LIST));
  assert.deepEqual((await listModels({ baseURL: good.baseURL }))?.map(item => `${item.owner}:${item.id}`),
    ['umay:umay-akilli', 'umay:umay-ultra-hizli', 'umay:umay-mistral-large', 'mistralai:mistralai/mistral-large-4-1t-a52b']);
  // Unknown paths on umayzeka.com answer 200 with the site's HTML.
  const html = await server(t, (_req, res) => reply(res, 200, '<!DOCTYPE html><html></html>', 'text/html'));
  assert.equal(await listModels({ baseURL: html.baseURL }), null);
  const empty = await server(t, (_req, res) => reply(res, 200, { data: [] }));
  assert.equal(await listModels({ baseURL: empty.baseURL }), null);
  assert.equal(await listModels({ baseURL: 'http://127.0.0.1:9/v1' }), null);
});

test('probeModel reports the reply and the model that answered, waits out 429, and never throws', async t => {
  let calls = 0;
  const api = await server(t, (req, res) => {
    calls++;
    if (calls === 1) return reply(res, 429, { error: { code: 'rate_limit_exceeded' } });
    if (req.body.model === 'umay-daha-zeki') return reply(res, 200, completion('ANKARA', 'umay-ultra-hizli'));
    if (req.body.model === 'kirik') return reply(res, 524, '<html>524</html>', 'text/html');
    return reply(res, 200, completion('Crop $\\', req.body.model));
  });
  const routed = await probeModel({ apiKey: 'k', baseURL: api.baseURL, model: 'umay-daha-zeki' });
  assert.equal(routed.reply, 'ANKARA');
  assert.equal(routed.routed, 'umay-ultra-hizli');
  assert.equal(api.requests.length, 2, 'the 429 was sent again');
  assert.equal(api.requests[1].body.enable_thinking, false);
  assert.match(api.requests[1].body.messages[0].content, /ANKARA/);
  assert.equal((await probeModel({ apiKey: 'k', baseURL: api.baseURL, model: 'umay-akilli' })).reply, 'Crop $\\');
  const failed = await probeModel({ apiKey: 'k', baseURL: api.baseURL, model: 'kirik' });
  assert.equal(failed.status, 524);
  assert.equal(failed.error, 'HTTP 524');
  assert.equal((await probeModel({ apiKey: 'k', baseURL: 'http://127.0.0.1:9/v1', model: 'x' })).error, 'connection');
});

function runCLI(t, baseURL, args) {
  return new Promise(async (resolve, reject) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'umay-modeller-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const child = spawn(process.execPath, ['src/cli.mjs', '--no-tools', '--no-stream', '--base-url', baseURL, ...args], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, UMAY_API_KEY: 'mock', NO_COLOR: '1', UMAY_SETTINGS: path.join(dir, 'ayarlar.json'), UMAY_THINKING: '', UMAY_MODEL: '' },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => stdout += data);
    child.stderr.setEncoding('utf8').on('data', data => stderr += data);
    child.on('error', reject).on('close', async code => {
      let cache = null;
      try { cache = JSON.parse(await readFile(path.join(dir, 'modeller.json'), 'utf8')); } catch { /* none */ }
      resolve({ code, stdout, stderr, cache });
    });
    child.stdin.end();
  });
}

test('CLI turns a short model name into the id on Umay\'s list, keeps the list, and warns about unknown names', async t => {
  const api = await server(t, (req, res) => req.method === 'GET' ? reply(res, 200, LIST) : reply(res, 200, completion('Tamam.', req.body.model)));
  const short = await runCLI(t, api.baseURL, ['--model', 'mistral', '--prompt', 'sa']);
  assert.equal(short.code, 0, short.stderr);
  assert.equal(api.requests.at(-1).body.model, 'umay-mistral-large');
  assert.equal(short.cache?.length, 4);

  const full = await runCLI(t, api.baseURL, ['--model', 'mistralai/mistral-large-4-1t-a52b', '--prompt', 'sa']);
  assert.equal(api.requests.at(-1).body.model, 'mistralai/mistral-large-4-1t-a52b');
  assert.equal(full.stderr, '');

  const unknown = await runCLI(t, api.baseURL, ['--model', 'yok-boyle', '--prompt', 'sa']);
  assert.equal(unknown.code, 0);
  assert.match(unknown.stderr, /"yok-boyle" Umay'ın model listesinde yok/);

  // A known name needs no list: a quick question does not ask for it.
  const before = api.requests.length;
  await runCLI(t, api.baseURL, ['--model', 'ultra', '--prompt', 'sa']);
  assert.deepEqual(api.requests.slice(before).map(r => r.method), ['POST']);
});

test('/durum asks every Umay model once and tells working, broken and failing ones apart', async t => {
  const api = await server(t, (req, res) => {
    if (req.method === 'GET') return reply(res, 200, LIST);
    if (req.body.model === 'umay-ultra-hizli') return reply(res, 200, completion('ANKARA', 'umay-ultra-hizli'));
    if (req.body.model === 'umay-mistral-large') return reply(res, 503, { error: { message: 'bakımda' } });
    return reply(res, 200, completion('Crop $\\ végét', req.body.model));
  });
  const result = await runCLI(t, api.baseURL, ['--prompt', '/durum']);
  assert.equal(result.code, 0, result.stderr);
  const asked = api.requests.filter(r => r.method === 'POST').map(r => r.body.model).sort();
  assert.deepEqual(asked, ['umay-akilli', 'umay-mistral-large', 'umay-ultra-hizli'], 'provider names on the list are not asked again');
  assert.match(result.stdout, /◆ ✗ Umay Akıllı .* beklenmeyen yanıt: "Crop/);
  assert.match(result.stdout, /✓ Umay Ultra Hızlı .* çalışıyor/);
  assert.match(result.stdout, /✗ Mistral Large 4 .* sunucu hatası: bakımda/);
  assert.match(result.stdout, /1\/3 model düzgün yanıt verdi/);
  assert.match(result.stdout, /Çalışan birine geç: \/model ultra/);
});
