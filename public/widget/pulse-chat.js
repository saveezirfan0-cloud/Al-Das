/*!
 * Pulse website chat widget (Phase 20e). Vanilla JS, no framework, no cookies.
 *
 * Embed: <script src="https://<pulse>/widget/pulse-chat.js" data-pulse-chat="<key>" async></script>
 *
 * - Talks only to the Pulse address it was loaded from (/api/widget/<key>/...).
 * - The visitor is a random token that Pulse issues on the first message; it is kept in localStorage on this website only.
 * - Everything is rendered as text (never HTML) inside a closed shadow root, so the host page's styles and scripts do not mix in.
 */
(function () {
  "use strict";
  var WIDGET_VERSION = "1";
  var script = document.currentScript;
  if (!script || window.__pulseChatLoaded) return;
  window.__pulseChatLoaded = true;

  var key = script.getAttribute("data-pulse-chat") || "";
  if (!/^[0-9a-f-]{36}$/i.test(key)) return;
  var base;
  try {
    base = new URL(script.src).origin;
  } catch {
    return;
  }
  var api = base + "/api/widget/" + key;
  var storeKey = "pulse-chat:" + key;

  function readToken() {
    try {
      var t = window.localStorage.getItem(storeKey);
      return t && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  }
  function writeToken(t) {
    try {
      if (t) window.localStorage.setItem(storeKey, t);
      else window.localStorage.removeItem(storeKey);
    } catch {
      /* private mode: the chat still works for this page view */
    }
  }
  var memoryToken = readToken();
  function token() {
    return memoryToken;
  }
  function setToken(t) {
    memoryToken = t;
    writeToken(t);
  }

  function clientId() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = "";
    for (var i = 0; i < a.length; i++) s += ("0" + a[i].toString(16)).slice(-2);
    return s;
  }

  function request(method, path, body) {
    var headers = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;
    return fetch(api + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
      cache: "no-store",
      mode: "cors",
    });
  }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs)
      for (var k in attrs)
        if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function start(cfg) {
    var colour = /^#[0-9a-f]{6}$/i.test(cfg.colour) ? cfg.colour : "#0f766e";
    var host = el("div", { "data-pulse-chat-version": WIDGET_VERSION });
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;";
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    var style = el("style");
    style.textContent =
      ":host,*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
      ".btn{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:24px;position:relative}" +
      ".badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#dc2626;color:#fff;font-size:12px;line-height:20px;padding:0 5px;display:none}" +
      ".panel{display:none;flex-direction:column;width:min(360px,calc(100vw - 32px));height:min(520px,calc(100vh - 96px));background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);overflow:hidden;margin-bottom:12px}" +
      ".panel.open{display:flex}" +
      ".head{color:#fff;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;font-weight:600}" +
      ".close{background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer;min-width:44px;min-height:44px}" +
      ".log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f7f7f8}" +
      ".m{max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.4}" +
      ".in{align-self:flex-end;color:#fff}.out{align-self:flex-start;background:#fff;border:1px solid #e5e7eb}" +
      ".welcome{align-self:flex-start;background:#fff;border:1px solid #e5e7eb}" +
      ".form{display:flex;flex-direction:column;gap:6px;padding:10px;border-top:1px solid #e5e7eb}" +
      ".row{display:flex;gap:6px}" +
      "input,textarea{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:8px;font-size:14px;resize:none}" +
      ".send{border:0;border-radius:8px;color:#fff;padding:0 14px;cursor:pointer;min-height:44px}" +
      ".note{font-size:11px;color:#6b7280}";
    root.appendChild(style);

    var panel = el("div", { class: "panel", role: "dialog", "aria-label": cfg.title });
    var head = el("div", { class: "head" });
    head.style.background = colour;
    head.appendChild(el("span", null, cfg.title));
    var close = el("button", { class: "close", type: "button", "aria-label": "Close chat" }, "×");
    head.appendChild(close);
    var log = el("div", { class: "log", "aria-live": "polite" });
    log.appendChild(el("div", { class: "m welcome" }, cfg.welcome));
    var form = el("form", { class: "form" });
    var nameInput = el("input", {
      type: "text",
      maxlength: "60",
      placeholder: "Your name (optional)",
      "aria-label": "Your name",
    });
    var row = el("div", { class: "row" });
    var text = el("textarea", {
      rows: "2",
      maxlength: "2000",
      placeholder: "Type your message",
      "aria-label": "Message",
      required: "required",
    });
    var send = el("button", { class: "send", type: "submit" }, "Send");
    send.style.background = colour;
    row.appendChild(text);
    row.appendChild(send);
    if (!token()) form.appendChild(nameInput);
    form.appendChild(row);
    form.appendChild(
      el("div", { class: "note" }, "Please do not share urgent medical problems here."),
    );
    panel.appendChild(head);
    panel.appendChild(log);
    panel.appendChild(form);

    var btn = el("button", { class: "btn", type: "button", "aria-label": cfg.title }, "💬");
    btn.style.background = colour;
    var badge = el("span", { class: "badge", "aria-hidden": "true" });
    btn.appendChild(badge);
    root.appendChild(panel);
    root.appendChild(btn);
    document.body.appendChild(host);

    var seen = {};
    var lastAt = null;
    var unread = 0;
    var isOpen = false;
    var timer = null;
    var sending = false;

    function add(m) {
      if (seen[m.id]) return false;
      seen[m.id] = true;
      var b = el("div", { class: "m " + (m.from === "visitor" ? "in" : "out") }, m.text);
      if (m.from === "visitor") b.style.background = colour;
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      var t = Date.parse(m.at);
      if (isFinite(t) && (!lastAt || t > Date.parse(lastAt))) lastAt = new Date(t).toISOString();
      return true;
    }

    function showBadge() {
      badge.textContent = unread > 9 ? "9+" : String(unread);
      badge.style.display = unread > 0 && !isOpen ? "block" : "none";
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      if (!token()) return;
      timer = setTimeout(poll, isOpen ? 5000 : 30000);
    }

    function poll() {
      if (!token()) return;
      var q = lastAt ? "?after=" + encodeURIComponent(lastAt) : "";
      request("GET", "/messages" + q)
        .then(function (r) {
          if (r.status === 401) {
            setToken(null);
            return null;
          }
          return r.ok ? r.json() : null;
        })
        .then(function (data) {
          if (data && data.messages && data.messages.length) {
            for (var i = 0; i < data.messages.length; i++) {
              var m = data.messages[i];
              if (add(m) && m.from === "clinic" && !isOpen) unread++;
            }
            showBadge();
          }
        })
        .catch(function () {})
        .then(schedule);
    }

    function post(body, retried) {
      return request("POST", "/messages", body).then(function (r) {
        if (r.status === 401 && !retried) {
          setToken(null);
          return post(body, true);
        }
        return r.json().then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var value = text.value.trim();
      if (!value || sending) return;
      sending = true;
      send.disabled = true;
      var body = { text: value, client_id: clientId() };
      if (!token() && nameInput.value.trim()) body.name = nameInput.value.trim().slice(0, 60);
      post(body, false)
        .then(function (res) {
          if (res.ok) {
            if (res.data && res.data.token) {
              setToken(res.data.token);
              if (nameInput.parentNode) nameInput.parentNode.removeChild(nameInput);
            }
            if (res.data && res.data.message)
              add({
                id: res.data.message.id,
                from: "visitor",
                text: value,
                at: res.data.message.at,
              });
            text.value = "";
            schedule();
          } else {
            log.appendChild(
              el(
                "div",
                { class: "m welcome" },
                res.status === 429
                  ? "Please wait a moment before sending more messages."
                  : "Sorry, the message could not be sent. Please try again.",
              ),
            );
          }
        })
        .catch(function () {
          log.appendChild(
            el(
              "div",
              { class: "m welcome" },
              "Sorry, the message could not be sent. Please try again.",
            ),
          );
        })
        .then(function () {
          sending = false;
          send.disabled = false;
        });
    });

    function toggle(open) {
      isOpen = open;
      panel.className = open ? "panel open" : "panel";
      if (open) {
        unread = 0;
        text.focus();
      }
      showBadge();
      schedule();
      if (open && token()) poll();
    }
    btn.addEventListener("click", function () {
      toggle(!isOpen);
    });
    close.addEventListener("click", function () {
      toggle(false);
    });
    if (token()) poll();
  }

  function boot() {
    fetch(api + "/config", { credentials: "omit", cache: "no-store", mode: "cors" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cfg) {
        if (cfg && typeof cfg.title === "string" && typeof cfg.welcome === "string") start(cfg);
      })
      .catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
