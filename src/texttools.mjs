// Text tool-call protocol for servers that ignore the native `tools` field.
// The model writes <tool_call> blocks in plain text; only these blocks are executed.

export const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';
const FORMAT = `${OPEN} {"name": "...", "arguments": {...}} ${CLOSE}`;
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

// `tools` is the bridge's tool list (name, parameters); with it, arguments written in the wrong place are
// put where they belong (see placeArguments).
export function parseToolCalls(text, tools = []) {
  const start = text.indexOf(OPEN);
  if (start < 0) return null;
  const schemas = new Map(tools.map(entry => [entry.name, entry.parameters ?? {}]));
  const calls = [];
  let index = start;
  while (index >= 0 && calls.length < MAX_CALLS) {
    const from = index + OPEN.length;
    const ends = [text.indexOf(CLOSE, from), text.indexOf(OPEN, from)].filter(i => i >= 0);
    const end = ends.length ? Math.min(...ends) : text.length;
    const segment = text.slice(from, end);
    if (segment.trim()) calls.push(parseSegment(segment, schemas));
    index = text.indexOf(OPEN, end);
  }
  // The model must hear about calls that did not run; otherwise it assumes they did.
  if (index >= 0 && text.slice(index).replaceAll(OPEN, '').replaceAll(CLOSE, '').trim()) calls.push({ error: `Bir yanıtta en fazla ${MAX_CALLS} araç çağrısı çalıştırılır; sonrakiler çalıştırılmadı. Gerekiyorsa yeniden çağır.` });
  if (!calls.length) calls.push({ error: `Araç çağrısı boş ya da yarım kaldı. Biçim: ${FORMAT}` });
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

// Lines holding only a code fence mark or "#" around a call are decoration. The same lines inside a
// multi-line argument are file content, so only the leading and trailing ones are dropped.
function unwrap(segment) {
  const lines = segment.split('\n');
  const decoration = line => /^\s*(```\w*|#+)?\s*$/.test(line);
  let first = 0;
  let last = lines.length;
  while (first < last && decoration(lines[first])) first++;
  while (last > first && decoration(lines[last - 1])) last--;
  return lines.slice(first, last).join('\n').trim();
}

const argumentKeys = schemas => new Set(['name', 'arguments', 'parameters', 'args',
  ...[...schemas.values()].flatMap(schema => Object.keys(schema.properties ?? {}))]);

function parseSegment(segment, schemas = new Map()) {
  const source = unwrap(segment);
  try {
    let name, args;
    let beside = {};
    if (source.startsWith('{')) {
      let object;
      try { object = looseJson(source.slice(0, balanced(source, 0, '{', '}', '"') + 1)); }
      catch {
        try { object = looseJson(source.slice(0, source.lastIndexOf('}') + 1)); }
        catch (error) {
          // Unescaped quotes are tried first: the plain repair would end the value at its first quote.
          try {
            if (!schemas.size) throw error;
            object = repairJson(source, error, argumentKeys(schemas));
          } catch { object = repairJson(source, error); }
        }
      }
      name = object.name ?? object.tool ?? object.function?.name;
      args = object.arguments ?? object.parameters ?? object.args ?? object.function?.arguments ?? {};
      beside = object;
    } else {
      const match = /^([A-Za-z_][\w.-]*)\s*\(/.exec(source);
      if (!match) throw new Error('beklenen biçim {"name": ..., "arguments": {...}}');
      name = match[1];
      const close = balanced(source, match[0].length - 1, '(', ')');
      args = parseKeywords(source.slice(match[0].length, close));
    }
    if (typeof name !== 'string' || !name) throw new Error('araç adı yok');
    // hasOwn: a made-up name such as "constructor" must not find a method of the object.
    if (Object.hasOwn(ALIASES, name)) name = ALIASES[name];
    args = placeArguments(args, beside, schemas.get(name));
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments bir JSON nesnesi olmalı');
    return { name, args };
  } catch (error) {
    return { error: `Araç çağrısı okunamadı (${error.message}). Biçim: ${FORMAT}` };
  }
}

// Shapes Umay models write instead of {"arguments": {...}} (benchmark logs, 9-10 Nov 2026): the object as a JSON
// string; the one required argument as a bare string ("arguments": "notes.txt", sometimes "code:\n..."); and
// further arguments beside "arguments" instead of inside it ("arguments": {...}, "timeout": 60).
// `schema` is the tool's parameter schema; without it only the JSON string form is read.
function placeArguments(args, beside, schema) {
  const known = schema?.properties ?? {};
  if (typeof args === 'string') {
    let decoded;
    try { decoded = looseJson(args); } catch (error) { if (!schema) throw error; }
    if (decoded && typeof decoded === 'object') args = decoded;
    else {
      const required = schema?.required ?? [];
      const key = required.length === 1 ? required[0] : required.length ? undefined : Object.keys(known)[0];
      // A path never spans lines; such a string holds more than the path ("a.py\n,max_lines:20").
      if (!key || (key === 'path' && /[\r\n]/.test(args))) throw new Error('arguments bir JSON nesnesi olmalı');
      // "code:" on a line of its own before the code is a label, not code.
      args = { [key]: args.replace(new RegExp(`^${key.replace(/\W/g, '\\$&')}:[ \\t]*\\r?\\n`), '') };
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  for (const [key, value] of Object.entries(beside)) {
    if (!Object.hasOwn(known, key)) continue;
    if (!Object.hasOwn(args, key)) args = { ...args, [key]: value };
    // Which of two different values was meant is not guessed.
    else if (JSON.stringify(args[key]) !== JSON.stringify(value)) throw new Error(`"${key}" iki farklı değerle yazılmış`);
  }
  return args;
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
//
// With `keys` (the names that may follow a value: the tools' arguments, "name", "arguments") quotes inside a
// value need not be escaped, as in "code": "print("a")". A quote then ends the value only where the call
// goes on or ends: before , "known key": or before nothing but closing brackets. Any other quote is content,
// so the value is read whole; it is never cut at the first quote.
function repairJson(text, original, keys) {
  let i = 0;
  let repairedAt = -1;
  const seen = new Set();
  const repair = at => { if (repairedAt < 0) repairedAt = at; };
  const space = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const nextKey = /[\s}\])]*,?\s*\{?\s*"([A-Za-z_]\w*)"\s*:/y;
  const ends = (at, soFar) => {
    // "arguments": "command": "dir" (inner braces left out): the value is itself the next key.
    if (keys.has(soFar) && /^\s*:/.test(text.slice(at, at + 20))) return true;
    nextKey.lastIndex = at;
    const key = nextKey.exec(text)?.[1];
    if (key) return keys.has(key);
    const rest = text.slice(at);
    return !rest.includes('"') && /^\s*([}\])]|$)/.test(rest) && rest.replace(/[\s{}[\]()]/g, '').length <= REPAIR_TAIL;
  };
  const string = (value = false) => {
    let out = '';
    for (i++; i < text.length; i++) {
      const char = text[i];
      if (char === '"' && value && keys && !ends(i + 1, out)) { out += char; continue; }
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
    if (text[i] === '"') { const out = string(true); if (out === null) throw original; return out; }
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
      if (char === '{') {
        // {"arguments": {"path": "a"}, {"max_lines": 20}}: the object was closed early and continued in a new
        // one. Its entries are complete JSON, so they are taken as written; a conflicting key is not guessed.
        if (repairedAt >= 0) throw original;
        for (const [key, item] of Object.entries(container())) {
          if (Object.hasOwn(out, key) && JSON.stringify(out[key]) !== JSON.stringify(item)) throw original;
          out[key] = item;
        }
        continue;
      }
      // A colon where a key should start means the value before it swallowed the next key ("...\",\"timeout": 60).
      if (char === ':') throw original;
      // Words after a value are the rest of a value that an unescaped quote ended early, not stray marks.
      if (/[\p{L}\p{N}]/u.test(char) && text[i - 1] !== '\\') throw original;
      if (char !== '"') { repair(at); i++; continue; }
      const key = string();
      space();
      if (key === null || text[i] !== ':') { repair(at); continue; }
      i++;
      // Reading unescaped quotes: a key that is not an argument, or comes twice anywhere in the call, means a
      // quote inside the content was taken for the end of a value (a JSON file with a "name" key, for example).
      if (keys && (!keys.has(key) || seen.has(key))) throw original;
      seen.add(key);
      out[key] = value();
      space();
      // "arguments": "command": "dir": the braces of the inner object were left out. Only a plain name can be
      // the key of that object; anything else before a colon is a value that swallowed the next key.
      if (typeof out[key] === 'string' && text[i] === ':' && /^[A-Za-z_]\w*$/.test(out[key])) { i++; out[key] = { [out[key]]: value() }; }
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
      // As in Python, an unknown escape keeps its backslash: "C:\Users" and "\d+" stay as written.
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
        value += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4;
      } else value += ESCAPES[next] ?? (`\\'"`.includes(next) ? next : '\\' + next);
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
