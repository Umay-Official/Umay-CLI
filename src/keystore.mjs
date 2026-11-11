// Keeps the API key on this computer so it is asked once, not at every start.
// Windows: encrypted with DPAPI for the current Windows user (the protection Credential Manager uses), via
// PowerShell. macOS: the login keychain. Elsewhere: a plain file only the owner can read.
// The key travels through stdin, never on a command line, where other processes could see it.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SERVICE = 'umay-cli';
const dir = () => path.dirname(process.env.UMAY_SETTINGS || path.join(os.homedir(), '.umay', 'ayarlar.json'));
const platform = () => process.env.UMAY_KEYSTORE_PLATFORM || process.platform;

export const keyFile = () => path.join(dir(), platform() === 'win32' ? 'anahtar.dpapi' : 'anahtar');
export const storeName = () => ({ win32: 'Windows DPAPI ile şifreli', darwin: 'macOS Anahtar Zinciri' })[platform()]
  ?? 'yalnızca senin okuyabildiğin dosya, şifresiz';

function run(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// One PowerShell call that reads stdin and writes the result to stdout.
function powershell(body, input) {
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $e=New-Object Text.UTF8Encoding $false; "
    + "[Console]::OutputEncoding=$e; $in=[Console]::In.ReadToEnd(); $x=$e.GetBytes('umay-cli'); " + body;
  return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], input);
}

const PROTECT = "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($e.GetBytes($in), $x, 'CurrentUser')))";
const UNPROTECT = "[Console]::Out.Write($e.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in.Trim()), $x, 'CurrentUser')))";

async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The stored key, or null when there is none or it cannot be read (another Windows user, a damaged file).
export async function loadKey() {
  try {
    if (platform() === 'darwin') {
      return (await run('security', ['find-generic-password', '-s', SERVICE, '-a', SERVICE, '-w'], '')).trim() || null;
    }
    const stored = await readText(keyFile());
    if (!stored?.trim()) return null;
    if (platform() === 'win32') return (await powershell(UNPROTECT, stored)).trim() || null;
    return stored.trim();
  } catch { return null; }
}

export async function saveKey(key) {
  key = String(key ?? '').trim();
  if (!key) throw new Error('Boş anahtar kaydedilemez.');
  if (/[\s"\\]/.test(key)) throw new Error('Anahtar boşluk, tırnak veya ters bölü içeremez.');
  if (platform() === 'darwin') {
    await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${SERVICE} -w "${key}"\n`);
    return;
  }
  await mkdir(dir(), { recursive: true });
  const file = keyFile();
  const data = platform() === 'win32' ? await powershell(PROTECT, key) : key;
  await writeFile(file, `${data.trim()}\n`, { mode: 0o600 });
  if (platform() !== 'win32') await chmod(file, 0o600);
}

// True when something was removed.
export async function deleteKey() {
  if (platform() === 'darwin') {
    try { await run('security', ['delete-generic-password', '-s', SERVICE, '-a', SERVICE], ''); return true; } catch { return false; }
  }
  const existed = (await readText(keyFile())) !== null;
  await rm(keyFile(), { force: true });
  return existed;
}
