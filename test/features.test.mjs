import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { chat, thinkSplitter, friendlyError } from '../src/client.mjs';
import { markdownStream, styleText } from '../src/markdown.mjs';
import { generate, parseProject, slugify, extractJson } from '../src/documents.mjs';
import { loadAttachment, buildUserContent, parseGitHub } from '../src/attachments.mjs';

async function folder(t) {
  const base = path.resolve('.test-tmp');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'feat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function server(t, handler) {
  const bodies = [];
  const http = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    handler(res, bodies);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  return { baseURL: `http://127.0.0.1:${http.address().port}/v1`, bodies };
}
const reply = (res, content) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
};

test('markdown stream wraps paragraphs, draws lists and tables, and passes through without color', () => {
  let out = '';
  const md = markdownStream(text => { out += text; }, { styled: true, width: () => 40 });
  const source = '## Başlık\nBu cümle kırk karakterlik bir terminalde iki satıra bölünmelidir.\n- bir\n  - iki\n| Ad | Puan |\n|---|---|\n| Ayşe | 90 |\nson';
  for (let i = 0; i < source.length; i += 2) md.push(source.slice(i, i + 2));
  md.end();
  const lines = out.split('\n');
  assert.equal(lines[0], '  Başlık');
  assert.ok(lines.every(line => line.length <= 40), out);
  assert.match(out, /\n {2}• bir\n {4}• iki\n/);
  assert.match(out, /│ Ayşe │ 90 {3}│/);
  assert.match(out, /└─+┴─+┘\n {2}son\n$/);
  let raw = '';
  const plain = markdownStream(text => { raw += text; }, { styled: false });
  plain.push(source); plain.end();
  assert.equal(raw, source);
  assert.deepEqual(styleText('**a** `b` [c](https://x.y)', {}), { text: 'a b c (https://x.y)', plain: 'a b c (https://x.y)', size: 19 });
});

test('think tags are routed to reasoning even when split across chunks', () => {
  const shown = [], thought = [];
  const split = thinkSplitter(text => shown.push(text), text => thought.push(text));
  for (const chunk of ['<thi', 'nk>önce düşün', 'eyim</th', 'ink>Cevap: ', '42']) split.push(chunk);
  assert.equal(split.end(), 'Cevap: 42');
  assert.equal(shown.join(''), 'Cevap: 42');
  assert.equal(thought.join(''), 'önce düşüneyim');
});

test('thinking mode adds enable_thinking and shows reasoning_content separately', async t => {
  const { baseURL, bodies } = await server(t, (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n');
    event({ reasoning_content: 'Soruyu inceliyorum.' });
    event({ content: 'Merhaba!' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  const reasoning = [];
  const result = await chat({ apiKey: 'k', baseURL, thinking: true, messages: [{ role: 'user', content: 'sa' }],
    onReasoning: text => reasoning.push(text) });
  assert.equal(bodies[0].enable_thinking, true);
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: true });
  assert.equal(result.text, 'Merhaba!');
  assert.equal(reasoning.join(''), 'Soruyu inceliyorum.');
  await chat({ apiKey: 'k', baseURL, messages: [{ role: 'user', content: 'sa' }] });
  assert.equal(bodies[1].enable_thinking, undefined, 'nothing extra is sent when thinking is off');
});

test('generators build real Office files and repair one malformed reply', async t => {
  const dir = await folder(t);
  const replies = ['Tabii, işte sunum!', '{"title": "Eğitim", "slides": [{"title": "Giriş", "bullets": ["Bir", "İki"]}]}'];
  const sent = [];
  const pptx = await generate('sunum', { topic: 'Eğitim', cwd: dir, ask: async list => { sent.push(list); return replies.shift(); } });
  assert.equal(sent.length, 2, 'one repair request');
  assert.match(sent[1].at(-1).content, /işlenemedi/);
  const slides = Object.keys((await JSZip.loadAsync(await readFile(pptx.file))).files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 3, 'cover, one content slide, closing');

  const docx = await generate('dokuman', { topic: 'Dilekçe', cwd: dir,
    ask: async () => '# Dilekçe\n\n## Konu\n\nYol onarımı hakkında **önemli** talep.\n\n- Asfalt\n\n| A | B |\n|---|---|\n| 1 | 2 |' });
  const word = await loadAttachment(docx.file, dir);
  assert.match(word.text, /Dilekçe[\s\S]*Yol onarımı hakkında önemli talep/);

  const xlsx = await generate('rapor', { topic: 'Satış', cwd: dir,
    ask: async () => '{"title": "Satış", "sheets": [{"name": "Ocak/Şubat", "columns": ["Ay", "Tutar"], "rows": [["Ocak", 10], ["Şubat", "12,5"]], "totals": true}]}' });
  const sheet = await loadAttachment(xlsx.file, dir);
  assert.match(sheet.text, /Sayfa: Ocak Şubat[\s\S]*Ay \| Tutar[\s\S]*Şubat \| 12\.5[\s\S]*TOPLAM \| 22\.5/);

  const diagram = await generate('sema', { topic: 'Akış', cwd: dir, ask: async () => 'Başlık: Sipariş\n```mermaid\nflowchart TD\n  A["<b>x</b>"] --> B\n```' });
  const html = await readFile(diagram.file, 'utf8');
  assert.match(html, /<pre class="mermaid">flowchart TD\n {2}A\[&quot;&lt;b&gt;x&lt;\/b&gt;&quot;\]/);
  assert.equal(path.basename(diagram.file), 'siparis.html');

  const project = await generate('proje', { topic: 'Sayaç', cwd: dir,
    ask: async () => 'PROJE: Sayaç Uygulaması\nDOSYA: index.html\n```html\n<h1>Hi</h1>\n```\nDOSYA: js/app.js\n```js\nconsole.log(1)\n```' });
  assert.equal(await readFile(path.join(dir, 'sayac-uygulamasi', 'js', 'app.js'), 'utf8'), 'console.log(1)\n');
  const zip = await JSZip.loadAsync(await readFile(path.join(dir, 'sayac-uygulamasi.zip')));
  assert.ok(zip.file('sayac-uygulamasi/index.html'));
});

test('project paths cannot escape the project folder and names are safe', () => {
  assert.throws(() => parseProject('DOSYA: a/../../x.html\n```html\nx\n```', 'p'), /geçersiz/);
  // Labels that are not plain relative names are ignored, so the block falls back to a safe default name.
  for (const label of ['../x.html', 'C:/x/index.html', '/etc/x.html']) {
    assert.deepEqual(parseProject(`DOSYA: ${label}\n\`\`\`html\nx\n\`\`\``, 'p').files.map(file => file.path), ['index.html']);
  }
  assert.deepEqual(parseProject('```html:../../x.html\nx\n```', 'p').files.map(file => file.path), ['x.html']);
  assert.throws(() => parseProject('DOSYA: style.css\n```css\nx\n```', 'p'), /HTML dosyası yok/);
  assert.equal(slugify('Çığ Öğrenci Şöleni: 2026!'), 'cig-ogrenci-soleni-2026');
  assert.equal(slugify('Sipariş Süreci - Siparişten Teslimata Kadar Akış Şeması'), 'siparis-sureci-siparisten-teslimata-kadar-akis');
  assert.deepEqual(extractJson('Önce metin ```json\n{"a": "}"}\n``` sonra'), { a: '}' });
});

test('project parser accepts the layouts models write instead of DOSYA:', () => {
  const variants = parseProject([
    'PROJE: **sayac**', '### 1. `index.html`', '```html', '<h1>a</h1>', '```',
    '**style.css**', '```css', 'h1{}', '```', '```js:js/app.js', 'go()', '```', 'Kısa açıklama.',
  ].join('\n'), 'x');
  assert.equal(variants.name, 'sayac');
  assert.deepEqual(variants.files.map(file => file.path), ['index.html', 'style.css', 'js/app.js']);
  assert.equal(variants.summary, 'Kısa açıklama.');
  const unnamed = parseProject('İşte proje:\n```html\n<p>x</p>\n```\n```css\np{}\n```\n```javascript\nrun()\n```', 'x');
  assert.deepEqual(unnamed.files.map(file => file.path), ['index.html', 'style.css', 'script.js']);
  assert.throws(() => parseProject('DOSYA: index.html\n```html\n<html><body>yarım', 'x'), /yarıda kesildi/);
});

test('a reply cut at the length limit asks for a shorter one; repeated failure saves the raw replies', async t => {
  const dir = await folder(t);
  const sent = [];
  const failureFile = path.join(dir, 'hata', 'son.txt');
  await assert.rejects(generate('proje', { topic: 'Sayaç', cwd: dir, failureFile,
    ask: async (list, gen) => { sent.push({ list, gen }); return { text: 'DOSYA: index.html\n```html\n<html>', finishReason: 'length' }; } }),
  error => /uzunluk sınırında kesildi/.test(error.message) && error.message.includes(failureFile));
  assert.match(sent[0].list[0].content, /Bugünün tarihi: \d+ \S+ \d{4}/);
  assert.equal(sent[0].gen.noThinking, true);
  assert.match(sent[1].list.at(-1).content, /uzunluk sınırında kesildi\. Projeyi daha kısa yaz/);
  const saved = await readFile(failureFile, 'utf8');
  assert.match(saved, /\/proje Sayaç[\s\S]*Yanıt 1 \(bitiş: length[\s\S]*Yanıt 2/);
});

test('wide table cells wrap inside their column instead of being cut', () => {
  let out = '';
  const md = markdownStream(text => { out += text; }, { styled: true, width: () => 40 });
  md.push('| Alan | Açıklama |\n|---|---|\n| Risk | Teknolojik borç erken ödenmezse yeniden yazım gerekir<br>İkinci satır |\n');
  md.end();
  assert.ok(!out.includes('…'), out);
  assert.ok(out.split('\n').every(line => line.length <= 40), out);
  assert.match(out, /│ Risk │ Teknolojik borç erken +│\n {2}│ {6}│ ödenmezse yeniden yazım +│\n {2}│ {6}│ gerekir +│\n {2}│ {6}│ İkinci satır +│/);
});

test('attachments: text, Word read-back, binary refusal, image parts', async t => {
  const dir = await folder(t);
  await writeFile(path.join(dir, 'not.txt'), '\uFEFFmerhaba dünya');
  await writeFile(path.join(dir, 'veri.bin'), Buffer.from([1, 0, 2, 3]));
  await writeFile(path.join(dir, 'resim.png'), Buffer.from([137, 80, 78, 71]));
  const text = await loadAttachment('not.txt', dir);
  assert.equal(text.text, 'merhaba dünya');
  await assert.rejects(loadAttachment('veri.bin', dir), /metin değil/);
  await assert.rejects(loadAttachment('yok.txt', dir), /bulunamadı/);
  await assert.rejects(loadAttachment('resim.png', dir), /görselleri işlemiyor/);
  const image = await loadAttachment('resim.png', dir, { images: true });
  const content = buildUserContent('Bu ne?', [text, image]);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /^Bu ne\?\n\n\[EK 1: not\.txt\]\nmerhaba dünya\n\[\/EK 1\]$/);
  assert.deepEqual(content[1], { type: 'file', data: image.data, mediaType: 'image/png' });
  assert.equal(buildUserContent('düz', []), 'düz');
});

test('GitHub addresses are parsed strictly', () => {
  assert.deepEqual(parseGitHub('https://github.com/octocat/Hello-World'), { owner: 'octocat', repo: 'Hello-World', url: 'https://github.com/octocat/Hello-World.git' });
  assert.equal(parseGitHub('octocat/Hello-World.git').repo, 'Hello-World');
  for (const bad of ['https://evil.com/a/b', 'a/..', 'octocat', 'https://github.com/a/b; rm -rf /']) assert.throws(() => parseGitHub(bad));
});

test('CLI one-shot generator command writes the file into --cwd', async t => {
  const dir = await folder(t);
  const { baseURL, bodies } = await server(t, res => reply(res,
    '{"title": "Kitap Listesi", "sheets": [{"name": "Kitaplar", "columns": ["Ad", "Sayfa"], "rows": [["Nutuk", 600]]}]}'));
  const child = spawn(process.execPath, ['src/cli.mjs', '--prompt', '/rapor kitap listesi', '--no-tools', '--no-stream', '--cwd', dir, '--base-url', baseURL],
    { env: { ...process.env, UMAY_API_KEY: 'mock', NO_COLOR: '1', UMAY_SETTINGS: 'none.json' } });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => stdout += data);
  child.stderr.setEncoding('utf8').on('data', data => stderr += data);
  child.stdin.end();
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.match(bodies[0].messages[0].content, /Excel/);
  assert.ok((await readdir(dir)).includes('kitap-listesi.xlsx'));
  assert.match(stdout, /kitap-listesi\.xlsx/);
  await access(path.join(dir, 'kitap-listesi.xlsx'));
});

test('footer shows tokens, and speed for streamed answers, only when the server reports usage', async () => {
  const { formatStats } = await import('../src/theme.mjs');
  assert.equal(formatStats(4.24, undefined, { generationMs: 3000 }), 'süre 4.2 sn');
  assert.equal(formatStats(4.24, { inputTokens: 2900, outputTokens: 222 }, { generationMs: 3000, streamed: true }),
    'süre 4.2 sn · 222 token · 74 tok/sn');
  assert.equal(formatStats(2.3, { inputTokens: 3, outputTokens: 42 }, { generationMs: 2300, streamed: false }), 'süre 2.3 sn · 42 token',
    'without streaming the time includes waiting, so no speed');
});

test('streamed requests ask for usage and report speed and conversation size', async t => {
  const { baseURL, bodies } = await server(t, res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    event({ choices: [{ delta: { content: 'Mer' }, finish_reason: null }] });
    setTimeout(() => {
      event({ choices: [{ delta: { content: 'haba' }, finish_reason: 'stop' }] });
      event({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } });
      res.end('data: [DONE]\n\n');
    }, 30);
  });
  const result = await chat({ apiKey: 'k', baseURL, messages: [{ role: 'user', content: 'sa' }] });
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.equal(result.usage.outputTokens, 20);
  assert.equal(result.stats.contextTokens, 70);
  assert.equal(result.stats.streamed, true);
  assert.ok(result.stats.generationMs >= 20, String(result.stats.generationMs));
});

// The rejection is remembered for the rest of this process; later tests must not depend on stream_options.
test('a server that rejects stream_options gets the request again without it', async t => {
  const { baseURL, bodies } = await server(t, (res, bodies) => {
    if (bodies.at(-1).stream_options) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unrecognized field stream_options' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Tamam' }, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  const first = await chat({ apiKey: 'k', baseURL, messages: [{ role: 'user', content: 'sa' }] });
  assert.equal(first.text, 'Tamam');
  assert.deepEqual(bodies.map(body => Boolean(body.stream_options)), [true, false]);
  await chat({ apiKey: 'k', baseURL, messages: [{ role: 'user', content: 'sa' }] });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].stream_options, undefined, 'not asked again after a rejection');
});

test('an empty answer cut at the length limit is explained, not reported as an empty reply', async t => {
  const { baseURL } = await server(t, res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'uzun uzun düşünüyorum' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await assert.rejects(chat({ apiKey: 'k', baseURL, stream: true, messages: [{ role: 'user', content: 'x' }] }),
    error => /uzunluk sınırına cevap yazamadan/.test(friendlyError(error)));
});
