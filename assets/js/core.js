/* 基础工具：DOM、图标、日期、提示条 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* 属性值：转义 + 只放行安全协议 */
export function safeUrl(url, fallback = "") {
  const raw = String(url ?? "").trim();
  if (!raw) return fallback;
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(raw)) return escapeHtml(raw);
  if (/^[\w./-]+\.(svg|png|jpe?g|gif|webp|avif)$/i.test(raw)) return escapeHtml(raw);
  if (/^assets\//i.test(raw)) return escapeHtml(raw);
  return fallback;
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 10.2 4a6.8 6.8 0 0 0 9.8 10.5Z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  github: '<path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" fill="currentColor" stroke="none"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7.5 8 5.5 8-5.5"/>',
  rss: '<path d="M5 19a1 1 0 1 0 0 .01"/><path d="M4 11a9 9 0 0 1 9 9M4 4.5A15.5 15.5 0 0 1 19.5 20"/>',
  "arrow-left": '<path d="M19 12H5m6-6-6 6 6 6"/>',
  "arrow-right": '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  "arrow-up": '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4.8A2 2 0 0 1 4.8 2.8H12a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8Z"/><circle cx="7.6" cy="7.6" r=".9" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.4V12l3.1 1.9"/>',
  calendar: '<rect x="3.5" y="4.8" width="17" height="16.2" rx="3"/><path d="M8 2.8v4M16 2.8v4M3.5 10h17"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.4V5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15h1"/>',
  check: '<path d="m5 12.6 4.4 4.4L19 6.6"/>',
  star: '<path d="m12 3.6 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1-5.4-3-5.4 3 1.1-6.1L3.2 10l6.1-.8Z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M19 14v4.5A2.5 2.5 0 0 1 16.5 21h-11A2.5 2.5 0 0 1 3 18.5v-11A2.5 2.5 0 0 1 5.5 5H10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.6a2.1 2.1 0 0 1 3 3L7.2 19l-4.1 1 1-4.1Z"/>',
  trash: '<path d="M4 7h16M9.5 7V5.2A2.2 2.2 0 0 1 11.7 3h.6a2.2 2.2 0 0 1 2.2 2.2V7M6 7l1 13a2 2 0 0 0 2 1.9h6a2 2 0 0 0 2-1.9l1-13"/>',
  image: '<rect x="3" y="4.6" width="18" height="14.8" rx="3"/><circle cx="8.6" cy="9.6" r="1.5"/><path d="m4 17.4 5.2-4.8 4 3.6 3.2-2.6L20 17"/>',
  upload: '<path d="M12 16.5V4.2m-4.6 4.6L12 4.2l4.6 4.6"/><path d="M4 15v3.3A2.7 2.7 0 0 0 6.7 21h10.6A2.7 2.7 0 0 0 20 18.3V15"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.6" rx="3"/><path d="M8 10V7.4a4 4 0 0 1 8 0V10"/>',
  shield: '<path d="M12 3 5 5.9v5.6c0 4.4 3 7.7 7 9.5 4-1.8 7-5.1 7-9.5V5.9Z"/><path d="m9.2 11.8 2 2 3.7-3.9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.5 15.2a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.3.9Z"/>',
  eye: '<path d="M2.6 12S6.1 5.6 12 5.6 21.4 12 21.4 12 17.9 18.4 12 18.4 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="2.9"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7.5 3v5.2h7V3M8 21v-6h8v6"/>',
  palette: '<path d="M12 3.2a8.8 8.8 0 1 0 0 17.6h1.4a2 2 0 0 0 0-4h-1.2a2 2 0 0 1 0-4H16a4.8 4.8 0 0 0 4.8-4.8c0-2.7-3.9-4.8-8.8-4.8Z"/><circle cx="7.7" cy="10.4" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="6.9" r=".9" fill="currentColor" stroke="none"/><circle cx="14.4" cy="6.6" r=".9" fill="currentColor" stroke="none"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  home: '<path d="M4 10.6 12 4l8 6.6V20a1 1 0 0 1-1 1h-4.6v-6H9.6v6H5a1 1 0 0 1-1-1Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.7v.01"/>',
  alert: '<path d="M10.3 4 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z"/><path d="M12 9.2v4.2M12 17v.01"/>',
  link: '<path d="m9.6 14.4 4.8-4.8"/><path d="M11.2 6.6 13.1 4.7a4 4 0 0 1 5.7 5.7l-1.9 1.9"/><path d="M12.8 17.4l-1.9 1.9a4 4 0 0 1-5.7-5.7l1.9-1.9"/>',
  key: '<circle cx="8" cy="15.6" r="3.6"/><path d="m10.7 13 8.6-8.6M16.8 6.9l2 2M14.4 9.3l2 2"/>',
  logout: '<path d="M9.5 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.5"/><path d="M16.5 16.6 21 12l-4.5-4.6M21 12H9.5"/>',
  refresh: '<path d="M20 11.4A8 8 0 0 0 6 7.2M4 5v3.6h3.6"/><path d="M4 12.6a8 8 0 0 0 14 4.2M20 19v-3.6h-3.6"/>',
  heart: '<path d="M12 20s-7.2-4.5-7.2-9.4A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.2 3.4C19.2 15.5 12 20 12 20Z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  bold: '<path d="M7 4.5h6.2a3.7 3.7 0 0 1 0 7.4H7Zm0 7.4h7a3.8 3.8 0 0 1 0 7.6H7Z"/>',
  italic: '<path d="M15.5 4.5H8.5M15.5 19.5H8.5M14.2 4.5l-4.4 15"/>',
  heading: '<path d="M6 4.5v15M18 4.5v15M6 12h12"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5v.01M4.5 12v.01M4.5 17.5v.01"/>',
  quote: '<path d="M9.5 6.5C7 7.6 5.8 9.6 5.8 12.4c0 2 1.2 3.3 2.9 3.3 1.6 0 2.8-1.1 2.8-2.7 0-1.5-1-2.6-2.5-2.6h-.4c.2-1 1-1.9 2.2-2.5Zm8.4 0c-2.5 1.1-3.7 3.1-3.7 5.9 0 2 1.2 3.3 2.9 3.3 1.6 0 2.8-1.1 2.8-2.7 0-1.5-1-2.6-2.5-2.6h-.4c.2-1 1-1.9 2.2-2.5Z"/>',
  code: '<path d="m9 8-4.5 4L9 16M15 8l4.5 4L15 16"/>',
  music: '<path d="M9 18V6.5l10-2V16"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>',
  play: '<path d="M8 5.2 19 12 8 18.8Z" fill="currentColor" stroke-linejoin="round"/>',
  pause: '<path d="M9 5v14M15 5v14" stroke-width="2.4"/>',
  arrowup: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  eyeoff: '<path d="M4 4l16 16"/><path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.6c5.9 0 9.4 6.4 9.4 6.4a17 17 0 0 1-2.7 3.6M6.3 7.7A16.6 16.6 0 0 0 2.6 12S6.1 18.4 12 18.4c1.4 0 2.7-.4 3.9-1"/><path d="M9.9 10.2a3 3 0 0 0 4.1 4.1"/>',
};

export function icon(name, cls = "") {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg class="i${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

export function setFavicon(href) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
}

/* ---------------------------------------------------------------- 日期 */

export function parseDate(iso) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(iso || ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const pad = (n) => String(n).padStart(2, "0");

export function fmtDot(iso) {
  const d = parseDate(iso);
  if (!d) return "";
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function fmtCn(iso) {
  const d = parseDate(iso);
  if (!d) return "";
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function fmtShort(iso) {
  const d = parseDate(iso);
  if (!d) return "";
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

export function relTime(iso) {
  const d = parseDate(iso);
  if (!d) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------------------------------------------------------------- 文本 */

export function readingTime(text) {
  const s = String(text || "");
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const words = (s.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9_]+/g) || []).length;
  return Math.max(1, Math.round(cjk / 380 + words / 200));
}

export function truncate(text, len = 110) {
  const s = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > len ? s.slice(0, len).trimEnd() + "…" : s;
}

export function slugify(text, fallback = "post") {
  const s = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w\u3400-\u4dbf\u4e00-\u9fff-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || fallback;
}

export function uid(prefix = "p") {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

export function debounce(fn, ms = 200) {
  let t;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ---------------------------------------------------------------- 存储 */

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

/* ---------------------------------------------------------------- 提示 */

export function toast(message, type = "ok", timeout = 2600) {
  const root = $("#toast-root");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast${type === "err" ? " err" : ""}`;
  node.innerHTML = `${icon(type === "err" ? "alert" : "check")}<span>${escapeHtml(message)}</span>`;
  root.appendChild(node);
  setTimeout(() => {
    node.classList.add("out");
    setTimeout(() => node.remove(), 300);
  }, timeout);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* 简单的确认弹层，返回 Promise<boolean> */
export function confirmDialog({ title, message, okText = "确定", cancelText = "取消", danger = false }) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "modal-layer";
    layer.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="modal-acts">
          <button class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${escapeHtml(okText)}</button>
        </div>
      </div>`;
    const close = (val) => {
      layer.classList.add("out");
      setTimeout(() => layer.remove(), 180);
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    layer.addEventListener("click", (e) => {
      if (e.target === layer) close(false);
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "ok") close(true);
      if (act === "cancel") close(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(layer);
    requestAnimationFrame(() => layer.classList.add("in"));
    layer.querySelector('[data-act="ok"]').focus();
  });
}
