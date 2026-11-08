// Files attached to the next message, and GitHub repositories imported as a working folder.
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_LIMIT = 60_000;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache']);

export class UserError extends Error {}

// Umay API ignored image parts in the live test of 8 Nov 2026, so images are opt-in until it supports them.
export async function loadAttachment(file, cwd, { images = process.env.UMAY_IMAGES === '1' } = {}) {
  const full = path.resolve(cwd, file.replace(/^["']|["']$/g, ''));
  let info;
  try { info = await stat(full); } catch { throw new UserError(`Dosya bulunamadı: ${full}`); }
  if (info.isDirectory()) throw new UserError('Klasör eklenemez. Klasörde çalışmak için /cd, depo için /github kullan.');
  const name = path.basename(full);
  const ext = path.extname(full).toLowerCase();
  if (IMAGE_TYPES[ext]) {
    if (!images) {
      throw new UserError('Umay API şu an görselleri işlemiyor: 8 Kasım 2026 denemesinde model gönderilen görseli göremedi. ' +
        'Görsel analizi için umayzeka.com sitesini kullan. Umay API görsel desteği eklerse UMAY_IMAGES=1 ile açılabilir.');
    }
    if (info.size > IMAGE_LIMIT) throw new UserError('Görsel 8 MB sınırını aşıyor.');
    return { kind: 'image', name, path: full, mediaType: IMAGE_TYPES[ext], data: (await readFile(full)).toString('base64'), size: info.size };
  }
  const buffer = await readFile(full);
  let text;
  if (ext === '.docx') text = await docxText(buffer);
  else if (ext === '.xlsx') text = await xlsxText(buffer);
  else if (ext === '.pptx') text = await pptxText(buffer);
  else if (buffer.subarray(0, 8000).includes(0)) {
    throw new UserError(ext === '.pdf'
      ? 'PDF dosyaları okunamıyor. Metnini .txt olarak kaydedip ekleyebilirsin.'
      : 'Bu dosya metin değil. Metin, kod, Word, Excel, PowerPoint veya görsel ekleyebilirsin.');
  } else text = buffer.toString('utf8').replace(/^﻿/, '');
  const truncated = text.length > TEXT_LIMIT;
  if (truncated) text = text.slice(0, TEXT_LIMIT) + `\n... [kesildi: ${text.length - TEXT_LIMIT} karakter daha var]`;
  return { kind: 'text', name, path: full, text, size: info.size, truncated };
}

const decode = xml => xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export async function docxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new UserError('Word belgesi okunamadı.');
  return decode(xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}

async function pptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/g).at(-1)) - Number(b.match(/\d+/g).at(-1)));
  const parts = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name).async('string');
    parts.push(`## Slayt ${i + 1}\n` + decode(xml.replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, '')).trim());
  }
  return parts.join('\n\n');
}

async function xlsxText(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const parts = [];
  workbook.eachSheet(sheet => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, row => {
      if (rows.length < 500) rows.push(row.values.slice(1).map(cell => cellText(cell)).join(' | '));
    });
    parts.push(`## Sayfa: ${sheet.name}\n${rows.join('\n')}`);
  });
  return parts.join('\n\n');
}

function cellText(cell) {
  if (cell === null || cell === undefined) return '';
  if (typeof cell !== 'object') return String(cell);
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if ('result' in cell) return String(cell.result ?? '');
  if ('text' in cell) return String(cell.text);
  if ('richText' in cell) return cell.richText.map(part => part.text).join('');
  return JSON.stringify(cell);
}

// Text attachments go into the message text; images become image parts.
export function buildUserContent(text, attachments = []) {
  if (!attachments.length) return text;
  const files = attachments.filter(item => item.kind === 'text');
  const images = attachments.filter(item => item.kind === 'image');
  let body = text.trim() || (images.length ? 'Bu görseli detaylı analiz et.' : 'Eklenen dosyayı detaylı analiz et.');
  for (const [i, file] of files.entries()) body += `\n\n[EK ${i + 1}: ${file.name}]\n${file.text}\n[/EK ${i + 1}]`;
  if (!images.length) return body;
  return [{ type: 'text', text: body }, ...images.map(image => ({ type: 'file', data: image.data, mediaType: image.mediaType }))];
}

export function parseGitHub(input) {
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!match || ['.', '..'].includes(match[2])) {
    throw new UserError('GitHub adresi anlaşılamadı. Örnek: /github https://github.com/kullanici/depo veya /github kullanici/depo');
  }
  return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}.git` };
}

export async function importGitHub(input, cwd, { signal, git = 'git' } = {}) {
  const { owner, repo, url } = parseGitHub(input);
  let dir = path.join(cwd, repo);
  let reused = false;
  if (existsSync(dir)) {
    if (existsSync(path.join(dir, '.git')) && (await gitOutput(git, ['-C', dir, 'remote', 'get-url', 'origin'], signal).catch(() => '')).trim().replace(/\.git$/, '') === url.replace(/\.git$/, '')) {
      reused = true;
    } else {
      let n = 2;
      while (existsSync(`${dir}-${n}`)) n++;
      dir = `${dir}-${n}`;
    }
  }
  if (!reused) await gitOutput(git, ['clone', '--depth', '1', '--quiet', url, dir], signal);
  const { lines, count } = await tree(dir);
  let readme = '';
  const readmeName = (await readdir(dir)).find(name => /^readme(\.md|\.txt|\.rst)?$/i.test(name));
  if (readmeName) readme = (await readFile(path.join(dir, readmeName), 'utf8')).slice(0, 8000);
  const text = `GitHub deposu ${owner}/${repo} şu klasöre ${reused ? 'daha önce indirilmişti' : 'indirildi'}: ${dir}\n` +
    `Araçların çalışma klasörü bu depo. Dosyaları read_file/list_dir/search_files ile incele.\n\n` +
    `Dosya ağacı (${count} dosya${lines.length < count ? `, ilk ${lines.length}` : ''}):\n${lines.join('\n')}` +
    (readme ? `\n\n${readmeName}:\n${readme}` : '');
  return { dir, name: `${owner}/${repo}`, reused, files: count,
    attachment: { kind: 'text', name: `GitHub: ${owner}/${repo}`, text } };
}

function gitOutput(git, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(git, args, { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', data => out += data);
    child.stderr.setEncoding('utf8').on('data', data => err += data);
    child.on('error', error => reject(error.code === 'ENOENT' ? new UserError('git bulunamadı. Git for Windows kurulu olmalı.') : error));
    child.on('close', code => code === 0 ? resolve(out) : reject(new UserError(
      /not found|could not read|Authentication|Repository not found/i.test(err)
        ? 'Depo bulunamadı veya gizli. Yalnızca herkese açık depolar içe aktarılabilir.'
        : `git hatası: ${err.trim().split('\n').at(-1) || `çıkış kodu ${code}`}`)));
  });
}

async function tree(dir, limit = 250) {
  const lines = [];
  let count = 0;
  const walk = async (folder, depth) => {
    const entries = (await readdir(folder, { withFileTypes: true }))
      .filter(entry => !SKIP.has(entry.name))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (lines.length < limit) lines.push(`${'  '.repeat(depth)}${entry.name}/`);
        await walk(full, depth + 1);
      } else {
        count++;
        if (lines.length < limit) lines.push(`${'  '.repeat(depth)}${entry.name}`);
      }
    }
  };
  await walk(dir, 0);
  return { lines, count };
}
