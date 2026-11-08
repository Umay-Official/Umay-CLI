"""JSON-lines adapter between the Node.js CLI and tools.py (from Gambit AI CLI). Standard library only."""
import hashlib
import inspect
import json
import os
from pathlib import Path
import queue
import sys
import threading

import tools

# Folders the write tools must never change: UMAY_PROTECTED_DIRS, separated by os.pathsep (";" on Windows).
PROTECTED = [Path(p.strip()).expanduser().resolve()
             for p in os.environ.get("UMAY_PROTECTED_DIRS", "").split(os.pathsep) if p.strip()]
work = queue.Queue()
undo_states = []
state_lock = threading.Lock()
current_id = None
cancelled = set()


def fingerprint(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def writable(path):
    path = tools._path(path)
    for root in PROTECTED:
        if path == root or path.is_relative_to(root):
            raise tools.ToolError(f"Kaynak klasör salt okunur: {root}")
    return path


def validate(name, args):
    if name not in tools.TOOLS:
        raise tools.ToolError(f"Bilinmeyen araç: {name}")
    if not isinstance(args, dict):
        raise tools.ToolError("Argümanlar JSON nesnesi olmalı.")
    schema = tools.TOOLS[name].parameters
    for key in schema.get("required", []):
        if key not in args:
            raise tools.ToolError(f"Zorunlu argüman eksik: {key}")
    types = {"string": str, "integer": int, "boolean": bool}
    for key, value in args.items():
        if key not in schema["properties"]:
            raise tools.ToolError(f"Bilinmeyen argüman: {key}")
        expected = types[schema["properties"][key]["type"]]
        if type(value) is not expected:
            raise tools.ToolError(f"Geçersiz argüman türü: {key}")
    inspect.signature(tools.TOOLS[name].run).bind(**args)
    if name in ("write_file", "edit_file"):
        writable(args["path"])
    return tools.TOOLS[name]


def dispatch(request):
    op = request["op"]
    if op == "metadata":
        return {
            "tools": [{"name": name, "description": t.description, "parameters": t.parameters,
                       "needsApproval": t.needs_approval} for name, t in tools.TOOLS.items()],
            "shell": tools.SHELL_NAME, "cwd": os.getcwd(), "programs": tools.environment()[0],
            "protected": [str(root) for root in PROTECTED],
        }
    if op == "cd":
        destination = tools._path(request["path"])
        if not destination.is_dir():
            raise tools.ToolError(f"Klasör bulunamadı: {destination}")
        os.chdir(destination)
        return str(destination)
    if op == "undo":
        if not tools.UNDO:
            return "Geri alınacak dosya değişikliği yok."
        path, _ = tools.UNDO[-1]
        writable(str(path))
        if undo_states and fingerprint(path) != undo_states[-1]:
            raise tools.ToolError("Dosya araç işleminden sonra değişmiş; başka değişiklikleri ezmemek için geri alınmadı.")
        result = tools.undo_last()
        if undo_states:
            undo_states.pop()
        return result
    name, args = request.get("name"), request.get("args", {})
    t = validate(name, args)
    if op == "preview":
        return {"text": tools.truncate(t.preview(**args) if t.preview else "", 16000),
                "stamp": fingerprint(tools._path(args["path"])) if name in ("write_file", "edit_file") else None}
    if op != "execute":
        raise tools.ToolError("Bilinmeyen köprü işlemi.")
    if name in ("write_file", "edit_file"):
        path = writable(args["path"])
        if fingerprint(path) != request.get("stamp"):
            raise tools.ToolError("Dosya önizlemeden sonra değişmiş; yeniden okuyup onay al.")
        before = tools.UNDO[-1] if tools.UNDO else None
        try:
            return tools.truncate(t.run(**args))
        finally:
            if tools.UNDO and tools.UNDO[-1] is not before:
                undo_states.append(fingerprint(path))
                del undo_states[:-tools.UNDO_LIMIT]
    return tools.truncate(t.run(**args))


def worker():
    global current_id
    while True:
        request = work.get()
        if request is None:
            return
        with state_lock:
            current_id = request["id"]
            tools.CANCELLED.clear()
            if current_id in cancelled:
                tools.CANCELLED.set()
        try:
            if tools.CANCELLED.is_set():
                raise tools.ToolError("Kullanıcı iptal etti.")
            result = {"id": request["id"], "result": dispatch(request)}
        except Exception as error:
            # Expected tool errors are shown as plain sentences; unexpected ones keep their type for debugging.
            text = str(error) if isinstance(error, tools.ToolError) else f"{type(error).__name__}: {error}"
            result = {"id": request.get("id"), "error": text}
        print(json.dumps(result, ensure_ascii=False), flush=True)
        with state_lock:
            cancelled.discard(current_id)
            current_id = None


thread = threading.Thread(target=worker, daemon=True)
thread.start()
for line in sys.stdin:
    try:
        request = json.loads(line)
        if request.get("op") == "cancel":
            with state_lock:
                cancelled.add(request.get("target"))
                if current_id == request.get("target"):
                    tools.CANCELLED.set()
        else:
            work.put(request)
    except (ValueError, TypeError):
        pass
tools.CANCELLED.set()
work.put(None)
thread.join(timeout=12)
