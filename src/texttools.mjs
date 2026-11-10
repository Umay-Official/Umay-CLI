// Text tool-call protocol for servers that ignore the native `tools` field.
// The model writes <tool_call> blocks in plain text; only these blocks are executed.

export const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';
const MAX_CALLS = 8;
// Names models commonly guess when they have not seen the real schema.
const ALIASES = {
  list_files: 'list_dir', list_directory: 'list_dir', ls: 'list_dir',
  read: 'read_file', cat: 'read_file', search: 'search_files', grep: 'search_files',
  write: 'write_file', create_file: 'write_file', edit: 'edit_file', replace_in_file: 'edit_file',
  shell: 'run_command', bash: 'run_command', powershell: 'run_command', execute_command: 'run_command',
  python: 'run_python', execute_python: 'run_python',
};

export function textToolInstructions(tools) {
  const lines = tools.map(entry => {
    const { properties = {}, required = [] } = entry.parameters ?? {};
    const params = Object.entries(properties).map(([key, value]) =>
      `${key}${required.includes(key) ? '' : '?'}: ${value.type}${value.description ? ` (${value.description})` : ''}`);
    return `- ${entry.name}: ${entry.description}\n  arguments: ${params.join('; ') || 'none'}`;
  });
  return `TOOL CALLS: this server has no native tool calling. To use a tool, write a block exactly like this:
${OPEN}
{"name": "read_file", "arguments": {"path": "notes.txt"}}
${CLOSE}
Rules: put only one JSON object inside each block. Use only the exact tool and argument names below.
You may write several blocks. After your last block STOP writing and wait. Results arrive in the next message
inside <tool_result> blocks. Never write <tool_result> yourself and never guess a tool result.
When no tool is needed, answer normally without any block.
Available tools:
${lines.join('\n')}`;
}

// Hides tool-call markup from the screen while a step streams.
export function visibleFilter(onText) {
  let raw = '';
  let shown = 0;
  return {
    push(delta) {
      raw += delta;
      const tag = raw.indexOf(OPEN);
      let end = tag >= 0 ? tag : raw.length;
      if (tag < 0) {
        // Hold back a suffix that may be the start of the tag.
        for (let size = Math.min(OPEN.length - 1, raw.length); size > 0; size--) {
          if (OPEN.startsWith(raw.slice(-size))) { end = raw.length - size; break; }
        }
      }
      if (end > shown) { onText(raw.slice(shown, end)); shown = end; }
    },
    flush() {
      if (!raw.includes(OPEN) && raw.length > shown) { onText(raw.slice(shown)); shown = raw.length; }
    },
  };
}

export function parseToolCalls(text) {
  const start = text.indexOf(OPEN);
  if (start < 0) return null;
  const calls = [];
  let index = start;
  while (index >= 0 && calls.length < MAX_CALLS) {
    const from = index + OPEN.length;
    const ends = [text.indexOf(CLOSE, from), text.indexOf(OPEN, from)].filter(i => i >= 0);
    const end = ends.length ? Math.min(...ends) : text.length;
    const segment = text.slice(from, end);
    if (segment.trim()) calls.push(parseSegment(segment));
    index = text.indexOf(OPEN, end);
  }
  return { before: text.slice(0, start).trimEnd(), calls };
}

export function formatCall({ name, args }) {
  return `${OPEN}\n${JSON.stringify({ name, arguments: args })}\n${CLOSE}`;
}

export function formatResults(results) {
  return results.map(({ name, result }) =>
    `<tool_result name="${name}">\n${result}\n</tool_result>`).join('\n') +
    '\nThese are tool results, not user messages. Call another tool if needed; otherwise answer the user briefly.';
}

function parseSegment(segment) {
  const source = segment.split('\n').filter(line => !/^\s*(```\w*|#+)\s*$/.test(line)).join('\n').trim();
  try {
    let name, args;
    if (source.startsWith('{')) {
      let object;
      try { object = looseJson(source.slice(0, balanced(source, 0, '{', '}', '"') + 1)); }
      catch {
        try { object = looseJson(source.slice(0, source.lastIndexOf('}') + 1)); }
        catch (error) { object = repairJson(source, error); }
      }
      name = object.name ?? object.tool ?? object.function?.name;
      args = object.arguments ?? object.parameters ?? object.args ?? object.function?.arguments ?? {};
      if (typeof args === 'string') args = looseJson(args);
    } else {
      const match = /^([A-Za-z_][\w.-]*)\s*\(/.exec(source);
      if (!match) throw new Error('beklenen biçim {"name": ..., "arguments": {...}}');
      name = match[1];
      const close = balanced(source, match[0].length - 1, '(', ')');
      args = parseKeywords(source.slice(match[0].length, close));
    }
    if (typeof name !== 'string' || !name) throw new Error('araç adı yok');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments bir JSON nesnesi olmalı');
    return { name: ALIASES[name] ?? name, args };
  } catch (error) {
    return { error: `Araç çağrısı okunamadı (${error.message}). Biçim: ${OPEN} {"name": "...", "arguments": {...}} ${CLOSE}` };
  }
}

// JSON that tolerates raw line breaks and tabs inside strings, which models often write in code arguments.
function looseJson(text) {
  try { return JSON.parse(text); } catch (error) {
    let fixed = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (inString && char === '\\') { fixed += char + (text[++i] ?? ''); continue; }
      if (char === '"') inString = !inString;
      fixed += inString ? ({ '\n': '\\n', '\r': '\\r', '\t': '\\t' }[char] ?? char) : char;
    }
    if (fixed === text) throw error;
    return JSON.parse(fixed);
  }
}

const JSON_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
const LITERALS = { true: true, false: false, null: null, True: true, False: false, None: null };
const REPAIR_TAIL = 12;

// Reads an object whose ending a model garbled after a long argument: a missing or wrong closing bracket
// ("})", "}]"), stray characters ("\n}}", "\"/>") or a half-written key ("\"}\"}}"). Repairs are accepted only
// at the very end: once one is made no more data may follow, so a call broken in the middle (for example an
// unescaped quote inside code) is still rejected instead of being cut short. Unknown escapes keep their
// backslash. Throws `original` when the text cannot be repaired.
function repairJson(text, original) {
  let i = 0;
  let repairedAt = -1;
  const repair = at => { if (repairedAt < 0) repairedAt = at; };
  const space = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const string = () => {
    let out = '';
    for (i++; i < text.length; i++) {
      const char = text[i];
      if (char === '"') { i++; return out; }
      if (char === '\\' && i + 1 < text.length) {
        const next = text[++i];
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
          out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4;
        } else out += JSON_ESCAPES[next] ?? '\\' + next;
      } else out += char;
    }
    return null;
  };
  const value = () => {
    space();
    if (repairedAt >= 0) throw original;
    if (text[i] === '{' || text[i] === '[') return container();
    if (text[i] === '"') { const out = string(); if (out === null) throw original; return out; }
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|True|False|None)/.exec(text.slice(i));
    if (!literal) throw original;
    i += literal[0].length;
    return literal[0] in LITERALS ? LITERALS[literal[0]] : Number(literal[0]);
  };
  const container = () => {
    const object = text[i] === '{';
    const out = object ? {} : [];
    i++;
    for (;;) {
      space();
      if (i >= text.length) { repair(i); return out; }
      const char = text[i];
      if (char === (object ? '}' : ']')) { i++; return out; }
      if ('}])'.includes(char)) { repair(i); i++; return out; }
      if (char === ',') { i++; continue; }
      if (!object) { out.push(value()); continue; }
      const at = i;
      if (char !== '"') { repair(at); i++; continue; }
      const key = string();
      space();
      if (key === null || text[i] !== ':') { repair(at); continue; }
      i++;
      out[key] = value();
    }
  };
  space();
  if (text[i] !== '{') throw original;
  const result = container();
  if (repairedAt >= 0 && text.slice(repairedAt).replace(/[\s{}[\]()]/g, '').length > REPAIR_TAIL) throw original;
  return result;
}

// Index of the bracket closing the one at `open`, skipping quoted strings.
function balanced(text, open, left, right, quotes = `"'`) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quotes.includes(char)) { i = readString(text, i).end - 1; continue; }
    if (char === left) depth++;
    else if (char === right && --depth === 0) return i;
  }
  throw new Error('kapanmamış parantez');
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' };

function readString(text, start) {
  const quote = text.startsWith(text[start].repeat(3), start) ? text[start].repeat(3) : text[start];
  let value = '';
  for (let i = start + quote.length; i < text.length; i++) {
    if (text.startsWith(quote, i)) return { value, end: i + quote.length };
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[++i];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
        value += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4;
      } else value += ESCAPES[next] ?? next;
    } else value += text[i];
  }
  throw new Error('kapanmamış metin');
}

// Parses key=value arguments such as path="a.txt", timeout=30.
function parseKeywords(text) {
  const source = text.trim();
  if (!source) return {};
  if (source.startsWith('{')) return JSON.parse(source);
  const args = {};
  let i = 0;
  const skip = () => { while (i < source.length && /[\s,]/.test(source[i])) i++; };
  while (skip(), i < source.length) {
    const key = /^["']?([A-Za-z_]\w*)["']?\s*[=:]\s*/.exec(source.slice(i));
    if (!key) throw new Error('argümanlar ad=değer biçiminde olmalı');
    i += key[0].length;
    if (source[i] === '"' || source[i] === "'") {
      const { value, end } = readString(source, i);
      args[key[1]] = value; i = end;
    } else {
      const literal = /^[^\s,]+/.exec(source.slice(i))[0];
      const words = { true: true, false: false, True: true, False: false, null: null, None: null };
      if (literal in words) args[key[1]] = words[literal];
      else if (/^-?\d+$/.test(literal)) args[key[1]] = Number(literal);
      else throw new Error(`desteklenmeyen değer: ${literal.slice(0, 40)}`);
      i += literal.length;
    }
  }
  return args;
}
