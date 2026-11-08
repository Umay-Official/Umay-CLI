"""Modelin kullanabileceği araçlar: JSON şema tanımları ve uygulamaları."""
# Kaynak: Gambit AI CLI, ai-cli/tools.py (https://github.com/cekYc/gambit-ai-cli). Copyright (c) 2026 Eray Çiçek.
# Lisans: Umay CLI LICENSE dosyası (PolyForm Noncommercial 1.0.0 + Umay için ek izin).

import difflib
import fnmatch
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

MAX_OUTPUT = 20_000  # modele dönen tek bir araç çıktısının üst sınırı (karakter)
MAX_FILE_BYTES = 2_000_000
MAX_ENTRIES = 500
SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "build"}
CODE_EXTS = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".ps1", ".sh", ".go", ".rs", ".java", ".c", ".cpp",
             ".cs", ".php", ".rb"}
LINE_PREFIX = re.compile(r"^ *\d+→")  # read_file'ın eklediği satır numarası; modeller bazen old_text'e kopyalıyor
STDERR_WARNING = "ancak stderr'de hata mesajı var"
UNDO: list[tuple[Path, bytes | None]] = []  # yazma araçlarından önceki hâller (/undo için); None: dosya yoktu
UNDO_LIMIT = 50
CANCELLED = threading.Event()


class ToolError(Exception):
    """Modele hata mesajı olarak dönen, beklenen hatalar."""


@dataclass
class Tool:
    description: str
    parameters: dict
    run: Callable[..., str]
    needs_approval: bool = False
    preview: Callable[..., str] | None = None
    preview_lexer: str = "diff"
    echo_lines: int = 1  # sonuçtan ekranda gösterilecek satır sayısı


def truncate(text: str, limit: int = MAX_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    return (text[:limit] + f"\n... [kesildi: {len(text) - limit} karakter daha var; dosyaysa read_file ile start_line/"
            "max_lines vererek parça parça oku, komutsa çıktıyı daralt]")


def _path(path: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(path))).resolve()


def _size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def _is_binary(p: Path) -> bool:
    with open(p, "rb") as f:
        return b"\0" in f.read(8192)


def _read_raw(p: Path, strict: bool = False) -> str:
    if not p.is_file():
        raise ToolError(f"dosya bulunamadı: {p}")
    if p.stat().st_size > MAX_FILE_BYTES:
        raise ToolError(f"dosya çok büyük ({_size(p.stat().st_size)}): {p}")
    if _is_binary(p):
        raise ToolError(f"ikili (binary) dosya, metin olarak okunamaz: {p}")
    try:
        with open(p, encoding="utf-8", errors="strict" if strict else "replace", newline="") as f:
            return f.read()
    except UnicodeDecodeError:
        raise ToolError(f"dosya UTF-8 değil, bozulmaması için düzenlenmedi: {p}")


def _remember(p: Path) -> None:
    """Dosyanın yazılmadan önceki hâlini /undo için saklar."""
    UNDO.append((p, p.read_bytes() if p.is_file() else None))
    del UNDO[:-UNDO_LIMIT]


def undo_last() -> str | None:
    """Araçların yaptığı son dosya değişikliğini geri alır; geri alınacak bir şey yoksa None."""
    if not UNDO:
        return None
    p, old = UNDO.pop()
    if old is None:
        p.unlink(missing_ok=True)
        return f"silindi (araçla oluşturulmuştu): {p}"
    p.write_bytes(old)
    return f"eski hâline döndü: {p}"


def _write(p: Path, text: str, crlf: bool) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    text = text.replace("\r\n", "\n")
    if crlf:
        text = text.replace("\n", "\r\n")
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def _diff(p: Path, old: str, new: str) -> str:
    lines = difflib.unified_diff(old.splitlines(), new.splitlines(), f"a/{p.name}", f"b/{p.name}", n=2, lineterm="")
    return "\n".join(lines) or "(değişiklik yok)"


def _numbered(lines: list[str], start: int) -> str:
    return "\n".join(f"{i:>5}→{line}" for i, line in enumerate(lines, start))


# --- süreç çalıştırma ---

def _find_shell() -> tuple[list[str], str]:
    if os.name != "nt":
        return ["/bin/sh", "-c"], "sh"
    for exe, name in (("pwsh", "PowerShell 7"), ("powershell", "Windows PowerShell 5.1")):
        if path := shutil.which(exe):
            return [path, "-NoProfile", "-NonInteractive", "-Command"], name
    return ["cmd", "/c"], "cmd"


SHELL, SHELL_NAME = _find_shell()
POWERSHELL = "PowerShell" in SHELL_NAME
_PS_PRELUDE = ("[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; "
               "$ProgressPreference = 'SilentlyContinue'; ")
if SHELL_NAME.endswith("5.1"):
    # Windows PowerShell 5.1'de > ve Out-File varsayılan olarak UTF-16 yazıyor; diğer araçlar okuyamıyor
    _PS_PRELUDE += ("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; "
                    "$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'; "
                    "$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'; ")


def _shell_args(command: str) -> list[str]:
    return [*SHELL, _PS_PRELUDE + command if POWERSHELL else command]


def _python_exe() -> str:
    for name in ("python", "python3", "py"):
        path = shutil.which(name)
        if path and "WindowsApps" not in path:  # Microsoft Store kısayolu Python değil, mağazayı açar
            return path
    return sys.executable


def environment() -> tuple[list[str], list[str]]:
    """Komut satırından kullanılabilen ve kurulu olmayan yaygın programlar."""
    def found(name: str) -> bool:
        if name == "python":
            return any((p := shutil.which(n)) and "WindowsApps" not in p for n in ("python", "python3", "py"))
        return bool(shutil.which(name))

    names = ["python", "node", "npm", "git", "sqlite3"]
    have = [n for n in names if found(n)]
    return have, [n for n in names if n not in have]


def _kill_tree(p: subprocess.Popen) -> None:
    """Süreci başlattığı alt süreçlerle birlikte kapatır (yalnızca kabuğu kapatmak sonsuz döngüleri arkada bırakır)."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
    else:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            p.kill()
    try:
        p.communicate(timeout=10)
    except (subprocess.TimeoutExpired, ValueError, OSError):
        pass


def _run_process(argv: list[str], timeout: int, stdin_text: str | None = None,
                 env: dict | None = None) -> tuple[int, str, str]:
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL if stdin_text is None else subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                         env=env, start_new_session=os.name != "nt")
    deadline = time.monotonic() + timeout
    first = True
    try:
        while True:
            if CANCELLED.is_set():
                _kill_tree(p)
                raise ToolError("Kullanıcı iptal etti; komut ve alt süreçleri durduruldu.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(argv, timeout)
            try:
                out, err = p.communicate(stdin_text if first else None, timeout=min(0.1, remaining))
                break
            except subprocess.TimeoutExpired:
                first = False
    except subprocess.TimeoutExpired:
        _kill_tree(p)
        raise ToolError(f"komut {timeout} saniyede bitmedi; komut ve başlattığı tüm süreçler durduruldu "
                        "(sonsuz döngü ya da girdi bekleyen bir program olabilir)")
    except KeyboardInterrupt:
        _kill_tree(p)
        raise
    return p.returncode, out, err


def _result(code: int, out: str, err: str, shell: bool) -> str:
    head = f"çıkış kodu: {code}"
    if code == 0 and err.strip() and shell and POWERSHELL:
        # PowerShell çoğu hatada komutu sürdürüp 0 ile çıkıyor; model başarılı sanmasın
        head += f" ({STDERR_WARNING}; PowerShell bazı hatalarda çıkış kodunu değiştirmez)"
    parts = [head]
    if out.strip():
        parts.append(out.strip())
    if err.strip():
        parts.append("[stderr]\n" + err.strip())
    return "\n".join(parts)


def _timeout(timeout) -> int:
    return min(max(int(timeout), 1), 600)


def run_command(command: str, timeout: int = 120) -> str:
    code, out, err = _run_process(_shell_args(command), _timeout(timeout))
    return _result(code, out, err, shell=True)


def run_python(code: str, timeout: int = 120) -> str:
    # Kod stdin'den verilir: kabuk tırnaklama sorunu yok, geçici dosya yok ve bulunduğun klasördeki modüller içe aktarılabilir
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    rc, out, err = _run_process([_python_exe(), "-B", "-"], _timeout(timeout), stdin_text=code, env=env)
    return _result(rc, out, err, shell=False)


# --- yazmadan sonra denetim ---

def _syntax_check(p: Path, text: str) -> str | None:
    """Sözdizimi hatasının açıklaması; sorun yoksa "", bu dosya türü denetlenemiyorsa None."""
    ext = p.suffix.lower()
    if ext == ".py":
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                compile(text, str(p), "exec", dont_inherit=True)
            except SyntaxError as e:
                where = f"satır {e.lineno}" + (f", sütun {e.offset}" if e.offset else "")
                return f"{e.msg} ({where})" + (f": {e.text.strip()}" if e.text and e.text.strip() else "")
            except ValueError as e:
                return str(e)
        return ""
    if ext == ".json":
        try:
            json.loads(text)
        except ValueError as e:
            return str(e)
        return ""
    if ext in (".js", ".mjs", ".cjs") and (node := shutil.which("node")):
        try:
            code, out, err = _run_process([node, "--check", str(p)], 20)
        except ToolError:
            return None
        if code == 0:
            return ""
        lines = [line for line in (err or out).strip().splitlines() if line.strip()]
        return "\n".join(lines[:8])
    return None


def _after_write(p: Path, text: str) -> str:
    """Kod dosyası yazıldıysa sözdizimi denetiminin sonucu ve doğrulama hatırlatması (küçük modeller sistem mesajındaki
    kuralı unutuyor)."""
    ext = p.suffix.lower()
    check = _syntax_check(p, text)
    if check:
        return f"\nSYNTAX ERROR: {check}\nThe file was saved but does not compile. Fix it next."
    note = "\nSyntax check: OK." if check == "" else ""
    if ext not in CODE_EXTS:
        return note
    return note + ("\nNext step: before finishing, run this code yourself (its tests, or a short script with run_python "
                   "or run_command); a syntax check alone is not verification. Do not ask the user to run it. "
                   "Do not start servers or other commands that never finish.")


def _walk_files(root: Path, pattern: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if fnmatch.fnmatch(name.lower(), pattern.lower()):
                yield Path(dirpath) / name


# --- okuma araçları (onay gerekmez) ---

def read_file(path: str, start_line: int = 1, max_lines: int = 400) -> str:
    p = _path(path)
    lines = _read_raw(p).replace("\r\n", "\n").split("\n")
    if len(lines) > 1 and lines[-1] == "":
        lines.pop()  # dosya sonundaki satır sonu ayrı bir satır sayılmasın
    start = max(1, int(start_line))
    end = min(len(lines), start + max(1, int(max_lines)) - 1)
    body = _numbered(lines[start - 1 : end], start)
    more = f"\n... ({len(lines) - end} satır daha var; devamı için start_line={end + 1})" if end < len(lines) else ""
    return f"{p} ({len(lines)} satır; soldaki numaralar ve → işareti dosyaya ait değildir)\n{body}{more}"


def list_dir(path: str = ".", pattern: str = "*", recursive: bool = False) -> str:
    root = _path(path)
    if not root.is_dir():
        raise ToolError(f"klasör bulunamadı: {root}")
    rows = []
    if recursive:
        for fp in _walk_files(root, pattern):
            rows.append(str(fp.relative_to(root)))
            if len(rows) >= MAX_ENTRIES:
                break
    else:
        entries = sorted(root.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
        for e in entries:
            if not fnmatch.fnmatch(e.name.lower(), pattern.lower()):
                continue
            try:
                rows.append(f"{e.name}/" if e.is_dir() else f"{e.name}  ({_size(e.stat().st_size)})")
            except OSError:
                rows.append(e.name)
            if len(rows) >= MAX_ENTRIES:
                break
    if not rows:
        return f"{root}: eşleşen öğe yok"
    more = f"\n... (ilk {MAX_ENTRIES} öğe gösterildi)" if len(rows) >= MAX_ENTRIES else ""
    return f"{root} ({len(rows)} öğe)\n" + "\n".join(rows) + more


def search_files(pattern: str, path: str = ".", file_pattern: str = "*") -> str:
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise ToolError(f"geçersiz regex: {e}")
    root = _path(path)
    if root.is_file():
        candidates, root = [root], root.parent
    elif root.is_dir():
        candidates = _walk_files(root, file_pattern)
    else:
        raise ToolError(f"yol bulunamadı: {root}")
    hits = []
    for fp in candidates:
        try:
            if fp.stat().st_size > MAX_FILE_BYTES or _is_binary(fp):
                continue
            with open(fp, encoding="utf-8", errors="replace") as f:
                for n, line in enumerate(f, 1):
                    if rx.search(line):
                        hits.append(f"{fp.relative_to(root)}:{n}: {line.strip()[:200]}")
                        if len(hits) >= 200:
                            return "\n".join(hits) + "\n... (ilk 200 eşleşme gösterildi)"
        except OSError:
            continue
    return "\n".join(hits) if hits else "eşleşme yok"


# --- yazma araçları (onay gerekir) ---

def _shrink_warning(p: Path, new: str) -> str:
    """Var olan uzun bir dosya çok daha kısa bir içerikle ezilecekse uyarı (modeller bazen yalnızca değişen kısmı yazıp
    dosyanın geri kalanını siliyor)."""
    if not p.is_file():
        return ""
    try:
        old_lines = len(_read_raw(p).splitlines())
    except ToolError:
        return ""
    new_lines = len(new.splitlines())
    if old_lines >= 30 and new_lines < old_lines * 0.5:
        return (f"Warning: this replaced a {old_lines}-line file with only {new_lines} lines. write_file overwrites the "
                "WHOLE file; if you meant to change only part of it, the rest of the file is now gone: write the "
                "complete file again (use edit_file for partial changes).")
    return ""


def write_file_preview(path: str, content: str) -> str:
    p = _path(path)
    if p.exists():
        warning = _shrink_warning(p, content)
        return (f"# UYARI: {warning}\n" if warning else "") + _diff(p, _read_raw(p).replace("\r\n", "\n"), content)
    return f"+++ {p} (yeni dosya)\n" + "\n".join("+" + line for line in content.splitlines())


def write_file(path: str, content: str) -> str:
    p = _path(path)
    crlf = p.exists() and "\r\n" in _read_raw(p)
    warning = _shrink_warning(p, content)
    _remember(p)
    _write(p, content, crlf)
    return (f"yazıldı: {p} ({len(content.splitlines())} satır)" + (f"\n{warning}" if warning else "")
            + _after_write(p, content))


def _strip_line_numbers(text: str) -> tuple[str, bool]:
    lines = text.split("\n")
    filled = [line for line in lines if line.strip()]
    if not filled or not all(LINE_PREFIX.match(line) for line in filled):
        return text, False
    return "\n".join(LINE_PREFIX.sub("", line, count=1) for line in lines), True


def _loose_replace(text: str, old: str, new: str) -> str | None:
    """Satır sonu boşlukları yok sayılınca old tam satırlar olarak tek bir yerde geçiyorsa değiştirilmiş metin."""
    lines, old_lines, new_lines = text.split("\n"), old.split("\n"), new.split("\n")
    if len(old_lines) > 1 and old_lines[-1] == "":
        old_lines = old_lines[:-1]
        if len(new_lines) > 1 and new_lines[-1] == "":
            new_lines = new_lines[:-1]
    key = [line.rstrip() for line in old_lines]
    if not any(key):
        return None
    stripped = [line.rstrip() for line in lines]
    n = len(key)
    hits = [i for i in range(len(lines) - n + 1) if stripped[i] == key[0] and stripped[i : i + n] == key]
    if len(hits) != 1:
        return None
    i = hits[0]
    return "\n".join(lines[:i] + new_lines + lines[i + n :])


def _closest(text: str, old: str) -> str:
    """old_text bulunamayınca dosyada ona en çok benzeyen kısım (modelin tekrar okumasına gerek kalmasın)."""
    lines = text.split("\n")
    want = [line.strip() for line in old.strip("\n").split("\n")]
    n = len(want)
    if not lines or not any(want):
        return ""
    target = "\n".join(want)
    stripped = [line.strip() for line in lines]
    scored = []
    for i in range(max(1, len(lines) - n + 1)):
        sm = difflib.SequenceMatcher(None, "\n".join(stripped[i : i + n]), target, autojunk=False)
        scored.append((sm.quick_ratio(), i, sm))
    best_ratio, best = 0.0, -1
    for _, i, sm in sorted(scored, key=lambda s: s[0], reverse=True)[:5]:
        if (r := sm.ratio()) > best_ratio:
            best_ratio, best = r, i
    if best < 0 or best_ratio < 0.5:
        return " Dosyada benzer bir kısım da yok; dosyayı read_file ile tekrar oku."
    a, b = max(0, best - 1), min(len(lines), best + n + 1)
    region = _numbered(lines[a:b][:60], a + 1)
    return (f"\nDosyada en çok benzeyen kısım (satır {a + 1}-{b}, benzerlik %{best_ratio * 100:.0f}). old_text'i buradan "
            f"birebir, satır numaraları ve → olmadan kopyala:\n{region}")


def _edit_target(path: str, old_text: str, new_text: str) -> tuple[Path, str, str, bool]:
    p = _path(path)
    raw = _read_raw(p, strict=True)
    text = raw.replace("\r\n", "\n")
    old_text, numbered = _strip_line_numbers(old_text.replace("\r\n", "\n"))
    new_text = new_text.replace("\r\n", "\n")
    if numbered:
        new_text = _strip_line_numbers(new_text)[0]
    if not old_text:
        raise ToolError("old_text boş olamaz")
    count = text.count(old_text)
    if count == 1:
        return p, text, text.replace(old_text, new_text, 1), "\r\n" in raw
    if count > 1:
        where = [text[: m.start()].count("\n") + 1 for m in re.finditer(re.escape(old_text), text)]
        raise ToolError(f"old_text dosyada {count} kez geçiyor (satır {', '.join(map(str, where[:10]))}); "
                        "çevresinden birkaç satır daha ekleyerek benzersiz yap")
    loose = _loose_replace(text, old_text, new_text)
    if loose is not None:
        return p, text, loose, "\r\n" in raw
    raise ToolError("old_text dosyada bulunamadı." + _closest(text, old_text))


def edit_file_preview(path: str, old_text: str, new_text: str) -> str:
    p, old, new, _ = _edit_target(path, old_text, new_text)
    return _diff(p, old, new)


def edit_file(path: str, old_text: str, new_text: str) -> str:
    p, _, new, crlf = _edit_target(path, old_text, new_text)
    _remember(p)
    _write(p, new, crlf)
    return f"düzenlendi: {p}" + _after_write(p, new)


def _schema(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required}


_SHELL_HINT = (f" Use {SHELL_NAME} syntax, not bash; inside double quotes \\\" is NOT an escaped quote in PowerShell."
               if POWERSHELL else "")

TOOLS: dict[str, Tool] = {
    "read_file": Tool(
        "Read a text file. Each returned line starts with its line number and an arrow, like '    3→text'; "
        "the number and the arrow are NOT part of the file content.",
        _schema({
            "path": {"type": "string", "description": "File path"},
            "start_line": {"type": "integer", "description": "First line to return (1-based). Default 1"},
            "max_lines": {"type": "integer", "description": "Maximum number of lines. Default 400"},
        }, ["path"]),
        read_file,
    ),
    "list_dir": Tool(
        "List files and folders. With recursive=true, lists matching files in all subfolders "
        "(use this to find files by name).",
        _schema({
            "path": {"type": "string", "description": "Folder path. Default: current directory"},
            "pattern": {"type": "string", "description": "Name filter like *.py. Default *"},
            "recursive": {"type": "boolean", "description": "Search subfolders. Default false"},
        }, []),
        list_dir,
    ),
    "search_files": Tool(
        "Search inside files with a case-insensitive regex. Returns file:line: text matches.",
        _schema({
            "pattern": {"type": "string", "description": "Regular expression to search for"},
            "path": {"type": "string", "description": "Folder or file to search. Default: current directory"},
            "file_pattern": {"type": "string", "description": "Only search files matching this name filter, like *.py"},
        }, ["pattern"]),
        search_files,
    ),
    "write_file": Tool(
        "Create a new file or completely overwrite an existing one with the full content. Parent folders are created. "
        "Code files are syntax-checked automatically. Requires user approval.",
        _schema({
            "path": {"type": "string", "description": "File path"},
            "content": {"type": "string", "description": "Full file content"},
        }, ["path", "content"]),
        write_file, needs_approval=True, preview=write_file_preview,
    ),
    "edit_file": Tool(
        "Replace one exact occurrence of old_text with new_text in a file. old_text must match the file "
        "exactly (copy it from read_file output without line numbers) and be unique. Requires user approval.",
        _schema({
            "path": {"type": "string", "description": "File path"},
            "old_text": {"type": "string", "description": "Exact existing text to replace"},
            "new_text": {"type": "string", "description": "Replacement text"},
        }, ["path", "old_text", "new_text"]),
        edit_file, needs_approval=True, preview=edit_file_preview,
    ),
    "run_command": Tool(
        f"Run a shell command ({SHELL_NAME}) in the current directory and return its exit code and output."
        f"{_SHELL_HINT} For Python code use run_python instead of python -c. Requires user approval. "
        "Do not run interactive commands or servers.",
        _schema({
            "command": {"type": "string", "description": "Command to run"},
            "timeout": {"type": "integer", "description": "Seconds before the command is stopped. Default 120"},
        }, ["command"]),
        run_command, needs_approval=True, preview=lambda command, timeout=120: command,
        preview_lexer="powershell" if os.name == "nt" else "bash", echo_lines=20,
    ),
    "run_python": Tool(
        "Run a Python script in the current directory and return its exit code and output. Pass the code itself "
        "(multi-line is fine, no shell quoting needed). Best way to test code, query SQLite databases (import sqlite3) "
        "or process files and data. Modules in the current directory can be imported. stdin is empty, so input() "
        "does not work. Requires user approval.",
        _schema({
            "code": {"type": "string", "description": "Python source code to run"},
            "timeout": {"type": "integer", "description": "Seconds before the script is stopped. Default 120"},
        }, ["code"]),
        run_python, needs_approval=True, preview=lambda code, timeout=120: code, preview_lexer="python", echo_lines=20,
    ),
}


def schemas() -> list[dict]:
    return [
        {"type": "function", "function": {"name": name, "description": t.description, "parameters": t.parameters}}
        for name, t in TOOLS.items()
    ]
