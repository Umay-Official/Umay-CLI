// Streaming Markdown for the terminal. Paragraphs, lists and headings appear word by word;
// code blocks line by line; tables once complete. Without color, text passes through unchanged.
import { t, color as defaultColor, width as terminalWidth, rule } from './theme.mjs';

const UNDECIDED = /^\s*(?:[-*_#>|`~+]+|\d+[.)]?)?$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)/;

export function markdownStream(write, { styled = defaultColor, indent = '  ', width = terminalWidth } = {}) {
  if (!styled) return { push: text => write(text), end() {} };
  let line = '';          // characters of the current source line
  let mode = 'start';     // start | flow | hold
  let fence = null;       // open code fence marker
  let table = [];
  let blank = 1;          // consecutive blank lines already printed
  let flow;               // state of a streamed line

  const out = text => { write(text); };

  function startFlow(prefix, rest, base) {
    const hang = prefix.length;
    out(indent + styleMarker(prefix));
    flow = { col: indent.length + hang, hang: indent.length + hang, word: '', space: false, base, inline: {} };
    blank = 0;
    for (const char of rest) feed(char);
  }

  function styleMarker(prefix) {
    return prefix.replace(/^(\s*)(•|\d+[.)]|┃)/, (_, space, mark) => space + t.red(mark));
  }

  function feed(char) {
    if (char === ' ' || char === '\t') { flushWord(); flow.space = true; return; }
    flow.word += char;
  }

  function flushWord() {
    if (!flow.word) return;
    const { text, size } = styleText(flow.word, flow.inline, flow.base);
    const limit = width() - 2;
    if (flow.col + (flow.space ? 1 : 0) + size > limit && flow.col > flow.hang) {
      out('\n' + ' '.repeat(flow.hang)); flow.col = flow.hang; flow.space = false;
    }
    if (flow.space && flow.col > flow.hang) { out(' '); flow.col++; }
    out(text); flow.col += size; flow.word = ''; flow.space = false;
  }

  function decide() {
    if (table.length && !line.trimStart().startsWith('|')) flushTable();
    if (fence || UNDECIDED.test(line)) return;
    const source = line;
    let match;
    if (FENCE.test(source) || source.trimStart().startsWith('|')) { mode = 'hold'; return; }
    if ((match = /^(#{1,6})\s+(.*)$/.exec(source))) {
      mode = 'flow'; startFlow('', match[2], match[1].length <= 2 ? 'h1' : 'h3');
    } else if ((match = /^(\s*)[-*+]\s+(.*)$/.exec(source))) {
      mode = 'flow'; startFlow(`${match[1]}• `, match[2], 'p');
    } else if ((match = /^(\s*)(\d+[.)])\s+(.*)$/.exec(source))) {
      mode = 'flow'; startFlow(`${match[1]}${match[2]} `, match[3], 'p');
    } else if ((match = /^>\s?(.*)$/.exec(source))) {
      mode = 'flow'; startFlow('┃ ', match[1], 'quote');
    } else {
      mode = 'flow'; startFlow('', source, 'p');
    }
  }

  function endLine() {
    const source = line;
    line = '';
    if (mode === 'flow') { flushWord(); out('\n'); mode = 'start'; flow = undefined; return; }
    mode = 'start';
    const fenceMatch = FENCE.exec(source);
    if (fence) {
      if (fenceMatch && source.trim().startsWith(fence)) { out(indent + t.dim('└' + '─'.repeat(20)) + '\n'); fence = null; return; }
      out(indent + t.dim('│ ') + t.text(source) + '\n'); return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out(indent + t.dim(`┌─ ${fenceMatch[2] || 'kod'} ${'─'.repeat(Math.max(2, 16 - (fenceMatch[2] || 'kod').length))}`) + '\n');
      blank = 0; return;
    }
    if (source.trimStart().startsWith('|')) { table.push(source); return; }
    if (table.length) flushTable();
    if (!source.trim()) { if (blank < 1) out('\n'); blank++; return; }
    if (HR.test(source)) { out(rule() + '\n'); blank = 0; return; }
    // A short line that never became decidable, such as "-" or "12".
    startFlow('', source, 'p'); flushWord(); out('\n'); flow = undefined;
  }

  function flushTable() {
    const rows = table.map(row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
    table = [];
    const body = rows.filter(row => !row.every(cell => /^:?-{2,}:?$/.test(cell)));
    if (!body.length) return;
    const count = Math.max(...body.map(row => row.length));
    // Each cell keeps its styling when it fits on one line; longer cells wrap inside the column.
    const cells = body.map(row => Array.from({ length: count }, (_, i) => {
      const parts = (row[i] ?? '').split(/<br\s*\/?>/i).map(part => styleText(part.trim(), {}, 'p'));
      return { parts, size: Math.max(...parts.map(part => part.size)) };
    }));
    const available = width() - indent.length - (count * 3 + 1);
    const widths = Array.from({ length: count }, (_, i) => Math.max(1, ...cells.map(row => row[i].size)));
    while (widths.reduce((a, b) => a + b, 0) > available) {
      const widest = widths.indexOf(Math.max(...widths));
      if (widths[widest] <= 8) break;
      widths[widest]--;
    }
    const border = (l, m, r) => indent + t.darkRed(l + widths.map(w => '─'.repeat(w + 2)).join(m) + r);
    const render = (row, header) => {
      const columns = row.map((cell, i) => cell.parts.flatMap(part => part.size <= widths[i]
        ? [{ text: header ? t.white(part.plain) : part.text, size: part.size }]
        : wrapPlain(part.plain, widths[i]).map(text => ({ text: header ? t.white(text) : text, size: text.length }))));
      const height = Math.max(...columns.map(lines => lines.length));
      return Array.from({ length: height }, (_, line) => indent + t.darkRed('│') + columns.map((lines, i) => {
        const piece = lines[line] ?? { text: '', size: 0 };
        return ' ' + piece.text + ' '.repeat(Math.max(0, widths[i] - piece.size)) + ' ';
      }).join(t.darkRed('│')) + t.darkRed('│')).join('\n');
    };
    const lines = [border('┌', '┬', '┐'), render(cells[0], true)];
    if (cells.length > 1) lines.push(border('├', '┼', '┤'), ...cells.slice(1).map(row => render(row, false)));
    lines.push(border('└', '┴', '┘'));
    out(lines.join('\n') + '\n');
    blank = 0;
  }

  return {
    push(text) {
      for (const char of String(text).replace(/\r/g, '')) {
        if (char === '\n') { endLine(); continue; }
        if (mode === 'flow') { line += char; feed(char); continue; }
        line += char;
        if (mode === 'start') decide();
      }
    },
    // Completes the current line (for example before tool progress is printed).
    end() {
      if (line || mode === 'flow') endLine();
      if (table.length) flushTable();
    },
  };
}

// Greedy word wrap; words longer than the width are split.
export function wrapPlain(text, size) {
  const lines = [];
  let current = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > size) {
      if (current) { lines.push(current); current = ''; }
      lines.push(word.slice(0, size)); word = word.slice(size);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= size) current += ' ' + word;
    else { lines.push(current); current = word; }
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}

// Applies **bold**, *italic*, `code` and [links](url). State carries across words of one line.
export function styleText(source, state = {}, base = 'p') {
  let text = '';
  let plain = '';
  let segment = '';
  const paintSegment = value => {
    if (!value) return '';
    if (state.code) return t.code(value);
    if (base === 'h1') return t.redBold(value);
    if (state.bold || base === 'h3') return t.white(value);
    if (state.italic || base === 'quote') return t.italic(value);
    return value;
  };
  const flush = () => { text += paintSegment(segment); segment = ''; };
  const link = /^\[([^\]]+)\]\((\S+?)\)/;
  // Asterisks start emphasis only at the start of a word and directly before text. Elsewhere they are part of
  // the text and must stay visible: 17*23, 2**10, *.py, a * b.
  const opens = i => {
    let from = i;
    let to = i;
    while (source[from - 1] === '*') from--;
    while (source[to] === '*') to++;
    return !/[\p{L}\p{N}]/u.test(source[from - 1] ?? '') && /[\p{L}\p{N}"'“‘(\[{<`]/u.test(source[to] ?? '');
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '`') { flush(); state.code = !state.code; continue; }
    if (!state.code) {
      if (char === '*' && source[i + 1] === '*') {
        if (state.bold || opens(i)) { flush(); state.bold = !state.bold; }
        else { segment += '**'; plain += '**'; }
        i++; continue;
      }
      if (char === '*' && (state.italic || opens(i))) { flush(); state.italic = !state.italic; continue; }
      const match = char === '[' ? link.exec(source.slice(i)) : null;
      if (match) {
        flush();
        text += t.text(match[1]) + t.dim(` (${match[2]})`);
        plain += `${match[1]} (${match[2]})`;
        i += match[0].length - 1;
        continue;
      }
    }
    segment += char; plain += char;
  }
  flush();
  return { text, plain, size: plain.length };
}
