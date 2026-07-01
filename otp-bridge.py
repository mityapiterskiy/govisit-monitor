#!/usr/bin/env python3
"""
otp-bridge.py — мост между Messages на macOS и браузерной автоматизацией.

Что делает:
  1. Раз в N секунд читает свежие SMS из локальной базы Messages (~/Library/Messages/chat.db).
  2. Регуляркой достаёт OTP-код (можно фильтровать по отправителю / ключевому слову).
  3. Отдаёт последний код по HTTP на 127.0.0.1 — оттуда его забирает userscript в Chrome.

Зависимостей нет — только стандартная библиотека Python 3.8+.

Запуск:
    python3 otp-bridge.py

Требования на маке:
  - iPhone → Settings → Messages → Text Message Forwarding → включить пересылку на этот Mac
    (тогда SMS падают в Messages и, соответственно, в chat.db).
  - Терминалу (или python) дать Full Disk Access:
    System Settings → Privacy & Security → Full Disk Access → добавить Terminal/iTerm.
    Без этого macOS не пустит к chat.db (будет ошибка "unable to open database file"
    или пустой результат).

Безопасность:
  - Сервер слушает ТОЛЬКО 127.0.0.1 (наружу не виден).
  - Код отдаётся только при правильном токене (см. TOKEN ниже) — чтобы другие
    локальные процессы не вычитывали ваши OTP.
  - База открывается строго на чтение, через временную копию (чтобы не ловить
    блокировки WAL и ничего не повредить).
"""

import http.server
import json
import os
import re
import shutil
import socketserver
import sqlite3
import tempfile
import threading
import time
from urllib.parse import urlparse, parse_qs

# ─────────────────────────── НАСТРОЙКИ ───────────────────────────

# Путь к базе Messages. Обычно менять не нужно.
DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")

# Порт локального сервера. Должен совпадать с BRIDGE_URL в userscript.
HOST = "127.0.0.1"
PORT = 8765

# Токен. ОБЯЗАТЕЛЬНО поменяйте на свой и впишите такой же в userscript (BRIDGE_TOKEN).
TOKEN = "change-me-to-a-long-random-string"

# Как часто опрашивать базу (секунды).
POLL_INTERVAL = 2.0

# Сколько секунд код считается "свежим". Старее — не отдаём (чтобы не подставить
# код от прошлой попытки логина).
CODE_TTL = 180

# Регулярка для извлечения кода. По умолчанию — отдельно стоящее число 4–8 цифр.
# Если знаете точную длину кода govisit — сузьте, напр. r"\b(\d{6})\b".
CODE_REGEX = re.compile(r"\b(\d{4,8})\b")

# Фильтр по отправителю: код берём только из сообщений, где handle (номер/имя
# отправителя) содержит одну из подстрок. Пусто [] = без фильтра по отправителю.
# Это резко снижает ложные срабатывания. Узнать отправителя можно из лога скрипта.
SENDER_CONTAINS = []  # напр. ["govisit", "MOIN", "972"]

# Фильтр по тексту: если задан, код берём только из сообщений, содержащих одно из
# этих слов (иврит/латиница). Пусто [] = без фильтра по тексту.
TEXT_CONTAINS = []  # напр. ["govisit", "קוד", "אימות"]

# ─────────────────────────────────────────────────────────────────

# Секунд между Unix-эпохой (1970) и Apple-эпохой (2001).
APPLE_EPOCH_OFFSET = 978307200

# Последний найденный код хранится здесь.
_state_lock = threading.Lock()
_state = {"code": None, "ts": 0.0, "sender": None, "raw": None}


def _apple_date_to_unix(apple_date) -> float:
    """date в chat.db: наносекунды (новые macOS) или секунды (старые) от 2001-01-01."""
    if apple_date is None:
        return 0.0
    d = float(apple_date)
    if d > 1e12:  # наносекунды
        d /= 1e9
    return d + APPLE_EPOCH_OFFSET


def _extract_text(text, attributed_body) -> str:
    """
    Текст сообщения. На новых macOS колонка text часто пустая, а сам текст лежит
    в attributedBody (бинарный typedstream). Для извлечения OTP нам достаточно
    лоссового декода — цифры кода в нём всё равно присутствуют.
    """
    if text:
        return text
    if attributed_body:
        try:
            return attributed_body.decode("utf-8", "ignore")
        except Exception:
            try:
                return attributed_body.decode("latin-1", "ignore")
            except Exception:
                return ""
    return ""


def _snapshot_db(src: str) -> str:
    """
    Копируем chat.db (+ -wal/-shm) во временную папку и читаем копию.
    Так не мешаем Messages и не ловим блокировки.
    """
    tmpdir = tempfile.mkdtemp(prefix="otpbridge_")
    dst = os.path.join(tmpdir, "chat.db")
    shutil.copy2(src, dst)
    for ext in ("-wal", "-shm"):
        side = src + ext
        if os.path.exists(side):
            try:
                shutil.copy2(side, dst + ext)
            except Exception:
                pass
    return dst


def _poll_once():
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(
            f"Не найдена база Messages: {DB_PATH}. "
            f"Включена ли переадресация SMS на этот Mac?"
        )

    snap = None
    try:
        snap = _snapshot_db(DB_PATH)
        conn = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        # Берём последние входящие сообщения. handle.id — отправитель.
        cur.execute(
            """
            SELECT m.text       AS text,
                   m.attributedBody AS attributedBody,
                   m.date       AS date,
                   m.is_from_me AS is_from_me,
                   h.id         AS sender
            FROM message m
            LEFT JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.is_from_me = 0
            ORDER BY m.date DESC
            LIMIT 15
            """
        )
        rows = cur.fetchall()
        conn.close()
    finally:
        if snap:
            shutil.rmtree(os.path.dirname(snap), ignore_errors=True)

    now = time.time()
    for row in rows:
        msg_ts = _apple_date_to_unix(row["date"])
        if now - msg_ts > CODE_TTL:
            continue  # слишком старое — дальше только старее, можно и break

        sender = row["sender"] or ""
        text = _extract_text(row["text"], row["attributedBody"])

        if SENDER_CONTAINS and not any(s.lower() in sender.lower() for s in SENDER_CONTAINS):
            continue
        if TEXT_CONTAINS and not any(t in text for t in TEXT_CONTAINS):
            continue

        match = CODE_REGEX.search(text)
        if not match:
            continue

        code = match.group(1)
        with _state_lock:
            if _state["code"] != code or abs(_state["ts"] - msg_ts) > 1:
                _state.update(code=code, ts=msg_ts, sender=sender, raw=text.strip()[:200])
                print(f"[otp] новый код: {code}  (от: {sender or '?'}, "
                      f"{int(now - msg_ts)}с назад)")
        return  # нашли самый свежий подходящий — выходим


def _poller_loop():
    warned = False
    while True:
        try:
            _poll_once()
            warned = False
        except Exception as e:
            if not warned:
                print(f"[otp] ОШИБКА чтения базы: {e}")
                print("[otp] Проверьте Full Disk Access и переадресацию SMS.")
                warned = True
        time.sleep(POLL_INTERVAL)


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/health":
            self._send(200, {"ok": True, "db_exists": os.path.exists(DB_PATH)})
            return

        # /otp требует токен.
        token = (qs.get("token") or [None])[0]
        if token != TOKEN:
            self._send(401, {"error": "bad token"})
            return

        with _state_lock:
            code = _state["code"]
            ts = _state["ts"]
            sender = _state["sender"]

        age = time.time() - ts if ts else None
        fresh = code is not None and age is not None and age <= CODE_TTL

        if parsed.path == "/otp":
            self._send(200, {
                "code": code if fresh else None,
                "age_seconds": round(age, 1) if age is not None else None,
                "sender": sender if fresh else None,
                "fresh": fresh,
            })
        elif parsed.path == "/otp/raw":
            self._send(200, {"code": code if fresh else None})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *args):
        pass  # тихо


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main():
    print(f"otp-bridge: база  {DB_PATH}")
    print(f"otp-bridge: сервер http://{HOST}:{PORT}  (токен обязателен для /otp)")
    if TOKEN == "change-me-to-a-long-random-string":
        print("otp-bridge: ВНИМАНИЕ — смените TOKEN на свой!")
    print("otp-bridge: эндпоинты: /health  /otp?token=...  /otp/raw?token=...")
    print("otp-bridge: Ctrl+C для остановки.\n")

    t = threading.Thread(target=_poller_loop, daemon=True)
    t.start()

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\notp-bridge: остановлен.")


if __name__ == "__main__":
    main()
