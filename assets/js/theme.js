/* 主题引擎：把 site.json 里的 theme 配置落到 CSS 变量上 */

import { clamp, store } from "./core.js";

export const PRESETS = [
  {
    id: "sakura",
    name: "樱花",
    desc: "奶油白 + 樱花粉 + 薰衣草紫",
    accent: "#e5849e",
    accent2: "#b9a4e3",
    accent3: "#9ad3c4",
  },
  {
    id: "mint",
    name: "薄荷",
    desc: "清爽的绿松石与奶黄",
    accent: "#6cc3a9",
    accent2: "#8fb9e9",
    accent3: "#f3cb92",
  },
  {
    id: "lavender",
    name: "薰衣草",
    desc: "淡紫与蜜桃的黄昏感",
    accent: "#a68ce2",
    accent2: "#f2a7c3",
    accent3: "#8fd2e0",
  },
  {
    id: "soda",
    name: "苏打",
    desc: "汽水蓝配一点青柠",
    accent: "#7fa8e8",
    accent2: "#a99cf0",
    accent3: "#7fd8c4",
  },
];

export const FONTS = [
  { id: "rounded", name: "圆体", desc: "Quicksand + 系统中文，最清爽" },
  { id: "serif", name: "衬线", desc: "宋体气质，适合长文阅读" },
  { id: "sans", name: "黑体", desc: "纯系统字体，加载最快" },
];

export const MODES = [
  { id: "auto", name: "跟随系统" },
  { id: "light", name: "白天" },
  { id: "dark", name: "夜间" },
];

const MODE_KEY = "blog.mode";
const BOOT_KEY = "blog.boot";

export function presetOf(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

export function sanitizeColor(value) {
  const v = String(value || "").trim();
  if (/^#[0-9a-f]{3}$/i.test(v) || /^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return "";
}

export function systemMode() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveMode(themeMode) {
  const override = store.get(MODE_KEY, null);
  if (override === "light" || override === "dark") return override;
  if (themeMode === "light" || themeMode === "dark") return themeMode;
  return systemMode();
}

/* 应用主题。forceMode 用于后台预览，persist=false 时不写本地缓存 */
export function applyTheme(theme = {}, opts = {}) {
  const root = document.documentElement;
  const { forceMode = null, persist = true } = opts;

  const preset = presetOf(theme.preset);
  const font = ["rounded", "serif", "sans"].includes(theme.font) ? theme.font : "rounded";
  const radius = clamp(Number(theme.radius) || 20, 0, 34);
  const custom = sanitizeColor(theme.accent);
  const mode = forceMode || resolveMode(theme.mode);

  root.dataset.preset = preset.id;
  root.dataset.font = font;
  root.dataset.mode = mode;
  root.style.setProperty("--accent", custom || preset.accent);
  root.style.setProperty("--accent-2", preset.accent2);
  root.style.setProperty("--accent-3", preset.accent3);
  root.style.setProperty("--radius", `${radius}px`);

  const petals = theme.petals !== false;
  root.classList.toggle("no-petals", !petals);

  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.setAttribute("content", mode === "dark" ? "#1c1a22" : "#fbf7f5");

  if (persist) {
    store.set(BOOT_KEY, {
      mode,
      preset: preset.id,
      font,
      css: root.style.cssText,
      noPetals: !petals,
    });
  }
  return mode;
}

/* 顶栏的明暗切换：写本地覆盖值，之后跟随用户而不是站点默认 */
export function toggleMode(theme) {
  const next = document.documentElement.dataset.mode === "dark" ? "light" : "dark";
  store.set(MODE_KEY, next);
  applyTheme({ ...theme, mode: next }, { forceMode: next });
  return next;
}

export function clearModeOverride() {
  store.remove(MODE_KEY);
}

/* 供后台「外观」页做即时预览：返回一组可直接塞进 style 的变量 */
export function themeVars(theme = {}, mode = null) {
  const preset = presetOf(theme.preset);
  const custom = sanitizeColor(theme.accent);
  const radius = clamp(Number(theme.radius) || 20, 0, 34);
  return {
    "--accent": custom || preset.accent,
    "--accent-2": preset.accent2,
    "--accent-3": preset.accent3,
    "--radius": `${radius}px`,
    ...(mode ? { colorScheme: mode } : {}),
  };
}
