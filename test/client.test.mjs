import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chat, friendlyError, validateBaseURL } from '../src/client.mjs';

const apiKey = 'test-key-do-not-use';
const messages = [{ role: 'system', content: 'Türkçe yanıt ver.' }, { role: 'user', content: 'Merhaba' }];
const response = (content = 'Merhaba! Türkçe konuşabiliriz.') => ({
  id: 'test-1', object: 'chat.completion', model: 'umay-akilli', created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 },
});
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
};
const sse = (res, delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
  id: 'test-1', choices: [{ index: 0, delta, finish_reason }],
}) + '\n\n');

async function serverFor(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test('POST, Bearer authentication, model, history and JSON response', async t => {
  const { baseURL, requests } = await serverFor(t, (_req, res) => json(res, response()));
  const output = [];
  const result = await chat({ apiKey, baseURL, messages, stream: false, onText: text => output.push(text) });
  assert.equal(result.text, 'Merhaba! Türkçe konuşabiliriz.');
  assert.equal(output.join(''), result.text);
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(requests[0].body.model, 'umay-akilli');
  assert.deepEqual(requests[0].body.messages, messages);
  assert.ok(!requests[0].body.stream);
});

test('SSE streaming preserves Turkish text across network chunks', async t => {
  const { baseURL, requests } = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { role: 'assistant', content: '' });
    const event = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'İyi günler, ' } }] }) + '\n\n');
    const cut = event.indexOf(Buffer.from('İ')) + 1;
    res.write(event.subarray(0, cut));
    setTimeout(() => {
      res.write(event.subarray(cut));
      sse(res, { content: 'nasılsın?' });
      sse(res, {}, 'stop');
      res.end('data: [DONE]\n\n');
    }, 5);
  });
  const parts = [];
  const result = await chat({ apiKey, baseURL, messages, onText: text => parts.push(text) });
  assert.equal(result.text, 'İyi günler, nasılsın?');
  assert.equal(parts.join(''), result.text);
  assert.ok(parts.length >= 2);
  assert.equal(requests[0].body.stream, true);
  assert.equal(result.finishReason, 'stop');
});

test('authentication, quota and maintenance errors do not retry or expose the key', async t => {
  for (const status of [401, 403, 429, 503]) {
    await t.test(String(status), async t => {
      const { baseURL, requests } = await serverFor(t, (_req, res) => json(res, {
        error: { message: `Private diagnostic ${apiKey}`, type: 'invalid_request_error' },
      }, status));
      await assert.rejects(chat({ apiKey, baseURL, messages, stream: false }), error => {
        const text = friendlyError(error, apiKey);
        assert.ok(!text.includes(apiKey));
        assert.match(text, /anahtar|Erişim|kota|bakım/);
        return true;
      });
      assert.equal(requests.length, 1);
    });
  }
});

test('HTML responses are errors even with HTTP 200', async t => {
  const { baseURL } = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>Login</html>');
  });
  await assert.rejects(chat({ apiKey, baseURL, messages, stream: false }), error => {
    assert.match(friendlyError(error), /web sayfası/); return true;
  });
});

test('401 points out a key that is not an Umay key, without revealing it', () => {
  const key = 'other_live_private-test-value';
  const text = friendlyError({ statusCode: 401 }, key);
  assert.match(text, /HTTP 401/);
  assert.match(text, /umay-sk- ile başlamıyor/);
  assert.ok(!text.includes(key));
  assert.doesNotMatch(friendlyError({ statusCode: 401 }, 'umay-sk-test'), /başlamıyor/);
});

test('redirects are not followed with credentials', async t => {
  const { baseURL, requests } = await serverFor(t, (_req, res) => {
    res.writeHead(302, { Location: '/destination' }); res.end();
  });
  await assert.rejects(chat({ apiKey, baseURL, messages, stream: false }));
  assert.equal(requests.length, 1);
});

test('broken JSON and empty responses fail', async t => {
  for (const body of ['{broken', JSON.stringify(response(''))]) {
    await t.test(body.slice(0, 20), async t => {
      const { baseURL } = await serverFor(t, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body);
      });
      await assert.rejects(chat({ apiKey, baseURL, messages, stream: false }));
    });
  }
});

test('an error after partial streamed output is not a successful response', async t => {
  const { baseURL } = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { content: 'Yarım yanıt' });
    res.end('data: ' + JSON.stringify({ error: { message: 'Failure', type: 'server_error' } }) + '\n\n');
  });
  const partial = [];
  await assert.rejects(chat({ apiKey, baseURL, messages, onText: text => partial.push(text) }));
  assert.equal(partial.join(''), 'Yarım yanıt');
});

test('a truncated event stream fails', async t => {
  const { baseURL } = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { content: 'Yarım yanıt' }); res.end();
  });
  await assert.rejects(chat({ apiKey, baseURL, messages }));
});

test('timeouts and cancellation end pending requests', async t => {
  const { baseURL } = await serverFor(t, () => {});
  await assert.rejects(chat({ apiKey, baseURL, messages, timeout: 30 }), error => error.name === 'TimeoutError');
  const abort = new AbortController();
  const pending = chat({ apiKey, baseURL, messages, signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('the time limit counts silence from the server, not the length of an answer', async t => {
  // Twelve chunks 60 ms apart: longer in total than the limit, but never silent for that long.
  const steady = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      sse(res, { content: `p${sent} ` });
      if (++sent === 12) { clearInterval(timer); sse(res, {}, 'stop'); res.end('data: [DONE]\n\n'); }
    }, 60);
  });
  const result = await chat({ apiKey, baseURL: steady.baseURL, messages, timeout: 400 });
  assert.equal(result.text.trim().split(' ').length, 12);
  // A stream that starts and then goes silent still ends with a timeout.
  const stalled = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { content: 'başladı' });
  });
  await assert.rejects(chat({ apiKey, baseURL: stalled.baseURL, messages, timeout: 150 }), error => error.name === 'TimeoutError');
});

test('failures inside an HTTP 200 stream are explained, with the message Umay sent', async t => {
  const failing = async (handler, pattern) => {
    const { baseURL } = await serverFor(t, handler);
    await assert.rejects(chat({ apiKey, baseURL, messages }), error => { assert.match(friendlyError(error, apiKey), pattern); return true; });
  };
  await failing((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ error: { message: `Yapay zeka servisleri şu anda yanıt veremiyor ${apiKey}`, type: 'server_error' } }) + '\n\n');
  }, /^Umay sunucusu hata bildirdi: Yapay zeka servisleri şu anda yanıt veremiyor \[gizli\]$/);
  await failing((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(); },
    /hiçbir şey göndermeden bağlantıyı kapattı/);
  await failing((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { content: 'Yarım yanıt' }); res.end();
  }, /Yanıt tamamlanmadan kesildi/);
  await failing((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { content: 'Yarım yanıt' });
    setTimeout(() => res.destroy(), 30);
  }, /Bağlantı yanıt tamamlanmadan koptu/);
});

test('URL validation allows HTTPS or loopback HTTP only', () => {
  assert.equal(validateBaseURL('https://umayzeka.com/v1/'), 'https://umayzeka.com/v1');
  assert.equal(validateBaseURL('http://localhost:123/v1'), 'http://localhost:123/v1');
  for (const url of ['http://example.com/v1', 'file:///tmp/test', 'https://user:pass@example.com', 'https://example.com?key=secret']) {
    assert.throws(() => validateBaseURL(url));
  }
});

function runCLI(args, env = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.mjs', ...args], {
      cwd: new URL('../', import.meta.url), env: { ...process.env, UMAY_API_KEY: apiKey, NO_COLOR: '1', UMAY_SETTINGS: 'none.json', ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => stdout += data);
    child.stderr.setEncoding('utf8').on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('CLI one-shot and piped input work end to end', async t => {
  const { baseURL, requests } = await serverFor(t, (_req, res) => json(res, response('İşte yanıt.')));
  const oneShot = await runCLI(['--prompt', 'Bir soru', '--no-stream', '--base-url', baseURL]);
  assert.equal(oneShot.code, 0);
  assert.equal(oneShot.stdout, 'İşte yanıt.\n');
  assert.equal(oneShot.stderr, '');
  const piped = await runCLI(['--no-stream', '--base-url', baseURL], {}, 'Çok satırlı\nbir soru');
  assert.equal(piped.code, 0);
  assert.equal(requests[1].body.messages.at(-1).content, 'Çok satırlı\nbir soru');
});

test('CLI failure exits nonzero and never echoes credentials', async t => {
  const { baseURL } = await serverFor(t, (_req, res) => json(res, { error: { message: apiKey } }, 401));
  const result = await runCLI(['--prompt', 'Test', '--no-stream', '--base-url', baseURL]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /anahtarı kabul edilmedi/);
  assert.ok(!result.stdout.includes(apiKey) && !result.stderr.includes(apiKey));
});

test('CLI help needs no key and invalid settings fail before a network call', async () => {
  const help = await runCLI(['--help'], { UMAY_API_KEY: '' });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Komutlar/);
  assert.match(help.stdout, /--prompt/);
  const missing = await runCLI(['--prompt', 'Test'], { UMAY_API_KEY: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /UMAY_API_KEY/);
  const invalid = await runCLI(['--timeout', 'no']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /timeout/);
});
