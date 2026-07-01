// ==UserScript==
// @name         govisit OTP + monitor
// @namespace    govisit-monitor
// @version      1.0
// @description  Подставляет OTP из otp-bridge, мониторит свободные слоты на govisit.gov.il и пингует в Telegram
// @match        https://govisit.gov.il/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      api.telegram.org
// ==/UserScript==

/*
 ─────────────────────────────────────────────────────────────────────────────
 КАК ЭТО РАБОТАЕТ
 ─────────────────────────────────────────────────────────────────────────────
   1. На странице верификации кода — забирает OTP из локального otp-bridge.py
      (http://127.0.0.1:8765) и подставляет в поле, жмёт «дальше».
   2. На странице отделений — перехватывает JSON-ответ сайта со списком отделений
      и ближайших дат, сравнивает с вашими желаемыми отделениями/датой.
   3. При совпадении — шлёт сообщение в Telegram (с дедупликацией, чтобы не спамить).

 ВАЖНО ПРО СЕЛЕКТОРЫ/ЭНДПОИНТ:
   Точную структуру форм и API-ответа govisit можно подтвердить за 2 минуты
   через DevTools (см. README, раздел «Калибровка»). Скрипт написан так, чтобы
   работать с авто-определением, но если что-то не подхватилось — правьте
   CONFIG.SELECTORS и CONFIG.PARSE ниже.

 ЭТИКА/БЕЗОПАСНОСТЬ:
   Это ваш аккаунт и ваши SMS. Не молотите госсайт — интервал опроса намеренно
   щадящий (минуты, с джиттером). Бронируете вы сами, скрипт только уведомляет.
 ─────────────────────────────────────────────────────────────────────────────
*/

(function () {
  "use strict";

  // ═══════════════════════ НАСТРОЙКИ ═══════════════════════
  const CONFIG = {
    // --- мост с OTP (otp-bridge.py) ---
    BRIDGE_URL: "http://127.0.0.1:8765",
    BRIDGE_TOKEN: "change-me-to-a-long-random-string", // == TOKEN в otp-bridge.py

    // --- ваши данные для автозаполнения ---
    // Оставьте пустым, чтобы вводить руками. Заполняется ЛОКАЛЬНО, в репозиторий не коммитим.
    PHONE: "",          // напр. "0501234567" — телефон для получения SMS
    TEUDAT_ZEUT: "",    // номер теудат зеут (ID); если форма его просит

    // Автоматически запрашивать новый код, если разлогинило? Если false — кнопку
    // «отправить код» жмёте сами, скрипт только подставит пришедший OTP.
    AUTO_REQUEST_CODE: false,

    // --- что считаем «подходящим» ---
    // Подстроки в названии отделения (иврит/латиница). Пусто = любое отделение.
    DESIRED_OFFICES: [], // напр. ["ירושלים", "תל אביב"]
    // Уведомлять, только если ближайшая дата не позже этой (YYYY-MM-DD). Пусто = любая дата.
    DESIRED_DATE_BEFORE: "", // напр. "2026-09-01"

    // --- Telegram ---
    TELEGRAM_BOT_TOKEN: "", // от @BotFather
    TELEGRAM_CHAT_ID: "",   // ваш chat id (узнать: напишите боту, потом getUpdates)

    // --- поведение мониторинга ---
    POLL_MIN_MS: 4 * 60 * 1000,  // минимум между авто-обновлениями страницы отделений
    POLL_MAX_MS: 8 * 60 * 1000,  // максимум (берётся случайно в [min,max] — джиттер)
    AUTO_RELOAD_LOCATION: true,  // авто-перезагружать /location по таймеру

    // --- селекторы (правьте при необходимости, см. README) ---
    SELECTORS: {
      otpInput: 'input[autocomplete="one-time-code"], input[name*="code" i], input[name*="otp" i], input[type="tel"], input[inputmode="numeric"]',
      otpSubmit: 'button[type="submit"], button',
      phoneInput: 'input[type="tel"], input[name*="phone" i], input[name*="mobile" i]',
      phoneSubmit: 'button[type="submit"], button',
      idInput: 'input[name*="id" i], input[name*="teudat" i], input[type="tel"], input[inputmode="numeric"]',
      idSubmit: 'button[type="submit"], button',
    },

    // --- разбор ответа со слотами ---
    // URL-фрагменты ответов сайта, в которых искать данные об отделениях/датах.
    PARSE: {
      apiUrlContains: ["location", "appointment", "branch", "slot", "availab"],
    },

    DEBUG: true,
  };
  // ═════════════════════════════════════════════════════════

  const log = (...a) => CONFIG.DEBUG && console.log("%c[govisit]", "color:#2563eb;font-weight:bold", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + (max - min) * fakeRandom());
  // детерминированный «джиттер» без Math.random запретов не нужен — но Math.random тут ок:
  function fakeRandom() { return Math.random(); }

  // ───────────── перехват сети (ставим как можно раньше) ─────────────
  // Сохраняем последний «похожий на список отделений» JSON, чтобы разобрать его,
  // не завися от вёрстки DOM.
  let lastCaptured = null;

  function maybeCapture(url, text) {
    try {
      if (!url) return;
      const u = String(url).toLowerCase();
      if (!CONFIG.PARSE.apiUrlContains.some((s) => u.includes(s))) return;
      const data = JSON.parse(text);
      lastCaptured = { url, data, at: Date.now() };
      log("перехвачен ответ:", url, data);
      handleAvailability(data, url);
    } catch (_) { /* не JSON — игнор */ }
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = (args[0] && args[0].url) || args[0];
      res.clone().text().then((t) => maybeCapture(url, t)).catch(() => {});
    } catch (_) {}
    return res;
  };

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = "";
    const open = xhr.open;
    xhr.open = function (method, url, ...rest) { _url = url; return open.call(this, method, url, ...rest); };
    xhr.addEventListener("load", function () {
      try { maybeCapture(_url, xhr.responseText); } catch (_) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ───────────── HTTP-помощники (кросс-доменно, через GM) ─────────────
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET", url, timeout: 8000,
        onload: (r) => resolve(r.responseText),
        onerror: () => reject(new Error("net error " + url)),
        ontimeout: () => reject(new Error("timeout " + url)),
      });
    });
  }

  async function fetchOtp() {
    try {
      const txt = await gmGet(`${CONFIG.BRIDGE_URL}/otp?token=${encodeURIComponent(CONFIG.BRIDGE_TOKEN)}`);
      const j = JSON.parse(txt);
      return j.fresh ? j.code : null;
    } catch (e) {
      log("мост недоступен:", e.message);
      return null;
    }
  }

  function telegram(text) {
    if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
      log("Telegram не настроен — пропускаю уведомление:", text);
      return;
    }
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    GM_xmlhttpRequest({
      method: "POST", url,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      onload: () => log("→ Telegram отправлено"),
      onerror: () => log("→ Telegram ошибка"),
    });
  }

  // ───────────── разбор доступности отделений ─────────────
  // Рекурсивно ищем в любом JSON объекты, похожие на «отделение + дата».
  function extractOffices(data) {
    const found = [];
    const seen = new Set();
    function looksLikeDate(v) {
      return typeof v === "string" && /\d{4}-\d{2}-\d{2}/.test(v);
    }
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      // эвристика: у объекта есть имя/название и какая-то дата
      const keys = Object.keys(node);
      const nameKey = keys.find((k) => /name|title|branch|location|שם/i.test(k));
      const dateKey = keys.find((k) => /date|nearest|available|slot|תאריך/i.test(k) && looksLikeDate(node[k]));
      if (nameKey && dateKey) {
        const name = String(node[nameKey]);
        const dateStr = (node[dateKey].match(/\d{4}-\d{2}-\d{2}/) || [])[0];
        const key = name + "|" + dateStr;
        if (dateStr && !seen.has(key)) {
          seen.add(key);
          found.push({ name, date: dateStr, raw: node });
        }
      }
      keys.forEach((k) => walk(node[k]));
    }
    walk(data);
    return found;
  }

  function matches(office) {
    const okOffice = CONFIG.DESIRED_OFFICES.length === 0 ||
      CONFIG.DESIRED_OFFICES.some((s) => office.name.includes(s));
    const okDate = !CONFIG.DESIRED_DATE_BEFORE || office.date <= CONFIG.DESIRED_DATE_BEFORE;
    return okOffice && okDate;
  }

  function handleAvailability(data, url) {
    const offices = extractOffices(data);
    if (!offices.length) return;
    setStatus(`Отделений в ответе: ${offices.length}. Совпадений ищу…`);
    log("разобрано отделений:", offices);

    const hits = offices.filter(matches);
    if (!hits.length) { setStatus(`Подходящих пока нет (${offices.length} отделений)`); return; }

    // дедуп: не уведомляем повторно про ту же пару отделение+дата в течение суток
    const notified = GM_getValue("notified", {});
    const now = Date.now();
    const fresh = hits.filter((h) => {
      const k = h.name + "|" + h.date;
      return !notified[k] || now - notified[k] > 24 * 3600 * 1000;
    });
    if (!fresh.length) { setStatus(`Совпадения есть, но уже уведомлял`); return; }

    fresh.forEach((h) => { notified[h.name + "|" + h.date] = now; });
    GM_setValue("notified", notified);

    const lines = fresh.map((h) => `• ${h.name} — ${h.date}`).join("\n");
    const msg = `🟢 govisit: появились слоты!\n${lines}\n\nБронируй: ${location.href}`;
    telegram(msg);
    setStatus(`🟢 НАЙДЕНО: ${fresh.length}. Уведомление отправлено!`);
    log("МАТЧ:", fresh);
  }

  // ───────────── автозаполнение форм ─────────────
  function $(sel) { return document.querySelector(sel); }
  function setNativeValue(el, value) {
    // React/Angular слушают input-события «правильно» только при нативном сеттере
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function tryFillOtp() {
    const input = $(CONFIG.SELECTORS.otpInput);
    if (!input) return false;
    const code = await fetchOtp();
    if (!code) { setStatus("Жду SMS-код от моста…"); return false; }
    if (input.value === code) return true;
    setStatus(`Подставляю код ${code}`);
    setNativeValue(input, code);
    // если поле разбито на отдельные ячейки — попробуем разложить по символам
    const cells = document.querySelectorAll(CONFIG.SELECTORS.otpInput);
    if (cells.length > 1 && code.length === cells.length) {
      cells.forEach((c, i) => setNativeValue(c, code[i]));
    }
    await sleep(400);
    const submit = $(CONFIG.SELECTORS.otpSubmit);
    if (submit && !submit.disabled) { submit.click(); log("отправил OTP"); }
    return true;
  }

  function tryFillPhone() {
    if (!CONFIG.PHONE) return;
    const input = $(CONFIG.SELECTORS.phoneInput);
    if (input && !input.value) {
      setNativeValue(input, CONFIG.PHONE);
      setStatus("Подставил телефон");
      if (CONFIG.AUTO_REQUEST_CODE) {
        const btn = $(CONFIG.SELECTORS.phoneSubmit);
        if (btn && !btn.disabled) btn.click();
      }
    }
  }

  function tryFillId() {
    if (!CONFIG.TEUDAT_ZEUT) return;
    const input = $(CONFIG.SELECTORS.idInput);
    if (input && !input.value) {
      setNativeValue(input, CONFIG.TEUDAT_ZEUT);
      setStatus("Подставил теудат зеут");
    }
  }

  // ───────────── статус-панель ─────────────
  let panel;
  function setStatus(text) {
    if (!panel) return;
    const t = new Date().toLocaleTimeString();
    panel.querySelector(".gv-status").textContent = `[${t}] ${text}`;
  }
  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement("div");
    panel.style.cssText = [
      "position:fixed", "bottom:12px", "right:12px", "z-index:999999",
      "background:#0f172a", "color:#e2e8f0", "font:12px/1.4 monospace",
      "padding:10px 12px", "border-radius:8px", "max-width:320px",
      "box-shadow:0 4px 16px rgba(0,0,0,.4)", "direction:ltr", "opacity:.92",
    ].join(";");
    panel.innerHTML =
      '<div style="font-weight:bold;margin-bottom:4px">govisit monitor</div>' +
      '<div class="gv-status">инициализация…</div>';
    document.body.appendChild(panel);
  }

  // ───────────── роутер по страницам ─────────────
  function route() {
    const p = location.pathname;
    if (/\/auth\/verify/.test(p)) { tryFillOtp(); }
    else if (/\/auth\/login/.test(p)) { tryFillPhone(); }
    else if (/questionnaire/.test(p)) { tryFillId(); }
    else if (/location/.test(p)) { setStatus("Страница отделений — слежу за ответами API"); }
  }

  // ───────────── таймер мягкого опроса страницы отделений ─────────────
  function scheduleReload() {
    if (!CONFIG.AUTO_RELOAD_LOCATION) return;
    if (!/location/.test(location.pathname)) return;
    const delay = rand(CONFIG.POLL_MIN_MS, CONFIG.POLL_MAX_MS);
    setStatus(`Следующее обновление через ~${Math.round(delay / 60000)} мин`);
    setTimeout(() => { if (/location/.test(location.pathname)) location.reload(); }, delay);
  }

  // ───────────── запуск ─────────────
  function boot() {
    buildPanel();
    setStatus("запущен");
    route();
    scheduleReload();
    // SPA-навигация: переотрабатываем при смене пути
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) { lastPath = location.pathname; route(); scheduleReload(); }
    }, 1500);
    // на странице верификации код может прийти позже — переспрашиваем мост
    setInterval(() => { if (/\/auth\/verify/.test(location.pathname)) tryFillOtp(); }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
