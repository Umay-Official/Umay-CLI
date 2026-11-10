// Local memory: short notes the user keeps in a plain text file; they are sent to Umay with every request.
// Umay's own memory works only on the website (account-bound /api/memory), so the CLI keeps its own.
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const HEADER = '# Umay CLI belleği\n# Her "- " ile başlayan satır bir not. Bu dosyayı elle de düzenleyebilirsin.\n';
export const MEMORY_LIMIT = 4000; // characters sent per request; older notes beyond this are left out

export class Memory {
  constructor(file) {
    this.file = file;
    this.items = [];
  }

  load() {
    try {
      this.items = readFileSync(this.file, 'utf8').split(/\r?\n/)
        .filter(line => line.startsWith('- ')).map(line => line.slice(2).trim()).filter(Boolean);
    } catch { this.items = []; }
    return this;
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, HEADER + this.items.map(item => `- ${item}`).join('\n') + (this.items.length ? '\n' : ''), 'utf8');
  }

  async add(text) {
    const note = text.replace(/\s+/g, ' ').trim();
    if (!note) throw new Error('Not boş olamaz.');
    if (this.items.some(item => item.toLocaleLowerCase('tr') === note.toLocaleLowerCase('tr'))) return false;
    this.items.push(note);
    await this.save();
    return true;
  }

  async remove(number) {
    const index = Number(number) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) {
      throw new Error(`Geçerli bir not numarası yaz (1–${this.items.length || 0}).`);
    }
    const [removed] = this.items.splice(index, 1);
    await this.save();
    return removed;
  }

  async clear() {
    this.items = [];
    await this.save();
  }

  // The newest notes win when the total is over the limit.
  systemText() {
    if (!this.items.length) return '';
    const kept = [];
    let size = 0;
    for (const item of [...this.items].reverse()) {
      if (size + item.length > MEMORY_LIMIT) break;
      kept.unshift(item);
      size += item.length + 3;
    }
    // A single note over the limit leaves nothing to send; a heading without notes would only confuse.
    if (!kept.length) return '';
    return 'Kullanıcının seni hatırlaman için yazdığı kalıcı notlar. Yalnızca konuyla ilgili olduğunda kullan; '
      + 'notlardan söz edildiğinde onları kullanıcının kendi bilgileri olarak kabul et.\n'
      + kept.map(item => `- ${item}`).join('\n');
  }

  // Inserts the notes as a system message after the leading system messages of a request.
  apply(messages, enabled = true) {
    const text = enabled ? this.systemText() : '';
    if (!text) return messages;
    const at = messages.findIndex(message => message.role !== 'system');
    const index = at < 0 ? messages.length : at;
    return [...messages.slice(0, index), { role: 'system', content: text }, ...messages.slice(index)];
  }
}
