// Site-style generation commands built locally: the model writes structured text, the CLI builds the file.
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
  AlignmentType, ShadingType, Footer, PageNumber, BorderStyle,
} from 'docx';
import { buildUserContent, UserError } from './attachments.mjs';

const RED = 'E30A17';
const DARK_RED = 'A50710';
const INK = '1F2937';
const today = () => new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

export class FormatError extends Error {}

export function slugify(text, fallback = 'umay-belge') {
  const map = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
  const full = String(text).toLocaleLowerCase('tr').replace(/[çğıöşüâîû]/g, char => map[char])
    .normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  // Long titles are cut at a word boundary, not in the middle of a word.
  let slug = full.slice(0, 50);
  if (full.length > 50 && full[50] !== '-' && slug.lastIndexOf('-') > 20) slug = slug.slice(0, slug.lastIndexOf('-'));
  return slug.replace(/-+$/, '') || fallback;
}

export function uniquePath(dir, base, ext = '') {
  let candidate = path.join(dir, base + ext);
  for (let n = 2; existsSync(candidate); n++) candidate = path.join(dir, `${base}-${n}${ext}`);
  return candidate;
}

// First JSON object in the reply, tolerating code fences and text around it.
export function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new FormatError('JSON nesnesi yok');
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch (error) { throw new FormatError(`JSON okunamadı: ${error.message}`); }
    }
  }
  throw new FormatError('JSON yarıda kesilmiş');
}

const str = (value, fallback = '') => (typeof value === 'string' ? value : value == null ? fallback : String(value)).trim();

// ---------- PowerPoint ----------

function parseSlides(text, topic) {
  const data = extractJson(text);
  const slides = Array.isArray(data.slides) ? data.slides : [];
  const clean = slides.slice(0, 30).map(slide => ({
    title: str(slide?.title),
    bullets: (Array.isArray(slide?.bullets) ? slide.bullets : []).map(item => str(item)).filter(Boolean).slice(0, 8),
    notes: str(slide?.notes),
  })).filter(slide => slide.title || slide.bullets.length);
  if (!clean.length) throw new FormatError('slides listesi boş');
  return { title: str(data.title, topic) || topic, subtitle: str(data.subtitle), slides: clean };
}

function flagMark(slide, x, y, size) {
  // Crescent: a white circle with a red circle offset over it; star beside it.
  slide.addShape('ellipse', { x, y, w: size, h: size, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' } });
  slide.addShape('ellipse', { x: x + size * 0.25, y: y + size * 0.1, w: size * 0.8, h: size * 0.8, fill: { color: RED }, line: { color: RED } });
  slide.addShape('star5', { x: x + size * 0.98, y: y + size * 0.32, w: size * 0.36, h: size * 0.36, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' }, rotate: -18 });
}

export async function buildPptx(data, file) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Umay AI';
  pptx.title = data.title;
  const cover = pptx.addSlide();
  cover.background = { color: RED };
  flagMark(cover, 7.0, 1.35, 2.0);
  cover.addText(data.title, { x: 0.6, y: 1.5, w: 6.2, h: 1.6, fontSize: 34, bold: true, color: 'FFFFFF', fontFace: 'Calibri', valign: 'top', fit: 'shrink' });
  if (data.subtitle) cover.addText(data.subtitle, { x: 0.6, y: 3.15, w: 6.2, h: 0.9, fontSize: 18, color: 'FFE4E6', fontFace: 'Calibri', valign: 'top' });
  cover.addShape('rect', { x: 0.6, y: 4.45, w: 1.2, h: 0.06, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' } });
  cover.addText(`Umay Yapay Zeka ile hazırlandı · ${today()}`, { x: 0.6, y: 4.6, w: 6.5, h: 0.4, fontSize: 11, color: 'FFE4E6', fontFace: 'Calibri' });
  const total = data.slides.length;
  data.slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addShape('rect', { x: 0, y: 0, w: 0.18, h: 5.625, fill: { color: RED }, line: { color: RED } });
    slide.addText(item.title, { x: 0.6, y: 0.35, w: 8.8, h: 0.8, fontSize: 26, bold: true, color: INK, fontFace: 'Calibri', fit: 'shrink' });
    slide.addShape('rect', { x: 0.6, y: 1.15, w: 0.9, h: 0.05, fill: { color: RED }, line: { color: RED } });
    if (item.bullets.length) {
      slide.addText(item.bullets.map(text => ({ text, options: { bullet: { code: '25A0' }, color: '374151', breakLine: true } })),
        { x: 0.6, y: 1.4, w: 8.8, h: 3.6, fontSize: 18, fontFace: 'Calibri', valign: 'top', paraSpaceAfter: 8, fit: 'shrink' });
    }
    slide.addText('☾★ Umay', { x: 0.6, y: 5.15, w: 3, h: 0.3, fontSize: 10, color: RED, bold: true, fontFace: 'Segoe UI Symbol' });
    slide.addText(`${index + 1} / ${total}`, { x: 8.4, y: 5.15, w: 1.2, h: 0.3, fontSize: 10, color: '9CA3AF', align: 'right', fontFace: 'Calibri' });
    if (item.notes) slide.addNotes(item.notes);
  });
  const end = pptx.addSlide();
  end.background = { color: RED };
  flagMark(end, 4.0, 1.2, 1.6);
  end.addText('Teşekkürler', { x: 0, y: 3.2, w: 10, h: 0.9, fontSize: 36, bold: true, color: 'FFFFFF', align: 'center', fontFace: 'Calibri' });
  end.addText(data.title, { x: 0.5, y: 4.05, w: 9, h: 0.5, fontSize: 14, color: 'FFE4E6', align: 'center', fontFace: 'Calibri' });
  await writeFile(file, await pptx.write({ outputType: 'nodebuffer' }));
}

// ---------- Word ----------

function parseDocument(text, topic) {
  let body = text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').trim();
  if (body.length < 40) throw new FormatError('belge metni çok kısa');
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || topic;
  return { title, markdown: body };
}

function runs(text, extra = {}) {
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(new TextRun({ text: text.slice(last, match.index), ...extra }));
    const token = match[0];
    if (token.startsWith('**')) parts.push(new TextRun({ text: token.slice(2, -2), bold: true, ...extra }));
    else if (token.startsWith('`')) parts.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas', ...extra }));
    else parts.push(new TextRun({ text: token.slice(1, -1), italics: true, ...extra }));
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(new TextRun({ text: text.slice(last), ...extra }));
  return parts;
}

function docxTable(rows) {
  const cells = rows.map(row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()))
    .filter(row => !row.every(cell => /^:?-{2,}:?$/.test(cell)));
  // Only a separator line ("|---|---|"): there is no table to draw.
  if (!cells.length) return null;
  const count = Math.max(...cells.map(row => row.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: cells.map((row, r) => new TableRow({
      tableHeader: r === 0,
      children: Array.from({ length: count }, (_, i) => new TableCell({
        shading: r === 0 ? { type: ShadingType.CLEAR, color: 'auto', fill: RED } : r % 2 === 0 ? { type: ShadingType.CLEAR, color: 'auto', fill: 'FFF5F5' } : undefined,
        children: [new Paragraph({ children: runs(row[i] ?? '', r === 0 ? { bold: true, color: 'FFFFFF' } : {}) })],
      })),
    })),
  });
}

export function markdownToDocx(markdown) {
  const children = [];
  const lines = markdown.split(/\r?\n/);
  let firstTitle = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    if (/^\s*```/.test(line)) {
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      for (const codeLine of code) children.push(new Paragraph({ children: [new TextRun({ text: codeLine || ' ', font: 'Consolas', size: 19 })], shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } }));
    } else if (line.trimStart().startsWith('|')) {
      const rows = [line];
      while (i + 1 < lines.length && lines[i + 1].trimStart().startsWith('|')) rows.push(lines[++i]);
      const table = docxTable(rows);
      if (table) children.push(table, new Paragraph({ text: '' }));
    } else if ((match = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const level = match[1].length;
      if (level === 1 && firstTitle) {
        firstTitle = false;
        children.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: runs(match[2]) }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: today(), color: '6B7280', size: 20 })] }));
      } else {
        const heading = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][Math.min(level, 3)];
        children.push(new Paragraph({ heading, children: runs(match[2]) }));
      }
    } else if ((match = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
      children.push(new Paragraph({ bullet: { level: Math.min(Math.floor(match[1].length / 2), 3) }, children: runs(match[2]) }));
    } else if ((match = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line))) {
      children.push(new Paragraph({ indent: { left: 360 + Math.floor(match[1].length / 2) * 360, hanging: 360 }, children: [new TextRun({ text: `${match[2]} ` }), ...runs(match[3])] }));
    } else if ((match = /^>\s?(.*)$/.exec(line))) {
      children.push(new Paragraph({ indent: { left: 400 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: RED, space: 8 } }, children: runs(match[1], { italics: true, color: '4B5563' }) }));
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D1D5DB', space: 1 } } }));
    } else if (line.trim()) {
      children.push(new Paragraph({ spacing: { after: 120 }, children: runs(line.trim()) }));
    }
  }
  return children;
}

export async function buildDocx(data, file) {
  const doc = new Document({
    creator: 'Umay AI', title: data.title,
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22, color: INK } },
        title: { run: { font: 'Calibri', size: 44, bold: true, color: RED } },
        heading1: { run: { font: 'Calibri', size: 30, bold: true, color: DARK_RED }, paragraph: { spacing: { before: 280, after: 120 } } },
        heading2: { run: { font: 'Calibri', size: 26, bold: true, color: INK }, paragraph: { spacing: { before: 220, after: 100 } } },
        heading3: { run: { font: 'Calibri', size: 23, bold: true, color: '374151' } },
      },
    },
    sections: [{
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: '☾★ Umay AI  ·  Sayfa ', size: 16, color: '9CA3AF' }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '9CA3AF' }),
        new TextRun({ text: ' / ', size: 16, color: '9CA3AF' }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '9CA3AF' }),
      ] })] }) },
      children: markdownToDocx(data.markdown),
    }],
  });
  await writeFile(file, await Packer.toBuffer(doc));
}

// ---------- Excel ----------

function parseSheets(text, topic) {
  const data = extractJson(text);
  const sheets = (Array.isArray(data.sheets) ? data.sheets : []).slice(0, 10).map((sheet, i) => {
    const columns = (Array.isArray(sheet?.columns) ? sheet.columns : []).map(column => str(column)).slice(0, 40);
    const rows = (Array.isArray(sheet?.rows) ? sheet.rows : []).filter(Array.isArray).slice(0, 5000)
      .map(row => columns.map((_, c) => row[c] === undefined ? null : row[c]));
    return { name: str(sheet?.name, `Sayfa ${i + 1}`), columns, rows, totals: sheet?.totals === true };
  }).filter(sheet => sheet.columns.length);
  if (!sheets.length) throw new FormatError('sheets veya columns boş');
  return { title: str(data.title, topic) || topic, summary: str(data.summary), sheets };
}

const sheetName = (name, used) => {
  let base = name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sayfa';
  let candidate = base;
  for (let n = 2; used.has(candidate.toLocaleLowerCase('tr')); n++) candidate = `${base.slice(0, 28)} ${n}`;
  used.add(candidate.toLocaleLowerCase('tr'));
  return candidate;
};

// A number the model wrote as text ("12,5") becomes a number. Codes stay text: with a leading zero (06100,
// 0532...) or more than 15 digits (card numbers) the conversion would change them. One such value marks its
// whole column as codes, so a postal code column does not end up half text, half number.
const NUMBER_TEXT = /^-?\d+(?:[.,]\d+)?$/;
const CODE_TEXT = /^(?:0\d+|\d{16,})$/;
function cellValue(value, code) {
  if (!code && typeof value === 'string' && NUMBER_TEXT.test(value.trim())) return Number(value.trim().replace(',', '.'));
  return typeof value === 'number' || typeof value === 'string' ? value : value == null ? null : String(value);
}

export async function buildXlsx(data, file) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Umay AI';
  const used = new Set();
  for (const sheet of data.sheets) {
    const ws = workbook.addWorksheet(sheetName(sheet.name, used));
    const count = sheet.columns.length;
    ws.mergeCells(1, 1, 1, Math.max(1, count));
    const titleCell = ws.getCell(1, 1);
    titleCell.value = `☾★ ${data.title}`;
    titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + RED } };
    titleCell.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 26;
    const header = ws.getRow(3);
    sheet.columns.forEach((name, i) => {
      const cell = header.getCell(i + 1);
      cell.value = name;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + DARK_RED } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    const codes = sheet.columns.map((_, c) => sheet.rows.some(row => typeof row[c] === 'string' && CODE_TEXT.test(row[c].trim())));
    const values = sheet.rows.map(row => row.map((value, c) => cellValue(value, codes[c])));
    const numbersOf = c => values.map(row => row[c]).filter(value => typeof value === 'number');
    // A column of years (2023, 2024) is shown without a thousands separator (not "2.024") and is not summed.
    const years = sheet.columns.map((_, c) => numbersOf(c).length > 0
      && numbersOf(c).every(value => Number.isInteger(value) && value >= 1900 && value <= 2100));
    values.forEach((row, r) => {
      const excelRow = ws.getRow(4 + r);
      row.forEach((value, c) => {
        const cell = excelRow.getCell(c + 1);
        cell.value = value;
        if (typeof value === 'number' && !years[c]) cell.numFmt = Number.isInteger(value) ? '#,##0' : '#,##0.00';
        if (r % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F5' } };
      });
    });
    const last = 3 + sheet.rows.length;
    if (sheet.totals && sheet.rows.length) {
      const totals = ws.getRow(last + 1);
      totals.getCell(1).value = 'TOPLAM';
      sheet.columns.forEach((_, c) => {
        const numbers = numbersOf(c);
        if (c === 0 || !numbers.length || years[c]) return;
        const letter = ws.getColumn(c + 1).letter;
        // The cached result lets viewers that do not recalculate still show the total.
        totals.getCell(c + 1).value = { formula: `SUM(${letter}4:${letter}${last})`, result: numbers.reduce((a, b) => a + b, 0) };
        totals.getCell(c + 1).numFmt = '#,##0.##';
      });
      totals.font = { bold: true };
      totals.eachCell(cell => { cell.border = { top: { style: 'thin', color: { argb: 'FF' + RED } } }; });
    }
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: Math.max(3, last), column: count } };
    ws.views = [{ state: 'frozen', ySplit: 3 }];
    sheet.columns.forEach((name, c) => {
      const longest = Math.max(name.length, ...sheet.rows.map(row => String(row[c] ?? '').length));
      ws.getColumn(c + 1).width = Math.min(50, Math.max(10, longest + 2));
    });
  }
  if (data.summary) {
    const ws = workbook.addWorksheet(sheetName('Özet', used));
    ws.getColumn(1).width = 100;
    ws.getCell('A1').value = data.title;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF' + RED } };
    ws.getCell('A3').value = data.summary;
    ws.getCell('A3').alignment = { wrapText: true, vertical: 'top' };
  }
  await writeFile(file, Buffer.from(await workbook.xlsx.writeBuffer()));
}

// ---------- Mermaid diagram ----------

const MERMAID_START = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|mindmap|timeline|journey|pie|quadrantChart|gitGraph)\b/m;

function parseDiagram(text, topic) {
  const title = /^\s*(?:Başlık|Baslik|Title)\s*:\s*(.+)$/im.exec(text)?.[1]?.trim() || topic;
  let code = /```(?:mermaid)?\s*\n([\s\S]*?)```/i.exec(text)?.[1];
  if (!code) {
    const start = MERMAID_START.exec(text);
    if (start) code = text.slice(start.index);
  }
  code = code?.trim();
  if (!code || !MERMAID_START.test(code)) throw new FormatError('mermaid kod bloğu yok');
  return { title, code };
}

const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function diagramHtml({ title, code }, svgName) {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --red: #E30A17; --bg: #0e0e11; --panel: #16161b; --line: #2a2a31; --text: #f4f4f5; --muted: #9ca3af; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; color: var(--text); font-family: "Segoe UI", system-ui, sans-serif;
    background: radial-gradient(1200px 500px at 50% -10%, #3b0a0f, var(--bg) 70%); }
  header { display: flex; align-items: center; gap: 14px; padding: 18px 28px; border-bottom: 1px solid #3a1418; }
  .mark { color: var(--red); font-size: 24px; }
  h1 { font-size: 19px; margin: 0; flex: 1; }
  .badge { background: var(--red); color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .08em; padding: 4px 9px; border-radius: 6px; }
  button { background: transparent; color: var(--text); border: 1px solid var(--red); border-radius: 8px; padding: 7px 12px; cursor: pointer; }
  button:hover { background: var(--red); }
  main { padding: 24px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 24px; overflow: auto; text-align: center; }
  footer { color: var(--muted); font-size: 12px; text-align: center; padding: 18px; }
</style>
</head>
<body>
<header><span class="mark">☾★</span><h1>${escapeHtml(title)}</h1><span class="badge">UMAY · ŞEMA</span><button id="svg">SVG indir</button></header>
<main><div class="card"><pre class="mermaid">${escapeHtml(code)}</pre></div></main>
<footer>Umay Yapay Zeka ile hazırlandı · ${escapeHtml(today())}</footer>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script>
  mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'strict', themeVariables: {
    primaryColor: '#3a0a0e', primaryBorderColor: '#E30A17', primaryTextColor: '#f4f4f5', lineColor: '#ef4444',
    secondaryColor: '#1f1f25', tertiaryColor: '#16161b', fontFamily: 'Segoe UI' } });
  document.getElementById('svg').onclick = () => {
    const svg = document.querySelector('.mermaid svg');
    if (!svg) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
    link.download = ${JSON.stringify(svgName)};
    link.click();
  };
</script>
</body>
</html>
`;
}

// ---------- Web project ----------

const WEB_FILE = /([\w][\w./-]*\.(?:html?|css|m?js|json|svg|md|txt|xml|webmanifest))/i;
const DEFAULT_NAMES = { html: 'index.html', htm: 'index.html', css: 'style.css', js: 'script.js', javascript: 'script.js', json: 'data.json', svg: 'image.svg' };

// A line that only names a file: "DOSYA: index.html", "**index.html**", "### 2. js/app.js:", "File: `a.css`".
function fileLabel(line) {
  const bare = line.replace(/[*_`#>]/g, '').trim();
  const match = /^(?:\d+[.)]\s*)?(?:(?:dosya(?:\s*ad[ıi])?|file(?:name)?|📄)\s*[:：-]?\s*)?([\w][\w./-]*\.[a-z]+)\s*:?\s*(?:\([^)]*\))?$/i.exec(bare);
  return match && WEB_FILE.test(match[1]) ? match[1] : null;
}

// Accepts the requested "DOSYA:" layout and the common variants models write instead.
export function parseProject(text, topic) {
  const name = /^[\s#*>-]*PROJE\s*:\s*[*`]*([^\n`*]+?)[*`]*\s*$/im.exec(text)?.[1]?.trim() || topic;
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const prose = [];
  let label = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(lines[i]);
    if (!fence) {
      const named = fileLabel(lines[i]);
      if (named) label = named;
      else if (lines[i].trim() && !/^[\s#*>-]*PROJE\s*:/i.test(lines[i])) prose.push(lines[i].trim());
      continue;
    }
    const marker = fence[1][0].repeat(3);
    const info = fence[2].trim();
    const body = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      if (lines[i].trim().startsWith(marker) && !lines[i].trim().replace(/[`~]/g, '')) { closed = true; break; }
      body.push(lines[i]);
    }
    const lang = info.split(/[\s:{]/)[0].toLowerCase();
    blocks.push({ path: WEB_FILE.exec(info)?.[1] ?? label, lang, content: body.join('\n') + '\n', closed });
    label = null;
  }
  if (blocks.some(block => !block.closed)) throw new FormatError('yanıt yarıda kesildi');
  const files = [];
  for (const block of blocks) {
    let file = block.path ?? DEFAULT_NAMES[block.lang];
    if (!file) continue;
    file = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..') || !/^[\w./ -]+$/.test(file)) {
      throw new FormatError(`geçersiz dosya yolu: ${file}`);
    }
    if (files.some(item => item.path.toLowerCase() === file.toLowerCase())) {
      if (block.path) continue; // An explicitly named duplicate: keep the first.
      file = file.replace(/(\.\w+)$/, `-${files.length + 1}$1`);
    }
    files.push({ path: file, content: block.content });
  }
  if (!files.length) throw new FormatError('kod bloğu yok');
  if (files.length > 40) throw new FormatError('çok fazla dosya');
  if (!files.some(file => /\.html?$/i.test(file.path))) throw new FormatError('HTML dosyası yok');
  return { name, files, summary: prose.slice(0, 4).join(' ') };
}

export async function buildProject(data, cwd) {
  const slug = slugify(data.name, 'umay-proje');
  const dir = uniquePath(cwd, slug);
  const zip = new JSZip();
  for (const file of data.files) {
    const target = path.join(dir, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    zip.file(`${path.basename(dir)}/${file.path}`, file.content);
  }
  const zipFile = uniquePath(cwd, path.basename(dir), '.zip');
  await writeFile(zipFile, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { dir, zipFile };
}

// ---------- Registry ----------

const JSON_ONLY = 'YALNIZCA tek bir JSON nesnesi yaz; açıklama, selamlama veya kod bloğu dışı metin yazma.';

export const GENERATORS = {
  sunum: {
    label: 'Sunum', icon: 'P', example: '/sunum Yapay zekanın eğitimdeki yeri',
    desc: '10 slaytlık PowerPoint sunumu (.pptx)',
    system: `Sen Umay'sın; profesyonel Türkçe sunumlar hazırlarsın. Kullanıcı aksini istemedikçe 10 içerik slaytı hazırla.
${JSON_ONLY} Biçim:
{"title": "Sunum başlığı", "subtitle": "Kısa alt başlık", "slides": [{"title": "Slayt başlığı", "bullets": ["Kısa madde", "Kısa madde"], "notes": "Konuşmacı notu"}]}
Her slaytta 3-5 madde olsun; her madde en fazla 15 kelime. Bilgiler doğru, somut ve birbirini tekrar etmeyen içerikte olsun.`,
    parse: parseSlides,
    async build(data, cwd) {
      const file = uniquePath(cwd, slugify(data.title), '.pptx');
      await buildPptx(data, file);
      return { file, files: [file], title: data.title,
        details: [`${data.slides.length} içerik slaytı + kapak ve kapanış`, ...data.slides.slice(0, 12).map((slide, i) => `${i + 1}. ${slide.title}`)] };
    },
  },
  dokuman: {
    label: 'Word belgesi', icon: 'W', example: '/dokuman Belediyeye yol onarımı için dilekçe',
    desc: 'Rapor, dilekçe veya resmi belge (.docx)',
    system: `Sen Umay'sın; resmi ve düzenli Türkçe belgeler hazırlarsın. Belgeyi Markdown olarak yaz:
ilk satır "# Başlık", bölümler "## ", alt bölümler "### ", maddeler "- ", numaralı listeler "1. ", tablolar "| a | b |", vurgular **kalın**.
Dilekçe istenirse resmi dilekçe düzeninde (tarih, muhatap, konu, metin, saygılarımla, ad soyad/imza yeri) yaz.
Yalnızca belgenin kendisini yaz; öncesinde veya sonrasında açıklama yazma, kod bloğu kullanma.`,
    parse: parseDocument,
    async build(data, cwd) {
      const file = uniquePath(cwd, slugify(data.title), '.docx');
      await buildDocx(data, file);
      const headings = data.markdown.split('\n').filter(line => /^##\s/.test(line)).map(line => line.replace(/^##\s+/, ''));
      return { file, files: [file], title: data.title, details: headings.length ? [`${headings.length} bölüm`, ...headings.slice(0, 10).map(h => `• ${h}`)] : [] };
    },
  },
  rapor: {
    label: 'Excel raporu', icon: 'X', example: '/rapor 2024 aylık satışlarını özetleyen tablo (veya önce /ekle veriler.csv)',
    desc: 'Verileri düzenleyip Excel tablosu (.xlsx) yapar',
    system: `Sen Umay'sın; verileri analiz edip düzenli Excel tabloları hazırlarsın. Kullanıcının verdiği verileri veya eklediği dosyayı kullan.
${JSON_ONLY} Biçim:
{"title": "Rapor başlığı", "sheets": [{"name": "Sayfa adı", "columns": ["Sütun 1", "Sütun 2"], "rows": [["metin", 123.5]], "totals": true}], "summary": "2-4 cümlelik analiz özeti"}
Sayıları tırnaksız sayı olarak yaz. Toplam satırı anlamlıysa "totals": true kullan. Kullanıcı veri vermediyse gerçekçi örnek veri üret ve bunu summary içinde açıkça "örnek veri" olarak belirt.`,
    parse: parseSheets,
    async build(data, cwd) {
      const file = uniquePath(cwd, slugify(data.title), '.xlsx');
      await buildXlsx(data, file);
      return { file, files: [file], title: data.title,
        details: [...data.sheets.map(sheet => `${sheet.name}: ${sheet.rows.length} satır × ${sheet.columns.length} sütun`), ...(data.summary ? [data.summary] : [])] };
    },
  },
  sema: {
    label: 'Şema', icon: 'M', example: '/sema Bir e-ticaret sitesinin sipariş akışı',
    desc: 'Mermaid akış şeması / zihin haritası (.html)',
    system: `Sen Umay'sın; konuları Mermaid diyagramlarıyla anlatırsın. Varsayılan "flowchart TD"; uygunsa mindmap, sequenceDiagram, classDiagram, erDiagram veya gantt kullan.
Önce tek satır "Başlık: ..." yaz, ardından yalnızca bir \`\`\`mermaid kod bloğu yaz. Başka açıklama yazma.
Düğüm metinlerini çift tırnak içine al, örneğin A["Sipariş (web)"] --> B["Ödeme"]. Metinlerde çift tırnak kullanma. Geçerli Mermaid 10 sözdizimi kullan.`,
    parse: parseDiagram,
    async build(data, cwd) {
      const base = slugify(data.title, 'umay-sema');
      const file = uniquePath(cwd, base, '.html');
      const source = file.replace(/\.html$/, '.mmd');
      await writeFile(file, diagramHtml(data, `${path.basename(file, '.html')}.svg`), 'utf8');
      await writeFile(source, data.code + '\n', 'utf8');
      return { file, files: [file, source], title: data.title, details: [`${data.code.split('\n').length} satır Mermaid`, 'HTML dosyasını tarayıcıda aç (/ac); şema internet bağlantısıyla çizilir.'] };
    },
  },
  proje: {
    label: 'Web projesi', icon: 'Z', example: '/proje Türk bayrağı temalı geri sayım sayacı',
    desc: 'HTML/CSS/JS projesi; klasör + .zip',
    system: `Sen Umay'sın; eksiksiz ve çalışan web projeleri yazarsın. Yalnızca HTML, CSS ve JavaScript kullan; derleme veya paket kurulumu gerektirme (gerekirse CDN kullan).
İlk satıra "PROJE: kisa-klasor-adi" yaz. Sonra her dosyayı tam içeriğiyle şu biçimde yaz:
DOSYA: index.html
\`\`\`html
...dosyanın tamamı...
\`\`\`
index.html mutlaka olsun. En fazla 3 dosya yaz (index.html, style.css, script.js) ve toplam 300 satırı geçme; kodu sade tut.
Dosyaları kısaltma, "..." ile atlama yapma. Dosyaların dışında en fazla 3 cümle açıklama yaz.`,
    // Long code output: reasoning would spend the reply budget before the files are written.
    noThinking: true,
    shorter: 'Projeyi daha kısa yaz: tek bir index.html içinde CSS ve JS, toplam 200 satırı geçmesin. Biçim aynı kalsın: önce "DOSYA: index.html", sonra kod bloğu.',
    parse: parseProject,
    async build(data, cwd) {
      const { dir, zipFile } = await buildProject(data, cwd);
      const page = data.files.find(file => /(^|\/)index\.html?$/i.test(file.path)) ?? data.files.find(file => /\.html?$/i.test(file.path));
      return { file: path.join(dir, ...page.path.split('/')), files: [dir, zipFile], title: data.name,
        details: [`${data.files.length} dosya: ${data.files.map(file => file.path).join(', ')}`, ...(data.summary ? [data.summary] : [])] };
    },
  },
};

// ask(messages, generator) returns the reply text, or { text, finishReason }.
// failureFile, when given, receives the raw replies if the model never produced a usable format.
export async function generate(kind, { topic, attachments = [], ask, cwd, onRepair = () => {}, failureFile }) {
  const gen = GENERATORS[kind];
  const messages = [{ role: 'system', content: `${gen.system}\nBugünün tarihi: ${today()}.` },
    { role: 'user', content: buildUserContent(topic, attachments) }];
  const replies = [];
  const request = async list => {
    const reply = await ask(list, gen);
    const result = typeof reply === 'string' ? { text: reply } : reply;
    replies.push(result);
    return result;
  };
  let reply = await request(messages);
  let data;
  try { data = gen.parse(reply.text, topic); } catch (error) {
    if (!(error instanceof FormatError)) throw error;
    onRepair();
    const cut = reply.finishReason === 'length' || error.message === 'yanıt yarıda kesildi';
    reply = await request([...messages, { role: 'assistant', content: reply.text }, { role: 'user', content: cut
      ? `Yanıtın uzunluk sınırında kesildi. ${gen.shorter ?? 'Daha kısa ve öz yaz; biçim aynı kalsın.'}`
      : `Yanıtın işlenemedi (${error.message}). Açıklama yazmadan, yalnızca istenen biçimde ve eksiksiz yeniden yaz.` }]);
    try { data = gen.parse(reply.text, topic); } catch (again) {
      if (!(again instanceof FormatError)) throw again;
      const saved = await saveFailure(failureFile, kind, topic, replies);
      const reason = reply.finishReason === 'length' || again.message === 'yanıt yarıda kesildi'
        ? 'yanıt uzunluk sınırında kesildi' : `model istenen biçimde yanıt vermedi (${again.message})`;
      throw new UserError(`${gen.label} oluşturulamadı: ${reason}. İsteği kısaltıp tekrar dene.${saved ? ` Ham yanıt: ${saved}` : ''}`);
    }
  }
  const result = await gen.build(data, cwd);
  return { ...result, label: gen.label,
    note: `${gen.label} hazırlandı: ${result.files.join(', ')}\nBaşlık: ${result.title}\n${result.details.join('\n')}` };
}

async function saveFailure(file, kind, topic, replies) {
  if (!file) return null;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const parts = replies.map((reply, i) => `===== Yanıt ${i + 1} (bitiş: ${reply.finishReason ?? 'bilinmiyor'}, ${reply.text.length} karakter) =====\n${reply.text}`);
    await writeFile(file, `/${kind} ${topic}\n${new Date().toISOString()}\n\n${parts.join('\n\n')}\n`, 'utf8');
    return file;
  } catch { return null; }
}
