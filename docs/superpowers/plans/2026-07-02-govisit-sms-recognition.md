# Распознавание SMS от govisit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Научить `otp-bridge.py` извлекать OTP именно из SMS govisit (иврит, отправитель `GoVisit`), а не «первое число из любой SMS».

**Architecture:** Двухступенчатое извлечение: якорная регулярка «קוד האימות … <код>» → fallback на общую `\b(\d{4,8})\b`. Плюс фильтр по отправителю `["govisit"]` и `CODE_TTL = 300`. Чистая функция `extract_code` покрыта unit-тестами без chat.db.

**Tech Stack:** Python 3.8+ stdlib (`re`, `unittest`). Зависимостей нет и не появится.

**Spec:** `docs/superpowers/specs/2026-07-02-govisit-sms-recognition-design.md`

**Контекст для исполнителя:**
- Репозиторий: `/Users/mitya/Documents/Claude/govisit-monitor`, ветка `govisit-sms-recognition`.
- `otp-bridge.py` — единственный питоновский файл, имя с дефисом, поэтому в тестах импортируем через `importlib`.
- Реальная SMS govisit (код бывает и с ведущим нулём, и без):
  `קוד האימות לגוביזיט 0189.קוד זה תקף ל-5 דקות`
  («Код подтверждения для GoVisit 0189. Код действителен 5 минут»). Ловушка: одиночная цифра «5» в «ל-5 דקות».
- Иврит пишется справа налево, но в строке Python текст лежит в логическом порядке — регулярки работают как обычно.

---

## File Structure

- Create: `test_otp_extraction.py` — unit-тесты извлечения (в корне, рядом с `otp-bridge.py`; пакетной структуры в проекте нет и не нужно).
- Modify: `otp-bridge.py` — конфиг (`SENDER_CONTAINS`, `CODE_TTL`), регулярки, новая функция `extract_code`, вызов в `_poll_once`.
- Modify: `README.md` — дефолты под govisit + раздел «Если код не извлекается».

---

### Task 1: Функция `extract_code` (TDD)

**Files:**
- Create: `test_otp_extraction.py`
- Modify: `otp-bridge.py` (регулярки ~строки 62–64; функция после `_extract_text`, ~строка 112)

- [x] **Step 1: Написать падающие тесты**

Создать `test_otp_extraction.py` с этим содержимым (целиком):

```python
"""Тесты извлечения OTP из SMS govisit. Запуск: python3 -m unittest test_otp_extraction -v"""
import importlib.util
import os
import unittest

# otp-bridge.py содержит дефис в имени — импортируем через importlib.
_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("otp_bridge", os.path.join(_here, "otp-bridge.py"))
otp_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(otp_bridge)

# Реальный формат SMS govisit (код заменён).
REAL_SMS = "קוד האימות לגוביזיט 0189.קוד זה תקף ל-5 דקות"


class ExtractCodeTests(unittest.TestCase):
    def test_real_sms_leading_zero(self):
        # Ведущий ноль обязан сохраниться: "0189", а не "189".
        self.assertEqual(otp_bridge.extract_code(REAL_SMS), "0189")

    def test_real_sms_without_leading_zero(self):
        sms = "קוד האימות לגוביזיט 7423.קוד זה תקף ל-5 דקות"
        self.assertEqual(otp_bridge.extract_code(sms), "7423")

    def test_validity_digit_not_extracted(self):
        # «5» из «ל-5 דקות» — не код.
        self.assertIsNone(otp_bridge.extract_code("קוד זה תקף ל-5 דקות"))

    def test_anchor_beats_fallback(self):
        # Постороннее 6-значное число не должно перебить код после якоря.
        sms = "מספר בקשה 123456. קוד האימות לגוביזיט 0189"
        self.assertEqual(otp_bridge.extract_code(sms), "0189")

    def test_fallback_without_anchor(self):
        # Якоря нет (govisit переформулировал SMS) — работает общий fallback.
        self.assertEqual(otp_bridge.extract_code("Your code is 654321"), "654321")

    def test_no_code_returns_none(self):
        self.assertIsNone(otp_bridge.extract_code("שלום, מה שלומך?"))


class ExtractTextTests(unittest.TestCase):
    def test_attributed_body_roundtrip(self):
        # На новых macOS текст лежит в attributedBody (бинарный typedstream).
        # Лоссовый UTF-8-декод должен сохранить иврит и цифры.
        blob = b"\x04\x0bstreamtyped\x81\xe8\x03" + REAL_SMS.encode("utf-8") + b"\x86\x84\x01"
        text = otp_bridge._extract_text(None, blob)
        self.assertEqual(otp_bridge.extract_code(text), "0189")

    def test_text_column_preferred(self):
        # Если колонка text заполнена — attributedBody не трогаем.
        self.assertEqual(otp_bridge._extract_text("abc", b"xyz"), "abc")


if __name__ == "__main__":
    unittest.main()
```

- [x] **Step 2: Убедиться, что тесты падают**

Run: `cd /Users/mitya/Documents/Claude/govisit-monitor && python3 -m unittest test_otp_extraction -v`
Expected: 7 тестов падают с `AttributeError: module 'otp_bridge' has no attribute 'extract_code'`; `test_text_column_preferred` проходит (он не зовёт `extract_code`).

- [x] **Step 3: Реализовать `extract_code`**

В `otp-bridge.py` заменить блок (сейчас ~строки 62–64):

```python
# Регулярка для извлечения кода. По умолчанию — отдельно стоящее число 4–8 цифр.
# Если знаете точную длину кода govisit — сузьте, напр. r"\b(\d{6})\b".
CODE_REGEX = re.compile(r"\b(\d{4,8})\b")
```

на:

```python
# Основная регулярка: якорь «קוד האימות» («код подтверждения»), затем до 20
# нецифровых символов («לגוביזיט », двоеточие и т.п.), затем сам код (3–8 цифр,
# бывает с ведущим нулём). Так не путаем код с другими числами в SMS.
# (?![0-9]) — код не может быть началом более длинного числа (телефона и т.п.).
ANCHORED_CODE_REGEX = re.compile(r"קוד האימות[^0-9]{0,20}([0-9]{3,8})(?![0-9])")

# Fallback на случай, если govisit переформулирует SMS и якорь исчезнет:
# отдельно стоящее число 4–8 цифр.
CODE_REGEX = re.compile(r"\b(\d{4,8})\b")
```

Сразу после функции `_extract_text` (после ~строки 111) добавить:

```python
def extract_code(text: str):
    """
    Достаёт OTP из текста SMS. Сначала ищем код после якорной фразы
    «קוד האימות» — так не берём случайно «5» из «תקף ל-5 דקות» или номер
    заявки. Если якоря нет — общий fallback. Код возвращаем строкой,
    чтобы не потерять ведущий ноль.
    """
    m = ANCHORED_CODE_REGEX.search(text) or CODE_REGEX.search(text)
    return m.group(1) if m else None
```

- [x] **Step 4: Убедиться, что тесты проходят**

Run: `python3 -m unittest test_otp_extraction -v`
Expected: `Ran 9 tests ... OK`

- [x] **Step 5: Commit**

```bash
git add test_otp_extraction.py otp-bridge.py
git commit -m "$(cat <<'EOF'
feat: anchored govisit OTP extraction with fallback + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

> **Правка после code-review (выполнено, коммиты `705f74d` + `3dcd76e`):**
> у якорной регулярки не было границы после кода — телефон после якоря
> («קוד האימות נשלח אל 0501234567») давал усечённое '05012345'. Регулярка
> заменена на `([0-9]{3,8})(?![0-9])` (блок Step 3 выше уже обновлён),
> добавлен девятый тест `test_long_digit_run_not_truncated` и `.gitignore`
> с `__pycache__/`.

---

### Task 2: Подключить `extract_code` в `_poll_once` и обновить дефолты конфига

**Files:**
- Modify: `otp-bridge.py` (`CODE_TTL` ~строка 60, `SENDER_CONTAINS` ~строка 69, `_poll_once` ~строки 180–184)

- [ ] **Step 1: Использовать `extract_code` в `_poll_once`**

В `otp-bridge.py` внутри `_poll_once` заменить:

```python
        match = CODE_REGEX.search(text)
        if not match:
            continue

        code = match.group(1)
```

на:

```python
        code = extract_code(text)
        if not code:
            continue
```

- [ ] **Step 2: Обновить дефолты конфига**

Заменить (сейчас ~строки 58–60):

```python
# Сколько секунд код считается "свежим". Старее — не отдаём (чтобы не подставить
# код от прошлой попытки логина).
CODE_TTL = 180
```

на:

```python
# Сколько секунд код считается "свежим". Старее — не отдаём (чтобы не подставить
# код от прошлой попытки логина). SMS govisit: «код действителен 5 минут».
CODE_TTL = 300
```

И заменить (сейчас ~строки 66–69):

```python
# Фильтр по отправителю: код берём только из сообщений, где handle (номер/имя
# отправителя) содержит одну из подстрок. Пусто [] = без фильтра по отправителю.
# Это резко снижает ложные срабатывания. Узнать отправителя можно из лога скрипта.
SENDER_CONTAINS = []  # напр. ["govisit", "MOIN", "972"]
```

на:

```python
# Фильтр по отправителю: код берём только из сообщений, где handle (номер/имя
# отправителя) содержит одну из подстрок (без учёта регистра). SMS govisit
# приходят от отправителя "GoVisit". Если у вас отправитель отображается иначе
# (короткий номер и т.п.) — поправьте. Пусто [] = без фильтра.
SENDER_CONTAINS = ["govisit"]
```

- [ ] **Step 3: Проверить, что всё компилируется и тесты проходят**

Run: `python3 -m py_compile otp-bridge.py && python3 -m unittest test_otp_extraction -v`
Expected: py_compile молчит; `Ran 9 tests ... OK`

- [ ] **Step 4: Commit**

```bash
git add otp-bridge.py
git commit -m "$(cat <<'EOF'
feat: govisit defaults — sender filter GoVisit, CODE_TTL 300s

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Обновить README

**Files:**
- Modify: `README.md` (Шаг 3 ~строки 48–67; «Если код не извлекается» ~строки 129–138)

- [ ] **Step 1: Дописать в «Шаг 3. Запуск моста»**

После строки `Если \`code:null\` — смотрите раздел «Если код не извлекается».` (~строка 67) добавить абзац:

````markdown
Извлечение кода уже настроено под govisit: SMS от отправителя `GoVisit`, код
ищется после ивритской фразы «קוד האימות» (посторонние числа вроде «תקף ל-5
דקות» не мешают). Логику можно проверить без SMS и без chat.db:

```bash
python3 -m unittest test_otp_extraction -v
```
````

- [ ] **Step 2: Переписать раздел «Если код не извлекается»**

Заменить (сейчас ~строки 131–138):

```markdown
- `db_exists:false` → не включена переадресация SMS или нет Full Disk Access.
- `code:null`, хотя SMS пришла:
  - на новых macOS текст лежит в `attributedBody` — скрипт это умеет, но если
    код всё равно не находится, задайте `SENDER_CONTAINS` (часть имени/номера
    отправителя) и/или сузьте `CODE_REGEX` под точную длину кода govisit;
  - проверьте `CODE_TTL` — старые коды не отдаются специально.
- Несколько чисел в SMS → сузьте `CODE_REGEX` (напр. ровно 6 цифр) или добавьте
  `TEXT_CONTAINS` с ключевым словом из сообщения.
```

на:

```markdown
- `db_exists:false` → не включена переадресация SMS или нет Full Disk Access.
- `code:null`, хотя SMS пришла:
  - по умолчанию код берётся только из SMS, чей отправитель содержит `govisit`
    (в Messages это `GoVisit`). Если у вас отправитель выглядит иначе (короткий
    номер и т.п.) — поправьте `SENDER_CONTAINS` в `otp-bridge.py`; отправителя
    видно в логе моста;
  - код ищется после ивритской фразы «קוד האימות»; если govisit сменил текст —
    сработает fallback (число 4–8 цифр), но лучше подправить
    `ANCHORED_CODE_REGEX` под новый текст;
  - на новых macOS текст лежит в `attributedBody` — скрипт это умеет;
  - проверьте `CODE_TTL` — старые коды не отдаются специально (сейчас 300 с,
    как заявленные в SMS «5 минут»).
- Взялось не то число → сузьте `ANCHORED_CODE_REGEX` (например, точную длину
  кода) или добавьте `TEXT_CONTAINS` с ключевым словом из сообщения.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: README — govisit-tuned defaults and troubleshooting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Проверка всего плана

- [ ] `python3 -m unittest test_otp_extraction -v` → `Ran 9 tests ... OK`
- [ ] `python3 -m py_compile otp-bridge.py` → без вывода
- [ ] `git log --oneline` → коммиты Task 1–3 (включая фикс после ревью) поверх спеки в ветке `govisit-sms-recognition`
