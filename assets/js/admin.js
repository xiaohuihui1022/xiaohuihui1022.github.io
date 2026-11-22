/* 控制面板
   流程：首次初始化（设置密码 + 绑定仓库） → 密码解锁 → 本机令牌 → 编辑 → 提交到 GitHub
   安全模型：
   - 仓库里只存 PBKDF2-SHA256（60 万次迭代）派生的校验值，不存明文密码
   - GitHub 令牌只在本机 localStorage / sessionStorage，永不写进仓库
   - 首次初始化必须提供一个对该仓库有写权限的令牌，因此陌生访客无法抢占 */

import {
  $,
  $$,
  escapeHtml,
  icon,
  toast,
  store,
  debounce,
  confirmDialog,
  uid,
  slugify,
  todayISO,
  fmtDot,
  readingTime,
  clamp,
} from "./core.js";
import { makeAuth, verifyPassword, strength, suggestPassword, MIN_LENGTH } from "./auth.js";
import { GitHub, GitHubError, bytesToB64 } from "./github.js";
import { renderMarkdown } from "./markdown.js";
import { applyTheme, PRESETS, FONTS, MODES, themeVars, presetOf } from "./theme.js";
import { previewCardsHTML, musicSongs, musicCardHTML, hydrateMusic } from "./views.js";
import { INDEX_FILE, POSTS_DIR, postPath, toMeta, metasFromLegacy } from "./posts.js";

const TOKEN_KEY = "blog.gh.token";
const REPO_FILE = "content/site.json";

const S = {
  root: null,
  ctx: null,
  mode: "github",
  backend: null,
  site: null,
  posts: [],        // 索引：每篇只有元信息
  baseSite: "",
  basePosts: "",
  editing: null,    // 正在编辑的完整文章
  loadingEditor: false,
  editingBase: "",
  editingPath: "",  // 打开时它在仓库里的路径（新建为空）
  deleted: [],      // 保存时要删掉的文件
  sha: {},
  gh: null,
  tab: "content",
  editingId: null,
  listQuery: "",
  pane: "split",
  busy: false,
  raf: 0,
  ac: null,
};

/* ================================================================ 工具 */

const clone = (v) => JSON.parse(JSON.stringify(v));

/* 索引统一成「元信息数组」 */
function normalizeIndex(raw) {
  if (Array.isArray(raw)) return clone(raw);
  const list = raw && Array.isArray(raw.posts) ? raw.posts : [];
  return clone(list);
}

/* 读写后端：web 走 GitHub，local 走本地服务 */
async function readRemote(path) {
  if (S.mode === "local") return S.backend.readFile(path);
  const file = await S.gh.getFile(path);
  return file.text;
}

async function saveRemote(files, message) {
  if (!files.length) return { files: 0 };
  if (S.mode === "local") {
    await S.backend.saveFiles(files);
    return { files: files.length };
  }
  return S.gh.commitFiles(files, message);
}

function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

const str = (v) => (v == null ? "" : String(v));

function parseTags(input) {
  return String(input || "")
    .split(/[,，、;；]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function siteDirty() {
  return JSON.stringify(S.site) !== S.baseSite;
}
function postsDirty() {
  return JSON.stringify(S.posts) !== S.basePosts || S.deleted.length > 0;
}
function editingDirty() {
  return Boolean(S.editing) && JSON.stringify(S.editing) !== S.editingBase;
}
function isDirty() {
  return siteDirty() || postsDirty() || editingDirty();
}

function updateDirtyBadge() {
  const el = $(".dirty");
  if (el) el.classList.toggle("is-on", isDirty());
}

function loadingBlock(text = "正在加载…") {
  return `<div class="boot" style="padding:120px 0"><span class="boot-dot"></span><p>${escapeHtml(text)}</p></div>`;
}

function loadCSS() {
  if (document.querySelector('link[data-admin-css], link[href*="admin.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "assets/css/admin.css";
  link.dataset.adminCss = "1";
  document.head.appendChild(link);
}

function repoConfig() {
  const r = S.site?.admin?.repo || {};
  return { owner: r.owner || "", name: r.name || "", branch: r.branch || "main" };
}

/* 面板里预览用的明暗：优先用顶部开关，其次用站点配置，最后跟随系统 */
function draftMode() {
  if (S.previewMode) return S.previewMode;
  const t = S.site?.theme || {};
  if (t.mode === "light" || t.mode === "dark") return t.mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/* 让面板也立刻用上草稿主题 */
function applyDraftTheme() {
  applyTheme(S.site?.theme || {}, { persist: false, forceMode: draftMode() });
}

/* ================================================================ 挂载 */

export async function mount(root, ctx) {
  S.root = root;
  S.ctx = ctx;
  S.mode = ctx.mode === "local" ? "local" : "github";
  S.backend = ctx.backend || null;
  S.ac = new AbortController();
  loadCSS();

  S.site = clone(ctx.sitePayload || {});
  S.posts = normalizeIndex(ctx.indexPayload);
  S.baseSite = JSON.stringify(S.site);
  S.basePosts = JSON.stringify(S.posts);
  S.editing = null;
  S.editingBase = "";
  S.editingPath = "";
  S.deleted = [];

  bindGlobalEvents();

  let auth = S.site?.admin?.auth;
  const token = store.get(TOKEN_KEY, "");

  // 有令牌但部署的配置里还没有密码：可能是刚初始化、Pages 还没重新部署完，
  // 这种情况直接问仓库，避免让用户重复走一遍初始化。（本地模式不需要）
  if (S.mode !== "local" && !auth && token) {
    const cfg0 = repoConfig();
    if (cfg0.owner && cfg0.name) {
      S.root.innerHTML = `<div class="lock-wrap"><div class="boot"><span class="boot-dot"></span><p>正在确认仓库状态…</p></div></div>`;
      try {
        const probe = new GitHub({ token, owner: cfg0.owner, repo: cfg0.name, branch: cfg0.branch });
        const file = await probe.getFile(REPO_FILE);
        const remote = JSON.parse(file.text || "{}");
        if (remote?.admin?.auth) {
          S.site = remote;
          S.baseSite = JSON.stringify(S.site);
          S.sha[REPO_FILE] = file.sha;
          auth = remote.admin.auth;
        }
      } catch {}
    }
  }

  if (!auth) {
    renderSetup();
    return;
  }

  renderLock();
}

export function unmount() {
  try {
    S.ac?.abort();
  } catch {}
  S.ac = null;
  S.editingId = null;
  S.busy = false;
}

/* ================================================================ 首次初始化 */

function renderSetup() {
  const cfg = repoConfig();
  const isLocal = S.mode === "local";
  S.root.innerHTML = `
  <div class="lock-wrap">
    <div class="lock-card ${isLocal ? "" : "wide"}">
      <img class="lock-avatar" src="${escapeHtml(S.site?.site?.avatar || "assets/img/avatar.svg")}" alt="" />
      <h1>第一次见面，先设个密码</h1>
      <p class="lead">
        这个密码用来打开控制台。它不会被保存，只有一段<b>经过 60 万次 PBKDF2 计算的哈希</b>会写进
        <code>content/site.json</code>——即使仓库是公开的，别人也无法从哈希反推出密码。
      </p>
      <div class="steps"><i class="on"></i><i></i><i></i></div>

      <form class="lock-form" id="setup-form" autocomplete="off">
        <div class="field">
          <label>${icon("key")} 设置管理员密码</label>
          <div class="input-group">
            <input class="input" type="password" id="s-pw" placeholder="至少 ${MIN_LENGTH} 位，建议 16 位以上" autocomplete="new-password" />
            <button class="btn btn-line" type="button" data-act="suggest-pw" title="帮我生成一个">${icon("refresh")}</button>
          </div>
          <div class="pw-meter"><i id="s-meter"></i></div>
          <div class="pw-hint"><span id="s-strength">建议使用一句只有你记得的话</span><span></span></div>
        </div>

        <div class="field">
          <label>${icon("lock")} 再输入一次</label>
          <input class="input" type="password" id="s-pw2" placeholder="确认密码" autocomplete="new-password" />
        </div>

        ${
          isLocal
            ? `<p class="hint" style="text-align:center">
                 本地模式会把哈希直接写入 <code>content/site.json</code>，不访问 GitHub。
               </p>`
            : `<div class="field">
                 <label>${icon("github")} GitHub 仓库</label>
                 <div class="grid2">
                   <input class="input" id="s-owner" placeholder="用户名，如 your-name" value="${escapeHtml(cfg.owner)}" />
                   <input class="input" id="s-repo" placeholder="仓库名，如 my-blog" value="${escapeHtml(cfg.name)}" />
                 </div>
                 <div class="input-group" style="margin-top:8px">
                   <input class="input" id="s-branch" placeholder="分支" value="${escapeHtml(cfg.branch)}" />
                   <input class="input" id="s-token" type="password" placeholder="GitHub 访问令牌（只保存在本机）" autocomplete="off" />
                 </div>
                 <span class="hint">
                   Fine-grained token：<b>Repository access</b> 选 Only select repositories 并勾选本仓库，
                   <b>Permissions → Contents</b> 选 <b>Read and write</b>（默认是 Read-only）。
                   <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer" style="color:var(--accent-text);white-space:nowrap">去创建 →</a>
                 </span>
               </div>`
        }

        <div class="lock-error" id="s-error"></div>

        <button class="btn btn-primary" type="submit" id="s-submit" style="height:46px;margin-top:4px">
          ${icon("shield")} 完成初始化
        </button>
        ${
          isLocal
            ? ""
            : `<p class="hint" style="text-align:center">
                 令牌只用于把文章提交到你的仓库，永远不会写进仓库或发送到别处。
               </p>`
        }
      </form>
    </div>
  </div>`;

  const pw = $("#s-pw");
  const meter = $("#s-meter");
  const label = $("#s-strength");

  pw.addEventListener("input", () => {
    const st = strength(pw.value);
    meter.style.width = `${[8, 38, 70, 100][st.level]}%`;
    meter.style.background = ["#c4566f", "#e0b34a", "#7fc9a8", "var(--accent)"][st.level];
    label.textContent = pw.value ? `${st.label} · ${st.hint}` : "建议使用一句只有你记得的话";
  });

  $('[data-act="suggest-pw"]').addEventListener("click", () => {
    const suggestion = suggestPassword();
    pw.value = suggestion;
    $("#s-pw2").value = suggestion;
    pw.dispatchEvent(new Event("input"));
    toast("已生成，记得自己再记一下");
  });

  $("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#s-error");
    const fail = (msg) => {
      err.textContent = msg;
      err.classList.add("is-on");
      return false;
    };
    err.classList.remove("is-on");

    const password = pw.value;
    const password2 = $("#s-pw2").value;

    if (password.length < MIN_LENGTH) return fail(`密码至少 ${MIN_LENGTH} 位`);
    if (password !== password2) return fail("两次输入的密码不一样");

    // 本地模式：只写本地文件，不需要令牌
    if (isLocal) {
      const btnL = $("#s-submit");
      btnL.classList.add("is-busy");
      btnL.innerHTML = `${icon("refresh")} 正在计算哈希…`;
      try {
        const auth = await makeAuth(password);
        S.site.admin = S.site.admin || {};
        S.site.admin.auth = auth;
        S.site.updatedAt = new Date().toISOString();
        await S.backend.writeFile(REPO_FILE, JSON.stringify(S.site, null, 2) + "\n");
        S.baseSite = JSON.stringify(S.site);
        toast("密码已写入本地文件");
        await startLocal();
      } catch (e2) {
        fail(e2?.message || "写入失败");
        btnL.classList.remove("is-busy");
        btnL.innerHTML = `${icon("shield")} 完成初始化`;
      }
      return;
    }

    const owner = $("#s-owner").value.trim();
    const name = $("#s-repo").value.trim();
    const branch = $("#s-branch").value.trim() || "main";
    const token = $("#s-token").value.trim();

    if (!owner || !name) return fail("请填写 GitHub 用户名和仓库名");
    if (!token) return fail("请填写 GitHub 访问令牌");

    const btn = $("#s-submit");
    btn.classList.add("is-busy");
    btn.innerHTML = `${icon("refresh")} 正在验证令牌…`;

    try {
      const gh = new GitHub({ token, owner, repo: name, branch });
      const info = await gh.check();
      if (!info.canPush) throw new Error("这个令牌只能读、不能写。Fine-grained token 请在 Permissions → Contents 里选 Read and write 后重新生成（默认是 Read-only）");

      btn.innerHTML = `${icon("lock")} 正在计算密码哈希…`;
      const auth = await makeAuth(password);

      btn.innerHTML = `${icon("save")} 正在写入配置…`;
      S.site.admin = S.site.admin || {};
      S.site.admin.repo = { owner, name, branch };
      S.site.admin.auth = auth;
      S.site.updatedAt = new Date().toISOString();

      try {
        const file = await gh.getFile(REPO_FILE);
        // 以仓库里的内容为准，避免覆盖别处的修改
        const remote = JSON.parse(file.text || "{}");
        S.site = { ...remote, admin: { ...(remote.admin || {}), repo: { owner, name, branch }, auth } };
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 404) throw e;
      }

      await gh.commitFiles(
        [{ path: REPO_FILE, text: JSON.stringify(S.site, null, 2) + "\n" }],
        "初始化控制台与管理员密码"
      );
      S.sha[REPO_FILE] = "";

      store.set(TOKEN_KEY, token);
      S.gh = gh;
      S.baseSite = JSON.stringify(S.site);
      S.ctx.reload?.();

      toast("初始化完成，欢迎回来");
      await startApp();
    } catch (e2) {
      fail(e2 instanceof GitHubError ? e2.message : e2.message || "初始化失败");
      btn.classList.remove("is-busy");
      btn.innerHTML = `${icon("shield")} 完成初始化`;
    }
  });
}

/* ================================================================ 解锁 */

function renderLock() {
  const s = S.site?.site || {};
  S.root.innerHTML = `
  <div class="lock-wrap">
    <div class="lock-card">
      <img class="lock-avatar" src="${escapeHtml(s.avatar || "assets/img/avatar.svg")}" alt="" />
      <h1>${escapeHtml(s.title || "控制台")}</h1>
      <p class="lead">输入管理员密码，才能进去改主题和写文章。</p>
      <form class="lock-form" id="lock-form">
        <div class="field" style="margin:0">
          <div class="input-group">
            <input class="input" type="password" id="lock-pw" placeholder="管理员密码" autocomplete="current-password" autofocus />
            <button class="btn btn-primary" type="submit" id="lock-btn">${icon("lock")} 进入</button>
          </div>
        </div>
        <div class="lock-error" id="lock-err"></div>
        <div class="progress-line" id="lock-progress"><i></i></div>
      </form>
      <div class="lock-foot">
        <button type="button" data-act="forgot">忘记密码？</button>
        <a href="#/">${icon("arrow-left")} 回到博客</a>
      </div>
    </div>
  </div>`;

  const form = $("#lock-form");
  const input = $("#lock-pw");
  const err = $("#lock-err");
  const progress = $("#lock-progress");

  input.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!input.value) return;
    err.classList.remove("is-on");
    progress.classList.add("on");
    $("#lock-btn").disabled = true;

    const ok = await verifyPassword(input.value, S.site.admin.auth).catch(() => false);
    progress.classList.remove("on");
    $("#lock-btn").disabled = false;

    if (!ok) {
      err.textContent = "密码不对，再想想？";
      err.classList.add("is-on");
      input.select();
      return;
    }
    if (S.mode === "local") {
      await startLocal();
      return;
    }
    const token = store.get(TOKEN_KEY, "");
    if (token) await startApp();
    else renderTokenGate();
  });

  $('[data-act="forgot"]').addEventListener("click", () => {
    showForgot();
  });
}

async function showForgot() {
  const cfg = repoConfig();
  await confirmDialog({
    title: "忘记密码怎么办？",
    message: `密码无法找回，只能重置。打开 GitHub 上 ${cfg.owner || "你的账号"}/${cfg.name || "仓库"} 的 content/site.json，把 "auth": {...} 整段改成 null，保存后刷新本页，就会重新进入初始化流程。`,
    okText: "知道了",
    cancelText: "关闭",
  });
}

/* ================================================================ 本机令牌 */

function renderTokenGate() {
  const cfg = repoConfig();
  S.root.innerHTML = `
  <div class="lock-wrap">
    <div class="lock-card">
      <img class="lock-avatar" src="${escapeHtml(S.site?.site?.avatar || "assets/img/avatar.svg")}" alt="" />
      <h1>这台设备还没有令牌</h1>
      <p class="lead">
        密码验证通过了。还需要一个 GitHub 令牌，才能把修改提交到
        <b>${escapeHtml(cfg.owner)}/${escapeHtml(cfg.name)}</b>。<br />
        令牌只保存在这台设备的浏览器里，不会上传。
      </p>
      <form class="lock-form" id="token-form">
        <div class="field" style="margin:0">
          <input class="input" type="password" id="t-token" placeholder="GitHub 访问令牌" autocomplete="off" autofocus />
          <span class="hint">
            <b>Repository access</b> 要勾选本仓库，<b>Permissions → Contents</b> 要选 <b>Read and write</b>（默认 Read-only）。
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer" style="color:var(--accent-text);white-space:nowrap">去创建 →</a>
          </span>
        </div>
        <div class="lock-error" id="t-err"></div>
        <button class="btn btn-primary" type="submit" id="t-btn" style="height:44px">${icon("login" in {} ? "lock" : "lock")} 验证并进入</button>
      </form>
      <div class="lock-foot">
        <button type="button" data-act="forgot-token">令牌是什么？</button>
        <a href="#/">${icon("arrow-left")} 回到博客</a>
      </div>
    </div>
  </div>`;

  const submit = async (e) => {
    e.preventDefault();
    const token = $("#t-token").value.trim();
    const err = $("#t-err");
    if (!token) return;
    err.classList.remove("is-on");
    const btn = $("#t-btn");
    btn.classList.add("is-busy");
    btn.innerHTML = `${icon("refresh")} 验证中…`;

    try {
      const cfg2 = repoConfig();
      const gh = new GitHub({ token, owner: cfg2.owner, repo: cfg2.name, branch: cfg2.branch });
      const info = await gh.check();
      if (!info.canPush) throw new Error("这个令牌只能读、不能写。Fine-grained token 请在 Permissions → Contents 里选 Read and write 后重新生成（默认是 Read-only）");
      store.set(TOKEN_KEY, token);
      toast("验证通过");
      await startApp();
    } catch (e2) {
      err.textContent = e2.message || "验证失败";
      err.classList.add("is-on");
      btn.classList.remove("is-busy");
      btn.innerHTML = `${icon("lock")} 验证并进入`;
    }
  };

  $("#token-form").addEventListener("submit", submit);
  $('[data-act="forgot-token"]').addEventListener("click", () => {
    confirmDialog({
      title: "GitHub 令牌",
      message:
        "在 github.com/settings/personal-access-tokens/new 创建一个 Fine-grained token：Repository access 选你的博客仓库，Permissions 里把 Contents 设为 Read and write，生成后复制那串以 github_pat_ 开头的字符。",
      okText: "知道了",
      cancelText: "关闭",
    });
  });
}

/* ================================================================ 进入主界面 */

/* 本地模式：直接从磁盘读，不走 GitHub */
async function startLocal() {
  S.root.innerHTML = `<div class="lock-wrap"><div class="boot"><span class="boot-dot"></span><p>正在读取本地文件…</p></div></div>`;
  try {
    const data = await S.backend.load();
    S.site = data.site || {};
    S.posts = normalizeIndex(data.posts);
    S.baseSite = JSON.stringify(S.site);
    S.basePosts = JSON.stringify(S.posts);
    S.editing = null;
    S.editingPath = "";
    S.deleted = [];
  } catch (e) {
    toast(`读取本地文件失败：${e.message}`, "err");
    return;
  }
  applyDraftTheme();
  S.tab = "content";
  S.editingId = null;
  renderShell();
}

async function startApp() {
  const cfg = repoConfig();
  const token = store.get(TOKEN_KEY, "");
  S.gh = new GitHub({ token, owner: cfg.owner, repo: cfg.name, branch: cfg.branch });

  S.root.innerHTML = `<div class="lock-wrap"><div class="boot"><span class="boot-dot"></span><p>正在读取仓库…</p></div></div>`;

  // 以仓库当前内容为基线，避免覆盖别处的修改
  try {
    const [siteFile, indexFile] = await Promise.all([
      S.gh.getFile(REPO_FILE).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
      S.gh.getFile(INDEX_FILE).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
    ]);
    if (siteFile) S.site = JSON.parse(siteFile.text);
    if (indexFile) {
      S.posts = normalizeIndex(JSON.parse(indexFile.text));
    } else {
      // 还没迁移过的旧仓库：从单个 posts.json 兜底
      const legacy = await S.gh.getFile("content/posts.json").catch(() => null);
      if (legacy) S.posts = metasFromLegacy(JSON.parse(legacy.text).posts || []);
    }
    S.baseSite = JSON.stringify(S.site);
    S.basePosts = JSON.stringify(S.posts);
    S.editing = null;
    S.editingPath = "";
    S.deleted = [];
  } catch (e) {
    if (e instanceof GitHubError) {
      toast(`读取仓库失败：${e.message}`, "err");
    }
  }

  applyDraftTheme();
  S.tab = "content";
  S.editingId = null;
  renderShell();
}

/* ================================================================ 框架 */

const TABS = [
  { id: "content", label: "文章", icon: "doc" },
  { id: "appearance", label: "外观", icon: "palette" },
  { id: "site", label: "站点", icon: "settings" },
  { id: "music", label: "音乐", icon: "music" },
  { id: "security", label: "安全", icon: "shield" },
];

function renderShell() {
  const s = S.site?.site || {};
  const cfg = repoConfig();
  const count = S.posts.length;
  const isLocal = S.mode === "local";

  S.root.innerHTML = `
  <div class="adm">
    <aside class="adm-side">
      <div class="adm-brand">
        <img src="${escapeHtml(s.avatar || "assets/img/avatar.svg")}" alt="" />
        <div>
          <b>${escapeHtml(s.title || "我的小站")}</b>
          <span>${isLocal ? "本地控制台" : "控制台"}</span>
        </div>
      </div>
      <nav class="adm-nav">
        ${TABS.map(
          (t) =>
            `<button data-tab="${t.id}" class="${S.tab === t.id ? "is-on" : ""}">${icon(t.icon)}${t.label}${
              t.id === "content" ? `<span class="badge-n">${count}</span>` : ""
            }</button>`
        ).join("")}
      </nav>
      <div class="adm-side-foot">
        <div class="repo-pill" title="${isLocal ? "本地文件" : escapeHtml(cfg.owner) + "/" + escapeHtml(cfg.name)}">
          ${icon(isLocal ? "home" : "github")}<span>${
            isLocal ? "本地文件 · 一次提交" : `${escapeHtml(cfg.owner)}/${escapeHtml(cfg.name)}`
          }</span>
        </div>
        <a href="#/" data-act="exit">${icon("eye")}<span>查看网站</span></a>
      </div>
    </aside>

    <main class="adm-main">
      <header class="adm-top">
        <h1 id="adm-title">文章</h1>
        <span class="sub" id="adm-sub"></span>
        <div class="adm-acts">
          <span class="dirty">未保存</span>
          <button class="btn btn-line btn-sm" data-act="preview-mode" title="预览明暗（不影响保存的设置）">${icon(document.documentElement.dataset.mode === "dark" ? "sun" : "moon")}</button>
          <button class="btn btn-line btn-sm" data-act="reload" title="${isLocal ? "从磁盘重新读取" : "从仓库重新读取"}">${icon("refresh")}</button>
          ${
            isLocal
              ? `<button class="btn btn-soft btn-sm" data-act="commit" title="把所有改动合成一个提交">${icon("check")} 提交<span class="git-n"></span></button>
                 <button class="btn btn-primary btn-sm" data-act="save">${icon("save")} 保存到本地</button>`
              : `<button class="btn btn-primary btn-sm" data-act="save">${icon("save")} 保存并发布</button>`
          }
        </div>
      </header>
      <div class="adm-body" id="adm-body"></div>
    </main>
  </div>`;

  renderTab();
  if (isLocal) refreshGitBadge();
}

function setTab(tab) {
  if (S.tab === tab) return;
  if (isDirty()) {
    confirmDialog({
      title: "还有没保存的修改",
      message: "切换分区会丢掉这些修改，确定要走吗？",
      okText: "丢掉并切换",
      cancelText: "留下",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      revertDrafts();
      S.tab = tab;
      S.editingId = null;
      renderShell();
    });
    return;
  }
  S.tab = tab;
  S.editingId = null;
  renderShell();
}

function revertDrafts() {
  S.site = JSON.parse(S.baseSite);
  S.posts = JSON.parse(S.basePosts);
  S.deleted = [];
  S.editing = null;
  S.editingBase = "";
  S.editingPath = "";
  S.editingId = null;
  applyDraftTheme();
}

function renderTab() {
  const body = $("#adm-body");
  const title = $("#adm-title");
  if (!body) return;

  const subs = {
    content: "写下、修改、发布",
    appearance: "配色、字体、圆角，改了立刻能看到",
    site: "站点信息、导航、关于页面",
    music: "用网易云音乐分享你在听的歌",
    security: "密码、令牌与仓库",
  };
  if (title) title.textContent = TABS.find((t) => t.id === S.tab)?.label || "";
  const sub = $("#adm-sub");
  if (sub) sub.textContent = subs[S.tab] || "";

  if (S.tab === "content") {
    if (S.loadingEditor) body.innerHTML = loadingBlock("正在读取文章…");
    else body.innerHTML = S.editingId ? editorHTML() : listHTML();
  } else if (S.tab === "appearance") body.innerHTML = appearanceHTML();
  else if (S.tab === "site") body.innerHTML = siteHTML();
  else if (S.tab === "music") body.innerHTML = musicHTML();
  else body.innerHTML = securityHTML();

  if (S.tab === "content" && S.editingId && !S.loadingEditor) wireEditor();
  if (S.tab === "appearance") wireAppearance();
  if (S.tab === "site") wireSite();
  if (S.tab === "music") wireMusic();
  if (S.tab === "security") wireSecurity();

  updateDirtyBadge();
  $$(".adm-nav button").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === S.tab));
}

/* ================================================================ 文章列表 */

function sortedPosts(list) {
  return list
    .slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function listHTML() {
  const list = sortedPosts(S.posts);
  const q = S.listQuery.trim().toLowerCase();
  const filtered = q
    ? list.filter((p) => `${p.title} ${(p.tags || []).join(" ")}`.toLowerCase().includes(q))
    : list;

  return `
  <div class="adm-tab">
    <div class="list-bar">
      <button class="btn btn-primary btn-sm" data-act="new-post">${icon("plus")} 写新文章</button>
      <div class="spacer"></div>
      <input class="input" id="list-q" placeholder="搜索标题或标签…" value="${escapeHtml(S.listQuery)}" style="height:36px" />
    </div>

    ${
      filtered.length
        ? `<div class="plist">${filtered.map(rowHTML).join("")}</div>`
        : `<div class="adm-empty"><b>${q ? "没有匹配的文章" : "还没有文章"}</b><span>${
            q ? "换个关键词试试" : "点右上角「写新文章」开始第一篇"
          }</span></div>`
    }

    <p class="panel-desc" style="margin-top:22px">
      一篇文章一个文件（<code>content/posts/&lt;标签&gt;/&lt;slug&gt;.json</code>），列表读
      <code>content/posts/index.json</code>。每次保存只提交改动的那几个文件，GitHub Pages 通常 30–60 秒后更新。
    </p>
  </div>`;
}

function rowHTML(p) {
  const tags = (p.tags || []).slice(0, 3).map((t) => `#${escapeHtml(t)}`).join("  ");
  return `
  <div class="prow ${p.draft ? "draft" : ""}">
    ${
      p.cover
        ? `<img class="thumb" src="${escapeHtml(p.cover)}" alt="" loading="lazy" />`
        : `<span class="thumb">${icon("image")}</span>`
    }
    <div class="main">
      <div class="t">
        <span>${escapeHtml(p.title || "无标题")}</span>
        ${p.draft ? `<span class="badge warn">草稿</span>` : `<span class="badge ok">已发布</span>`}
        ${p.pinned ? `<span class="badge pin">置顶</span>` : ""}
      </div>
      <div class="m">
        <span class="p-date">${fmtDot(p.date)}</span>
        ${tags ? `<span class="p-tags">${tags}</span>` : ""}
        <span class="p-time">${p.readingTime || 1} 分钟</span>
      </div>
    </div>
    <div class="acts">
      <button class="mini" data-act="pin" data-id="${p.id}" title="${p.pinned ? "取消置顶" : "置顶"}">${icon("star")}</button>
      <button class="mini" data-act="edit" data-id="${p.id}" title="编辑">${icon("edit")}</button>
      <button class="mini danger" data-act="del" data-id="${p.id}" title="删除">${icon("trash")}</button>
    </div>
  </div>`;
}

/* ================================================================ 编辑器 */

function currentPost() {
  return S.editing;
}

/* 打开一篇：索引里只有元信息，正文要单独取回来 */
async function openEditor(id) {
  const meta = S.posts.find((p) => p.id === id);
  if (!meta) return;
  S.loadingEditor = true;
  S.editingId = id;
  renderTab();
  try {
    const text = await readRemote(meta.path);
    const post = JSON.parse(text);
    S.editing = { ...post, id: post.id || id, path: meta.path };
    S.editingBase = JSON.stringify(S.editing);
    S.editingPath = meta.path;
  } catch (e) {
    console.error(e);
    toast(`读取这篇文章失败：${e?.message || e}`, "err");
    S.editingId = null;
    S.editing = null;
  } finally {
    S.loadingEditor = false;
    renderTab();
  }
}

function editorHTML() {
  const p = currentPost();
  if (!p) return loadingBlock("正在读取文章…");
  const wide = window.innerWidth > 1100;
  const pane = S.pane || (wide ? "split" : "edit");
  const words = String(p.body || "").replace(/\s/g, "").length;

  return `
  <div class="adm-tab editor">
    <div class="editor-top">
      <button class="btn btn-line btn-sm" data-act="back-list">${icon("arrow-left")} 列表</button>
      <div style="flex:1"></div>
      <div class="seg" id="pane-seg">
        <button data-pane="edit" class="${pane === "edit" ? "is-on" : ""}">编辑</button>
        <button data-pane="split" class="${pane === "split" ? "is-on" : ""}">分栏</button>
        <button data-pane="preview" class="${pane === "preview" ? "is-on" : ""}">预览</button>
      </div>
    </div>

    <input class="editor-title" id="e-title" value="${escapeHtml(p.title || "")}" placeholder="给这篇文章起个标题…" />

    <div class="editor-meta">
      <div class="field" style="max-width:150px">
        <label>日期</label>
        <input class="input" type="date" id="e-date" value="${escapeHtml(p.date || todayISO())}" />
      </div>
      <div class="field" style="max-width:200px">
        <label>链接标识</label>
        <input class="input" id="e-slug" value="${escapeHtml(p.slug || "")}" placeholder="hello-world" />
      </div>
      <div class="field">
        <label>标签（逗号分隔）</label>
        <input class="input" id="e-tags" value="${escapeHtml((p.tags || []).join(", "))}" placeholder="随笔, 生活" />
      </div>
      <div class="field" style="max-width:none;flex:0 0 auto">
        <label>状态</label>
        <div class="seg" id="e-status">
          <button data-draft="false" class="${!p.draft ? "is-on" : ""}">发布</button>
          <button data-draft="true" class="${p.draft ? "is-on" : ""}">草稿</button>
        </div>
      </div>
      <div class="field" style="max-width:none;flex:0 0 auto">
        <label>置顶</label>
        <label class="switch" style="margin-top:6px">
          <input type="checkbox" id="e-pinned" ${p.pinned ? "checked" : ""} />
          <span class="track"></span>
        </label>
      </div>
    </div>

    <div class="panel" style="padding:16px 18px">
      <div class="cover-box">
        ${p.cover ? `<img class="cover-thumb" id="e-cover-img" src="${escapeHtml(p.cover)}" alt="" />` : `<div class="cover-empty" id="e-cover-img">${icon("image")}还没有封面</div>`}
        <div style="flex:1;min-width:220px;display:flex;flex-direction:column;gap:8px">
          <div class="input-group">
            <input class="input" id="e-cover" value="${escapeHtml(p.cover || "")}" placeholder="封面图片地址，或直接上传" />
            <button class="btn btn-line btn-sm" data-act="pick-cover">${icon("upload")} 上传</button>
            ${p.cover ? `<button class="btn btn-line btn-sm" data-act="clear-cover">${icon("x")}</button>` : ""}
          </div>
          <span class="hint">建议 16:10，上传的图片会压缩后存进仓库的 <code>assets/uploads/</code></span>
          <div class="progress-line" id="cover-progress"><i></i></div>
        </div>
      </div>
    </div>

    <div class="field">
      <label>摘要（不填会自动截取正文开头）</label>
      <textarea class="textarea" id="e-excerpt" rows="2" placeholder="一句话介绍这篇文章">${escapeHtml(p.excerpt || "")}</textarea>
    </div>

    <div>
      <div class="editor-toolbar" id="md-toolbar">
        <button data-md="h2" title="二级标题">H2</button>
        <button data-md="h3" title="三级标题">H3</button>
        <span class="sep"></span>
        <button data-md="bold" title="加粗">${icon("bold")}</button>
        <button data-md="italic" title="斜体">${icon("italic")}</button>
        <button data-md="del" title="删除线">S̶</button>
        <span class="sep"></span>
        <button data-md="ul" title="列表">${icon("list")}</button>
        <button data-md="quote" title="引用">${icon("quote")}</button>
        <button data-md="code" title="代码块">${icon("code")}</button>
        <button data-md="hr" title="分隔线">―</button>
        <span class="sep"></span>
        <button data-md="link" title="链接">${icon("link")}</button>
        <button data-md="image" title="插入图片">${icon("image")}</button>
        <button data-md="music" title="插入音乐卡片">${icon("music")}</button>
        <button data-md="color" title="文字颜色" class="tb-color">A</button>
        <div class="spacer"></div>
        <button data-md="preview-toggle" title="刷新预览">${icon("eye")}</button>
      </div>
      <div class="editor-panes ${pane === "split" ? "" : "single"}">
        <textarea class="md-input" id="md-input" placeholder="用 Markdown 写正文&#10;&#10;## 小标题&#10;**加粗**、*斜体*、\`行内代码\`&#10;&#10;- 列表项&#10;- 另一项&#10;&#10;> 引用&#10;&#10;\`\`\`js&#10;console.log('hello')&#10;\`\`\`">${escapeHtml(p.body || "")}</textarea>
        <div class="md-preview" id="md-preview" style="${pane === "edit" ? "display:none" : ""}">
          <div class="prose" id="md-preview-body"></div>
        </div>
      </div>
    </div>

    <div class="editor-foot">
      <button class="btn btn-primary" data-act="save-post">${icon("save")} 保存这篇文章</button>
      <button class="btn btn-line" data-act="back-list">取消</button>
      <div class="spacer"></div>
      <span class="stat">${words} 字 · 约 ${readingTime(p.body || "")} 分钟</span>
      <span class="stat stat-path" title="保存后会写到这里">${escapeHtml(postPath(p))}</span>
    </div>

    <input type="file" accept="image/*" id="cover-file" hidden />
    <input type="file" accept="image/*" id="inline-file" hidden />
  </div>`;
}

function wireEditor() {
  const p = currentPost();
  if (!p) return;
  const ta = $("#md-input");
  const previewBody = $("#md-preview-body");

  const refresh = () => {
    if (!previewBody) return;
    previewBody.innerHTML = renderMarkdown(ta.value);
    hydrateMusic(previewBody, S.site);
  };
  const refreshSoon = debounce(refresh, 180);
  refresh();

  const sync = () => {
    p.body = ta.value;
    const stat = $(".editor-foot .stat");
    if (stat) stat.textContent = `${String(ta.value).replace(/\s/g, "").length} 字 · 约 ${readingTime(ta.value)} 分钟`;
    updateDirtyBadge();
  };

  // 底部那行「会存到哪个文件」跟着标题/标签实时变
  const syncPath = () => {
    const el = $(".stat-path");
    if (el) {
      el.textContent = postPath(p);
      el.title = postPath(p);
    }
  };

  ta.addEventListener("input", () => {
    sync();
    refreshSoon();
  });

  // Tab 缩进
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText("  ", s, ta.selectionEnd, "end");
      sync();
      refreshSoon();
    }
  });

  $("#e-title").addEventListener("input", (e) => {
    p.title = e.target.value;
    const slugInput = $("#e-slug");
    if (slugInput && !p.slugTouched) {
      p.slug = slugify(e.target.value, "");
      slugInput.value = p.slug;
    }
    syncPath();
    updateDirtyBadge();
  });

  $("#e-slug").addEventListener("input", (e) => {
    p.slug = e.target.value.trim();
    p.slugTouched = true;
    syncPath();
    updateDirtyBadge();
  });

  $("#e-date").addEventListener("input", (e) => {
    p.date = e.target.value;
    updateDirtyBadge();
  });

  $("#e-tags").addEventListener("input", (e) => {
    p.tags = parseTags(e.target.value);
    syncPath();
    updateDirtyBadge();
  });

  $("#e-excerpt").addEventListener("input", (e) => {
    p.excerpt = e.target.value;
    updateDirtyBadge();
  });

  $("#e-pinned").addEventListener("change", (e) => {
    p.pinned = e.target.checked;
    updateDirtyBadge();
  });

  $("#e-status").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-draft]");
    if (!btn) return;
    p.draft = btn.dataset.draft === "true";
    $$("#e-status button").forEach((b) => b.classList.toggle("is-on", b === btn));
    updateDirtyBadge();
  });

  const coverInput = $("#e-cover");
  coverInput.addEventListener("input", (e) => {
    p.cover = e.target.value.trim();
    updateCoverPreview();
    updateDirtyBadge();
  });

  function updateCoverPreview() {
    const box = $("#e-cover-img");
    if (!box) return;
    if (p.cover) {
      if (box.tagName === "IMG") box.src = p.cover;
      else {
        const img = document.createElement("img");
        img.className = "cover-thumb";
        img.id = "e-cover-img";
        img.src = p.cover;
        img.alt = "";
        box.replaceWith(img);
      }
    } else if (box.tagName === "IMG") {
      const div = document.createElement("div");
      div.className = "cover-empty";
      div.id = "e-cover-img";
      div.innerHTML = `${icon("image")}还没有封面`;
      box.replaceWith(div);
    }
  }

  $("#md-toolbar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-md]");
    if (!btn) return;
    mdAction(btn.dataset.md, ta, { refresh, sync, btn });
  });

  $("#pane-seg")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pane]");
    if (!btn) return;
    S.pane = btn.dataset.pane;
    renderTab();
  });

  // 上传封面 / 正文插图
  $("#cover-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const path = await uploadImage(file, "#cover-progress");
      if (path) {
        p.cover = path;
        coverInput.value = path;
        updateCoverPreview();
        updateDirtyBadge();
      }
    }
    e.target.value = "";
  });

  $("#inline-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const path = await uploadImage(file, "#md-toolbar");
      if (path) {
        insertAtCursor(ta, `\n![图片说明](${path})\n`);
        sync();
        refresh();
      }
    }
    e.target.value = "";
  });
}

/* 行内字色：{rose|文字} / {#e5849e|文字} */
const COLOR_PALETTE = [
  { id: "rose", name: "粉", hex: "#e5849e" },
  { id: "violet", name: "紫", hex: "#b9a4e3" },
  { id: "mint", name: "绿", hex: "#6cc3a9" },
  { id: "sky", name: "蓝", hex: "#6f9fe0" },
  { id: "amber", name: "黄", hex: "#d9a441" },
  { id: "cherry", name: "红", hex: "#d9687c" },
  { id: "gray", name: "灰", hex: "#8d8496" },
  { id: "ink", name: "墨", hex: "#40394a" },
];

function wrapSelection(ta, before, after, placeholder) {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || placeholder || "";
  ta.setRangeText(before + sel + after, s, e, "end");
  ta.selectionStart = s + before.length;
  ta.selectionEnd = s + before.length + sel.length;
  ta.focus();
}

let colorPopEl = null;
let colorPopCleanup = null;

function closeColorPicker() {
  if (colorPopCleanup) {
    colorPopCleanup();
    colorPopCleanup = null;
  }
  if (colorPopEl) {
    colorPopEl.remove();
    colorPopEl = null;
  }
}

function openColorPicker(btn, ta, { refresh, sync }) {
  closeColorPicker();
  if (!btn) return;

  const pop = document.createElement("div");
  pop.className = "color-pop";
  pop.innerHTML = `
    <div class="color-pop-title">文字颜色</div>
    <div class="color-pop-row">
      ${COLOR_PALETTE.map(
        (c) =>
          `<button type="button" class="color-dot" data-color="${c.id}" title="${c.name}" style="--c:${c.hex}"></button>`
      ).join("")}
    </div>
    <div class="color-pop-foot">
      <label class="color-custom-inline">
        <input type="color" id="color-custom" value="#e5849e" />
        <span>自定义</span>
      </label>
      <button type="button" class="color-clear" data-color-clear="1">去掉颜色</button>
    </div>`;

  document.body.appendChild(pop);
  const rect = btn.getBoundingClientRect();
  const width = pop.offsetWidth || 240;
  pop.style.top = `${Math.round(rect.bottom + 8)}px`;
  pop.style.left = `${Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)))}px`;
  colorPopEl = pop;

  const apply = (token) => {
    wrapSelection(ta, `{${token}|`, "}", "文字");
    sync();
    refresh();
    closeColorPicker();
  };

  pop.addEventListener("click", (e) => {
    e.stopPropagation();
    const dot = e.target.closest("[data-color]");
    if (dot) return apply(dot.dataset.color);
    if (e.target.closest("[data-color-clear]")) {
      stripColor(ta);
      sync();
      refresh();
      return closeColorPicker();
    }
  });

  pop.querySelector("#color-custom")?.addEventListener("change", (e) => {
    const hex = String(e.target.value || "").toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(hex)) apply(hex);
  });

  const onDocClick = (e) => {
    if (pop.contains(e.target) || btn.contains(e.target)) return;
    closeColorPicker();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeColorPicker();
  };
  // 稍微延后绑定，避免当前这次点击立刻把它关掉
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }, 0);

  colorPopCleanup = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
}

/* 把选区最外层的 {token|...} 去掉 */
function stripColor(ta) {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  const m = /^\{[#a-zA-Z0-9]{2,12}\|([\s\S]*)\}$/.exec(sel);
  if (!m) {
    toast("先选中整段带颜色的文字（包括 { }）");
    return;
  }
  ta.setRangeText(m[1], s, e, "end");
  ta.focus();
}

/* 正文里插入音乐卡片 */
function openMusicPicker(ta, { refresh, sync }) {
  const ensure = ensureMusic();
  const songs = musicSongs(S.site);

  const layer = document.createElement("div");
  layer.className = "modal-layer";
  layer.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="width:min(460px,100%)">
      <h3>插入音乐</h3>
      <p>选一首已经添加的歌，或者直接粘贴网易云链接。</p>
      ${
        songs.length
          ? `<div class="pick-list">${songs
              .map(
                (s) =>
                  `<button class="pick" data-pick="${escapeHtml(s.id)}"><b>${escapeHtml(
                    s.name || "未命名"
                  )}</b><span>${escapeHtml(s.artist || "")}</span></button>`
              )
              .join("")}</div>`
          : `<p class="hint">还没有添加歌曲，可以先在「音乐」里加，或者直接粘贴链接。</p>`
      }
      <div class="input-group" style="margin-top:12px">
        <input class="input" id="pick-input" placeholder="粘贴歌曲链接或 ID" />
      </div>
      <div class="modal-acts">
        <button class="btn btn-ghost" data-x="cancel">取消</button>
        <button class="btn btn-primary" data-x="ok">插入</button>
      </div>
    </div>`;

  const close = () => {
    layer.classList.add("out");
    setTimeout(() => layer.remove(), 180);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  const insert = (id) => {
    if (!id) return toast("没认出歌曲 ID，粘贴完整链接试试", "err");
    insertAtCursor(ta, `\n{{music:${id}}}\n`);
    sync();
    refresh();
    close();
    toast("已插入，保存后正文里就会出现这张卡片");
  };

  layer.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === layer) return close();
    const pick = e.target.closest("[data-pick]");
    if (pick) return insert(pick.dataset.pick);
    const act = e.target.closest("[data-x]")?.dataset.x;
    if (act === "cancel") return close();
    if (act === "ok") return insert(parseSongId($("#pick-input")?.value || ""));
  });

  document.addEventListener("keydown", onKey);
  document.body.appendChild(layer);
  requestAnimationFrame(() => layer.classList.add("in"));
  layer.querySelector("#pick-input")?.focus();
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  ta.setRangeText(text, s, e, "end");
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function mdAction(action, ta, { refresh, sync, btn }) {
  const wrap = (before, after, ph) => {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || ph || "";
    ta.setRangeText(before + sel + after, s, e, "end");
    ta.selectionStart = s + before.length;
    ta.selectionEnd = s + before.length + sel.length;
    ta.focus();
    sync();
    refresh();
  };

  const prefix = (pre) => {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
    let lineEnd = ta.value.indexOf("\n", e);
    if (lineEnd === -1) lineEnd = ta.value.length;
    const block = ta.value.slice(lineStart, lineEnd);
    const out = block
      .split("\n")
      .map((l) => (l.trim() ? pre + l : l))
      .join("\n");
    ta.setRangeText(out, lineStart, lineEnd, "end");
    ta.focus();
    sync();
    refresh();
  };

  switch (action) {
    case "h2":
      return prefix("## ");
    case "h3":
      return prefix("### ");
    case "bold":
      return wrap("**", "**", "加粗文字");
    case "italic":
      return wrap("*", "*", "斜体文字");
    case "del":
      return wrap("~~", "~~", "删除线");
    case "ul":
      return prefix("- ");
    case "quote":
      return prefix("> ");
    case "code":
      return wrap("\n```js\n", "\n```\n", "console.log('hi')");
    case "hr":
      return insertAtCursor(ta, "\n---\n");
    case "link":
      return wrap("[", "](https://example.com)", "链接文字");
    case "image":
      return $("#inline-file")?.click();
    case "music":
      return openMusicPicker(ta, { refresh, sync });
    case "color":
      return openColorPicker(btn, ta, { refresh, sync });
    case "preview-toggle":
      refresh();
      return toast("预览已刷新");
    default:
      return null;
  }
}

/* ================================================================ 图片上传 */

async function uploadImage(file, progressSel) {
  if (S.mode === "local" ? !S.backend : !S.gh) {
    toast(S.mode === "local" ? "本地服务没有连上" : "还没有连接仓库", "err");
    return "";
  }
  if (!file.type.startsWith("image/")) {
    toast("请选择图片文件", "err");
    return "";
  }
  if (file.size > 12 * 1024 * 1024) {
    toast("图片太大了（上限 12MB）", "err");
    return "";
  }

  const bar = $(progressSel);
  bar?.classList.add("on");

  try {
    const bitmap = await loadImage(file);
    const maxW = 1600;
    const scale = Math.min(1, maxW / bitmap.width);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);

    let blob = await new Promise((res) => canvas.toBlob(res, "image/webp", 0.86));
    let ext = "webp";
    if (!blob) {
      blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.86));
      ext = "jpg";
    }
    if (!blob) throw new Error("图片处理失败");

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const base64 = bytesToB64(bytes);
    const base = slugify(currentPost()?.slug || currentPost()?.title || "image", "image");
    const path = `assets/uploads/${base}-${Date.now().toString(36)}.${ext}`;

    if (S.mode === "local") {
      await S.backend.putImage(path, base64);
    } else {
      await S.gh.putBinary(path, base64, `上传图片 ${path}`);
    }
    toast(`已上传（${(blob.size / 1024).toFixed(0)}KB）`);
    return path;
  } catch (e) {
    toast(e.message || "上传失败", "err");
    return "";
  } finally {
    bar?.classList.remove("on");
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这张图片读不出来"));
    };
    img.src = url;
  });
}

/* ================================================================ 外观 */

function bindAttr(path) {
  return `data-bind="${path}"`;
}

function appearanceHTML() {
  const t = S.site.theme || {};
  const preset = presetOf(t.preset);
  const currentAccent = t.accent || preset.accent;

  return `
  <div class="adm-tab">
    <div class="panel">
      <div class="panel-head">${icon("palette")}<h2>主题预设</h2></div>
      <p class="panel-desc">挑一个喜欢的基调，细节可以在下面继续调。</p>
      <div class="presets">
        ${PRESETS.map(
          (p) => `
          <button class="preset ${t.preset === p.id ? "is-on" : ""}" data-act="preset" data-preset="${p.id}">
            <div class="dots">
              <i style="background:${p.accent}"></i>
              <i style="background:${p.accent2}"></i>
              <i style="background:${p.accent3}"></i>
            </div>
            <b>${p.name}</b>
            <span>${p.desc}</span>
          </button>`
        ).join("")}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("star")}<h2>点缀色</h2></div>
      <p class="panel-desc">换一个颜色，按钮、链接、花瓣都会跟着变。</p>
      <div class="swatches">
        <button class="swatch ${!t.accent ? "is-on" : ""}" data-act="accent" data-color="" style="background:linear-gradient(135deg,${preset.accent},${preset.accent2})" title="跟随预设"></button>
        ${PRESETS.map(
          (p) => `<button class="swatch ${t.accent === p.accent ? "is-on" : ""}" data-act="accent" data-color="${p.accent}" style="background:${p.accent}" title="${p.name}"></button>`
        ).join("")}
        <span class="color-custom">
          <input type="color" id="accent-custom" value="${currentAccent}" />
          <span class="hint" style="margin:0">自定义</span>
        </span>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("doc")}<h2>排版</h2></div>
      <div class="grid2">
        <div class="field">
          <label>字体</label>
          <div class="seg" id="font-seg">
            ${FONTS.map((f) => `<button data-font="${f.id}" class="${(t.font || "rounded") === f.id ? "is-on" : ""}" title="${f.desc}">${f.name}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <label>圆角 <span class="hint" style="display:inline">${Number(t.radius ?? 20)}px</span></label>
          <input type="range" min="0" max="34" step="2" id="radius-range" value="${Number(t.radius ?? 20)}" />
        </div>
      </div>
      <div class="grid2">
        <div class="field">
          <label>首页每页文章数</label>
          <input class="input" type="number" min="3" max="24" ${bindAttr("theme.postsPerPage")} value="${Number(t.postsPerPage || 9)}" />
        </div>
        <div class="field">
          <label>默认明暗</label>
          <select class="select" ${bindAttr("theme.mode")}>
            ${MODES.map((m) => `<option value="${m.id}" ${(t.mode || "auto") === m.id ? "selected" : ""}>${m.name}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("heart")}<h2>小效果</h2></div>
      <div class="grid2">
        <label class="switch" style="padding:6px 0">
          <input type="checkbox" ${bindAttr("theme.petals")} ${t.petals !== false ? "checked" : ""} />
          <span class="track"></span>
          <span class="txt">飘落的花瓣</span>
        </label>
        <label class="switch" style="padding:6px 0">
          <input type="checkbox" ${bindAttr("theme.heroArt")} ${t.heroArt !== false ? "checked" : ""} />
          <span class="track"></span>
          <span class="txt">首页小猫插画</span>
        </label>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("eye")}<h2>实时预览</h2></div>
      <p class="panel-desc">下面是首页卡片的真实样式，改完立刻就能看到。</p>
      <div class="preview-frame" id="preview-frame">
        <div class="preview-note">${icon("info")}预览使用当前草稿主题，保存后才会对访客生效</div>
        ${previewCardsHTML(S.posts)}
      </div>
    </div>
  </div>`;
}

function wireAppearance() {
  const t = S.site.theme || (S.site.theme = {});

  const refreshPreview = debounce(() => {
    const frame = $("#preview-frame");
    if (frame) {
      frame.innerHTML = `<div class="preview-note">${icon("info")}预览使用当前草稿主题，保存后才会对访客生效</div>${previewCardsHTML(S.posts)}`;
    }
  }, 260);

  $("#adm-body").addEventListener("click", (e) => {
    const presetBtn = e.target.closest('[data-act="preset"]');
    if (presetBtn) {
      t.preset = presetBtn.dataset.preset;
      t.accent = "";
      applyDraftTheme();
      $$(".preset").forEach((b) => b.classList.toggle("is-on", b.dataset.preset === t.preset));
      $$(".swatch").forEach((b) => {
        b.classList.toggle("is-on", b.dataset.color === "");
        if (b.dataset.color === "") {
          const p = presetOf(t.preset);
          b.style.background = `linear-gradient(135deg, ${p.accent}, ${p.accent2})`;
        }
      });
      const picker = $("#accent-custom");
      if (picker) picker.value = presetOf(t.preset).accent;
      updateDirtyBadge();
      refreshPreview();
      return;
    }

    const accentBtn = e.target.closest('[data-act="accent"]');
    if (accentBtn) {
      t.accent = accentBtn.dataset.color || "";
      applyDraftTheme();
      $$(".swatch").forEach((b) => b.classList.toggle("is-on", b === accentBtn));
      const picker = $("#accent-custom");
      if (picker) picker.value = t.accent || presetOf(t.preset).accent;
      updateDirtyBadge();
      refreshPreview();
      return;
    }

    const fontBtn = e.target.closest("[data-font]");
    if (fontBtn) {
      t.font = fontBtn.dataset.font;
      applyDraftTheme();
      $$("[data-font]").forEach((b) => b.classList.toggle("is-on", b === fontBtn));
      updateDirtyBadge();
      return;
    }
  });

  $("#radius-range")?.addEventListener("input", (e) => {
    t.radius = Number(e.target.value);
    e.target.closest(".field").querySelector(".hint").textContent = `${t.radius}px`;
    applyDraftTheme();
    updateDirtyBadge();
  });

  $("#accent-custom")?.addEventListener("input", (e) => {
    t.accent = e.target.value;
    applyDraftTheme();
    $$(".swatch").forEach((b) => b.classList.toggle("is-on", b.dataset.color === t.accent));
    updateDirtyBadge();
    refreshPreview();
  });

  $$('#adm-body input[type="checkbox"][data-bind]').forEach((el) => {
    el.addEventListener("change", () => {
      applyDraftTheme();
      updateDirtyBadge();
    });
  });

  $$('#adm-body [data-bind="theme.postsPerPage"]').forEach((el) => {
    el.addEventListener("input", () => {
      S.site.theme.postsPerPage = clamp(Number(el.value) || 9, 3, 24);
      updateDirtyBadge();
      refreshPreview();
    });
  });
}

/* ================================================================ 站点 */

function siteHTML() {
  const s = S.site.site || {};
  const nav = Array.isArray(S.site.nav) ? S.site.nav : [];
  const social = Array.isArray(S.site.social) ? S.site.social : [];

  return `
  <div class="adm-tab">
    <div class="panel">
      <div class="panel-head">${icon("home")}<h2>基本信息</h2></div>
      <p class="panel-desc">这些会出现在顶栏、首页和页脚。</p>
      <div class="grid2">
        <div class="field"><label>站点名称</label><input class="input" ${bindAttr("site.title")} value="${escapeHtml(s.title || "")}" /></div>
        <div class="field"><label>一句话副标题</label><input class="input" ${bindAttr("site.subtitle")} value="${escapeHtml(s.subtitle || "")}" /></div>
        <div class="field"><label>作者名</label><input class="input" ${bindAttr("site.author")} value="${escapeHtml(s.author || "")}" /></div>
        <div class="field"><label>起始年份</label><input class="input" ${bindAttr("site.since")} value="${escapeHtml(s.since || "")}" /></div>
      </div>
      <div class="field"><label>头像地址</label><input class="input" ${bindAttr("site.avatar")} value="${escapeHtml(s.avatar || "")}" placeholder="assets/img/avatar.svg" /></div>
      <div class="field"><label>首页签名</label><textarea class="textarea" rows="2" ${bindAttr("site.bio")}>${escapeHtml(s.bio || "")}</textarea></div>
      <div class="field"><label>站点描述（给搜索引擎看的）</label><textarea class="textarea" rows="2" ${bindAttr("site.description")}>${escapeHtml(s.description || "")}</textarea></div>
      <div class="field"><label>页脚文字</label><input class="input" ${bindAttr("site.footer")} value="${escapeHtml(s.footer || "")}" /></div>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("heart")}<h2>关于页面</h2></div>
      <p class="panel-desc">支持 Markdown。会显示在「关于」这个页面里。</p>
      <textarea class="textarea mono" rows="12" ${bindAttr("about")}>${escapeHtml(S.site.about || "")}</textarea>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("link")}<h2>导航菜单</h2></div>
      <p class="panel-desc">每行一个链接。<code>/</code> 是首页，<code>/archive</code> 归档，<code>/tags</code> 标签，<code>/about</code> 关于。</p>
      <div class="repeater" id="nav-repeater">
        ${nav
          .map(
            (item, i) => `
          <div class="repeater-row two" data-i="${i}">
            <input class="input" data-nav="label" value="${escapeHtml(item.label || "")}" placeholder="显示文字" />
            <input class="input" data-nav="to" value="${escapeHtml(item.to || "")}" placeholder="/archive" />
            <button class="mini danger" data-act="nav-del" data-i="${i}" title="删除">${icon("trash")}</button>
          </div>`
          )
          .join("")}
      </div>
      <button class="btn btn-line btn-sm" data-act="nav-add" style="margin-top:10px">${icon("plus")} 加一项</button>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("external")}<h2>社交链接</h2></div>
      <p class="panel-desc">会出现在「关于」页和页脚。图标可选 github / mail / link / rss。</p>
      <div class="repeater" id="social-repeater">
        ${social
          .map(
            (item, i) => `
          <div class="repeater-row" data-i="${i}">
            <input class="input" data-social="label" value="${escapeHtml(item.label || "")}" placeholder="GitHub" />
            <input class="input" data-social="url" value="${escapeHtml(item.url || "")}" placeholder="https://github.com/you" />
            <button class="mini danger" data-act="social-del" data-i="${i}" title="删除">${icon("trash")}</button>
          </div>`
          )
          .join("")}
      </div>
      <button class="btn btn-line btn-sm" data-act="social-add" style="margin-top:10px">${icon("plus")} 加一项</button>
    </div>
  </div>`;
}

function wireSite() {
  const navRep = $("#nav-repeater");
  const socialRep = $("#social-repeater");

  navRep?.addEventListener("input", (e) => {
    const row = e.target.closest("[data-i]");
    const key = e.target.dataset.nav;
    if (!row || !key) return;
    const item = S.site.nav[Number(row.dataset.i)];
    if (item) item[key] = e.target.value;
    updateDirtyBadge();
  });

  socialRep?.addEventListener("input", (e) => {
    const row = e.target.closest("[data-i]");
    const key = e.target.dataset.social;
    if (!row || !key) return;
    const item = S.site.social[Number(row.dataset.i)];
    if (item) item[key] = e.target.value;
    updateDirtyBadge();
  });
}

/* ================================================================ 音乐 */

function ensureMusic() {
  if (!S.site.music || typeof S.site.music !== "object") S.site.music = {};
  const m = S.site.music;
  if (!Array.isArray(m.songs)) m.songs = [];
  if (typeof m.enabled !== "boolean") m.enabled = false;
  if (typeof m.title !== "string") m.title = "最近在听";
  if (typeof m.desc !== "string") m.desc = "";
  if (typeof m.playlistId !== "string") m.playlistId = "";
  return m;
}

function parseSongId(value) {
  const s = String(value || "").trim();
  const m = s.match(/[?&]id=(\d+)/) || s.match(/\/(\d{4,})(?:[/?#]|$)/) || s.match(/^(\d{4,})$/);
  return m ? m[1] : "";
}

function songRowHTML(song, i) {
  return `
  <div class="song-edit" data-i="${i}">
    <div class="song-edit-top">
      <input class="input" data-song="id" value="${escapeHtml(song.id || "")}" placeholder="歌曲 ID" style="max-width:118px" />
      <input class="input" data-song="name" value="${escapeHtml(song.name || "")}" placeholder="歌名" />
      <input class="input" data-song="artist" value="${escapeHtml(song.artist || "")}" placeholder="歌手" />
      <button class="mini danger" data-act="song-del" data-i="${i}" title="删除">${icon("trash")}</button>
    </div>
    <input class="input" data-song="cover" value="${escapeHtml(song.cover || "")}" placeholder="封面图片地址（可选，留空用渐变色）" style="margin-top:8px" />
  </div>`;
}

function musicHTML() {
  const m = ensureMusic();
  const songs = m.songs;

  return `
  <div class="adm-tab">
    <div class="panel">
      <div class="panel-head">${icon("music")}<h2>音乐卡片</h2></div>
      <p class="panel-desc">
        用网易云音乐官方外链播放器。填歌曲 ID 或直接粘贴分享链接都行；封面不填会用主题色渐变占位。
      </p>
      <div class="grid2">
        <div class="field"><label>标题</label><input class="input" data-bind="music.title" value="${escapeHtml(m.title)}" placeholder="最近在听" /></div>
        <div class="field"><label>歌单 ID（可选）</label><input class="input" data-bind="music.playlistId" value="${escapeHtml(m.playlistId)}" placeholder="填了会在音乐页顶部显示整张歌单" /></div>
      </div>
      <div class="field"><label>描述</label><input class="input" data-bind="music.desc" value="${escapeHtml(m.desc)}" placeholder="一些最近在循环的歌" /></div>
      <div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">
        <label class="switch">
          <input type="checkbox" data-bind="music.enabled" ${m.enabled ? "checked" : ""} />
          <span class="track"></span><span class="txt">在首页显示音乐卡片</span>
        </label>
        <label class="switch">
          <input type="checkbox" data-bind="music.embed" ${m.embed !== false ? "checked" : ""} />
          <span class="track"></span><span class="txt">显示歌单播放器</span>
        </label>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("plus")}<h2>歌曲</h2></div>
      <p class="panel-desc">
        在网易云里点「分享 → 复制链接」，形如 <code>https://music.163.com/song?id=1234567</code>，整段粘进来就会自动取出 ID。
      </p>
      <div class="input-group" style="margin-bottom:14px">
        <input class="input" id="song-add" placeholder="粘贴歌曲链接或数字 ID，回车添加" />
        <button class="btn btn-soft btn-sm" data-act="song-add">${icon("plus")} 添加</button>
      </div>
      <div class="repeater" id="song-repeater">
        ${
          songs.length
            ? songs.map(songRowHTML).join("")
            : `<div class="adm-empty" style="padding:26px"><b>还没有歌曲</b><span>把分享链接粘到上面就行</span></div>`
        }
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("eye")}<h2>预览</h2></div>
      <p class="panel-desc">前台卡片的真实样式；播放器要保存之后到前台才会加载。</p>
      <div class="preview-frame" id="music-preview">
        ${
          musicSongs(S.site).length
            ? `<div class="music-grid">${musicSongs(S.site).map(musicCardHTML).join("")}</div>`
            : `<div class="empty" style="padding:30px"><b>加一首歌试试</b><span>卡片会显示歌名、歌手和一个播放按钮</span></div>`
        }
      </div>
    </div>
  </div>`;
}

function refreshMusicPreview() {
  const box = $("#music-preview");
  if (!box) return;
  const songs = musicSongs(S.site);
  box.innerHTML = songs.length
    ? `<div class="music-grid">${songs.map(musicCardHTML).join("")}</div>`
    : `<div class="empty" style="padding:30px"><b>加一首歌试试</b><span>卡片会显示歌名、歌手和一个播放按钮</span></div>`;
}

function addSong(raw) {
  const m = ensureMusic();
  const id = parseSongId(raw);
  if (!id) return toast("没认出歌曲 ID，粘贴完整链接试试", "err");
  if (m.songs.some((s) => String(s.id) === id)) return toast("这首歌已经在列表里了");
  m.songs.push({ id, name: "", artist: "", cover: "" });
  if (!m.enabled) m.enabled = true;
  updateDirtyBadge();
  renderTab();
  toast("已添加，记得填上歌名和歌手");
}

function wireMusic() {
  const addInput = $("#song-add");
  addInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addSong(addInput.value);
  });

  const rep = $("#song-repeater");
  if (!rep) return;

  const refreshSoon = debounce(refreshMusicPreview, 220);

  rep.addEventListener("input", (e) => {
    const key = e.target.dataset?.song;
    const row = e.target.closest("[data-i]");
    if (!key || !row) return;
    const song = S.site.music.songs[Number(row.dataset.i)];
    if (!song) return;

    if (key === "id") {
      const id = parseSongId(e.target.value) || e.target.value.trim();
      song.id = id;
    } else {
      song[key] = e.target.value;
    }
    updateDirtyBadge();
    refreshSoon();
  });

  // 失焦时把粘贴的整段链接收成纯 ID
  rep.addEventListener(
    "blur",
    (e) => {
      if (e.target.dataset?.song !== "id") return;
      const row = e.target.closest("[data-i]");
      const id = parseSongId(e.target.value);
      if (id && id !== e.target.value) {
        e.target.value = id;
        const song = S.site.music.songs[Number(row.dataset.i)];
        if (song) song.id = id;
        refreshSoon();
      }
    },
    true
  );
}

/* ================================================================ 安全 */

function securityHTML() {
  const cfg = repoConfig();
  const auth = S.site?.admin?.auth || {};
  const isLocal = S.mode === "local";

  return `
  <div class="adm-tab">
    <div class="panel">
      <div class="panel-head">${icon("key")}<h2>修改管理员密码</h2></div>
      <p class="panel-desc">
        当前密码以 PBKDF2-SHA256（${Number(auth.iterations || 600000).toLocaleString("zh-CN")} 次迭代）派生后保存在
        <code>content/site.json</code>，仓库里没有明文。${
          isLocal ? "在这里改完并提交后，网页版用的也是同一个密码。" : ""
        }
      </p>
      <form id="pw-form">
        <div class="field" style="max-width:480px"><label>当前密码</label><input class="input" type="password" id="pw-old" autocomplete="current-password" /></div>
        <div class="grid2">
          <div class="field"><label>新密码</label><input class="input" type="password" id="pw-new" autocomplete="new-password" /></div>
          <div class="field"><label>再输一次新密码</label><input class="input" type="password" id="pw-new2" autocomplete="new-password" /></div>
        </div>
        <div class="field" style="max-width:480px">
          <div class="pw-meter"><i id="pw-meter-bar"></i></div>
          <div class="pw-hint"><span id="pw-strength">至少 ${MIN_LENGTH} 位</span><span></span></div>
        </div>
        <button class="btn btn-primary btn-sm" type="submit">${icon("shield")} 更新密码</button>
      </form>
    </div>

    ${
      isLocal
        ? `<div class="panel">
             <div class="panel-head">${icon("home")}<h2>本地模式</h2></div>
             <p class="panel-desc">
               直接读写本目录下的 <code>content/site.json</code> 和 <code>content/posts.json</code>，
               不经过 GitHub，也不需要令牌。改动攒起来，点右上角「提交」合成一个 commit。
             </p>
             <div class="link-list">
               <div class="link-row">${icon("github")}<span>仓库 <b>${escapeHtml(cfg.owner || "?")}/${escapeHtml(
                   cfg.name || "?"
                 )}</b> · 分支 ${escapeHtml(cfg.branch || "main")}</span></div>
               <div class="link-row">${icon("key")}<span>密码与网页版共用 <code>content/site.json</code> 里的同一份哈希</span></div>
               <div class="link-row">${icon("lock")}<span>推送使用本机 git 凭据，不额外保存任何密钥</span></div>
             </div>
           </div>`
        : `<div class="panel">
             <div class="panel-head">${icon("github")}<h2>仓库连接</h2></div>
             <p class="panel-desc">改仓库以后，需要重新验证一次令牌。</p>
             <div class="grid3">
               <div class="field"><label>用户名</label><input class="input" id="repo-owner" value="${escapeHtml(cfg.owner)}" /></div>
               <div class="field"><label>仓库名</label><input class="input" id="repo-name" value="${escapeHtml(cfg.name)}" /></div>
               <div class="field"><label>分支</label><input class="input" id="repo-branch" value="${escapeHtml(cfg.branch)}" /></div>
             </div>
             <div class="field">
               <label>访问令牌</label>
               <div class="input-group">
                 <input class="input" type="password" id="repo-token" placeholder="留空表示继续用本机已保存的令牌" autocomplete="off" />
                 <button class="btn btn-line btn-sm" data-act="test-repo">${icon("refresh")} 测试</button>
               </div>
               <span class="hint">令牌只保存在这台设备。换设备时重新输入即可，仓库里不会有它。</span>
             </div>
             <button class="btn btn-soft btn-sm" data-act="save-repo">${icon("save")} 保存仓库信息</button>
           </div>`
    }

    <div class="panel">
      <div class="panel-head">${icon("lock")}<h2>本机数据</h2></div>
      <p class="panel-desc">${
        isLocal ? "本地版不保存令牌，这里只清理浏览器的主题缓存。" : "清除令牌后，下次进入需要重新输入令牌（密码仍然有效）。"
      }</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${isLocal ? "" : `<button class="btn btn-line btn-sm" data-act="clear-token">${icon("trash")} 清除本机令牌</button>`}
        <button class="btn btn-line btn-sm" data-act="clear-theme">${icon("refresh")} 清除主题缓存</button>
        <button class="btn btn-line btn-sm" data-act="logout">${icon("logout")} 退出控制台</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">${icon("info")}<h2>忘记密码怎么办</h2></div>
      <div class="notice warn" style="margin-bottom:0">
        ${icon("alert")}
        <div>
          密码无法找回，只能重置：把 <code>content/site.json</code> 里的
          <code>"auth": { … }</code> 整段改成 <code>null</code>${
            isLocal ? "（本地版直接改文件即可）" : `并提交`
          }，然后重新打开控制台，就会重新进入初始化流程。
        </div>
      </div>
    </div>
  </div>`;
}

function wireSecurity() {
  const newPw = $("#pw-new");
  newPw?.addEventListener("input", () => {
    const st = strength(newPw.value);
    const bar = $("#pw-meter-bar");
    if (bar) {
      bar.style.width = `${[8, 38, 70, 100][st.level]}%`;
      bar.style.background = ["#c4566f", "#e0b34a", "#7fc9a8", "var(--accent)"][st.level];
    }
    const label = $("#pw-strength");
    if (label) label.textContent = newPw.value ? `${st.label} · ${st.hint}` : `至少 ${MIN_LENGTH} 位`;
  });

  $("#pw-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const oldPw = $("#pw-old").value;
    const a = $("#pw-new").value;
    const b = $("#pw-new2").value;

    if (a.length < MIN_LENGTH) return toast(`新密码至少 ${MIN_LENGTH} 位`, "err");
    if (a !== b) return toast("两次输入的新密码不一样", "err");

    const ok = await verifyPassword(oldPw, S.site.admin.auth);
    if (!ok) return toast("当前密码不对", "err");

    const btn = e.target.querySelector('button[type="submit"]');
    btn.classList.add("is-busy");
    btn.innerHTML = `${icon("refresh")} 计算中…`;
    S.site.admin.auth = await makeAuth(a);
    btn.classList.remove("is-busy");
    btn.innerHTML = `${icon("shield")} 更新密码`;

    e.target.reset();
    updateDirtyBadge();
    toast("新密码已准备好，记得点右上角「保存并发布」");
  });
}

/* ================================================================ 保存 */

function postFileText(post) {
  const { path: _omit, ...rest } = post;
  return JSON.stringify({ version: 2, ...rest, updatedAt: new Date().toISOString() }, null, 2) + "\n";
}

function indexFileText() {
  return JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), posts: S.posts }, null, 2) + "\n";
}

/* 把编辑器里的文章同步进索引（保存前调用） */
function syncEditingMeta() {
  const p = S.editing;
  if (!p) return;
  p.slug = slugify(p.slug || p.title || p.id, "post");
  const meta = toMeta(p);
  const i = S.posts.findIndex((m) => m.id === p.id);
  if (i >= 0) S.posts[i] = meta;
  else S.posts.unshift(meta);
}

function commitMessage() {
  const p = S.editing;
  if (p && (editingDirty() || postPath(p) !== S.editingPath)) {
    return `${S.editingPath ? (p.draft ? "保存草稿" : "更新文章") : "新建文章"}：${p.title || "无标题"}`;
  }
  if (postsDirty() || S.deleted.length) return "更新文章";
  if (siteDirty()) return "更新站点设置";
  return "更新内容";
}

async function saveAll() {
  if (S.busy) return;

  syncEditingMeta();

  const files = [];
  if (siteDirty()) {
    S.site.updatedAt = new Date().toISOString();
    files.push({ path: REPO_FILE, text: JSON.stringify(S.site, null, 2) + "\n" });
  }
  if (postsDirty()) files.push({ path: INDEX_FILE, text: indexFileText() });

  if (S.editing) {
    const path = postPath(S.editing);
    const moved = Boolean(S.editingPath) && S.editingPath !== path;
    if (editingDirty() || moved) {
      files.push({ path, text: postFileText(S.editing) });
      if (moved) files.push({ path: S.editingPath, delete: true });
    }
  }
  for (const p of S.deleted) files.push({ path: p, delete: true });

  if (!files.length) {
    toast("没有需要保存的修改");
    return;
  }

  const message = commitMessage();
  S.busy = true;
  const saveBtn = $('[data-act="save"]');
  const old = saveBtn?.innerHTML;
  saveBtn?.classList.add("is-busy");
  if (saveBtn) saveBtn.innerHTML = `${icon("refresh")} ${S.mode === "local" ? "写入中…" : "提交中…"}`;

  try {
    const res = await saveRemote(files, message);

    S.baseSite = JSON.stringify(S.site);
    S.basePosts = JSON.stringify(S.posts);
    if (S.editing) {
      S.editingBase = JSON.stringify(S.editing);
      S.editingPath = postPath(S.editing);
    }
    S.deleted = [];
    updateDirtyBadge();

    if (S.mode === "local") {
      await refreshGitBadge();
      toast(`已写入 ${res?.files || files.length} 个文件，点「提交」生成一次 commit`);
    } else {
      S.ctx.reload?.();
      toast(`已提交（${files.length} 个文件），30–60 秒后生效`);
      if (S.tab === "content" && S.editingId) {
        S.editingId = null;
        S.editing = null;
        S.editingPath = "";
        renderTab();
      }
    }
  } catch (e) {
    toast(e?.message || "提交失败", "err");
    console.error(e);
  } finally {
    S.busy = false;
    saveBtn?.classList.remove("is-busy");
    if (saveBtn && old) saveBtn.innerHTML = old;
  }
}

async function refreshGitBadge() {
  if (S.mode !== "local" || !S.backend) return;
  try {
    const info = await S.backend.git();
    const btn = $('[data-act="commit"]');
    const badge = $(".git-n");
    const n = info.changes?.length || 0;
    if (badge) badge.textContent = n ? ` · ${n}` : "";
    if (btn) btn.classList.toggle("has-changes", n > 0);
  } catch {}
}

function defaultCommitMessage(files) {
  const paths = files.map((f) => f.path);
  const onlyPosts = paths.every((p) => p.startsWith(POSTS_DIR + "/"));
  const onlySite = paths.every((p) => p === REPO_FILE);
  if (onlyPosts) return "更新文章";
  if (onlySite) return "更新站点设置";
  return "更新站点与文章";
}

async function openCommitDialog() {
  if (S.mode !== "local" || S.busy) return;
  if (isDirty()) {
    toast("还有改动没保存到本地，先点「保存到本地」");
    return;
  }

  let info = { changes: [], branch: "" };
  try {
    info = await S.backend.git();
  } catch (e) {
    toast(e?.message || "读取 git 状态失败", "err");
    return;
  }
  const files = info.changes || [];
  if (!files.length) {
    toast("没有需要提交的改动");
    return;
  }

  const layer = document.createElement("div");
  layer.className = "modal-layer";
  layer.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="width:min(540px,100%)">
      <h3>提交到本地仓库</h3>
      <p>下面 ${files.length} 个文件的改动会合并成 <b>一个</b> commit${info.branch ? `（分支 ${escapeHtml(info.branch)}）` : ""}。</p>
      <div class="commit-files">
        ${files
          .slice(0, 24)
          .map(
            (f) =>
              `<div class="commit-row"><span class="commit-code">${escapeHtml(f.code || "M")}</span><span>${escapeHtml(
                f.path
              )}</span></div>`
          )
          .join("")}
        ${files.length > 24 ? `<div class="commit-row more">…还有 ${files.length - 24} 个</div>` : ""}
      </div>
      <div class="field" style="margin-top:14px">
        <label for="commit-msg">提交信息</label>
        <input class="input" id="commit-msg" value="${escapeHtml(defaultCommitMessage(files))}" />
      </div>
      <label class="switch">
        <input type="checkbox" id="commit-push" />
        <span class="track"></span><span class="txt">提交后顺便推送到 GitHub（用本机 git 凭据）</span>
      </label>
      <div class="modal-acts">
        <button class="btn btn-ghost" data-x="cancel">取消</button>
        <button class="btn btn-primary" data-x="ok">提交</button>
      </div>
    </div>`;

  const close = () => {
    layer.classList.add("out");
    setTimeout(() => layer.remove(), 180);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) layer.querySelector('[data-x="ok"]')?.click();
  };

  layer.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (e.target === layer) return close();
    const act = e.target.closest("[data-x]")?.dataset.x;
    if (act === "cancel") return close();
    if (act !== "ok") return;

    const msg = $("#commit-msg").value.trim() || "更新站点内容";
    const push = $("#commit-push").checked;
    const btn = layer.querySelector('[data-x="ok"]');
    btn.classList.add("is-busy");
    btn.textContent = "提交中…";

    try {
      const res = await S.backend.commit(msg, push);
      close();
      toast(`已提交 ${res.sha}（${res.files} 个文件）`, "ok", 3600);
      if (push && !res.pushed) {
        setTimeout(() => toast(`提交成功，但推送失败：${res.pushError || "可以在终端手动 git push"}`, "err", 6000), 500);
      }
      await refreshGitBadge();
      S.ctx.reload?.();
    } catch (err) {
      toast(err?.message || "提交失败", "err", 5000);
      btn.classList.remove("is-busy");
      btn.textContent = "提交";
    }
  });

  document.addEventListener("keydown", onKey);
  document.body.appendChild(layer);
  requestAnimationFrame(() => layer.classList.add("in"));
  layer.querySelector("#commit-msg").select();
}

/* ================================================================ 全局事件 */

function bindGlobalEvents() {
  const signal = S.ac.signal;

  document.addEventListener(
    "click",
    (e) => {
      const tabBtn = e.target.closest("[data-tab]");
      if (tabBtn && S.root.contains(tabBtn)) {
        setTab(tabBtn.dataset.tab);
        return;
      }

      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;

      switch (act) {
        case "save":
          saveAll();
          break;
        case "commit":
          openCommitDialog();
          break;
        case "reload":
          reloadFromRepo();
          break;
        case "preview-mode": {
          const cur = document.documentElement.dataset.mode;
          S.previewMode = cur === "dark" ? "light" : "dark";
          applyDraftTheme();
          const btn = e.target.closest('[data-act="preview-mode"]');
          if (btn) btn.innerHTML = icon(S.previewMode === "dark" ? "sun" : "moon");
          break;
        }
        case "exit":
          S.ctx.exit?.();
          break;
        case "new-post": {
          const p = {
            id: uid("p"),
            slug: "",
            title: "",
            date: todayISO(),
            tags: [],
            cover: "",
            excerpt: "",
            pinned: false,
            draft: true,
            body: "",
          };
          S.editing = p;
          S.editingBase = JSON.stringify(p);
          S.editingPath = "";
          S.editingId = p.id;
          S.pane = window.innerWidth > 1100 ? "split" : "edit";
          renderTab();
          setTimeout(() => $("#e-title")?.focus(), 60);
          break;
        }
        case "edit":
          openEditor(e.target.closest("[data-id]")?.dataset.id);
          break;
        case "back-list":
          if (editingDirty()) {
            confirmDialog({
              title: "还没保存",
              message: "回到列表会丢掉这篇的修改，确定吗？",
              okText: "丢掉",
              danger: true,
            }).then((ok) => {
              if (!ok) return;
              revertDrafts();
              renderTab();
            });
          } else {
            S.editingId = null;
            S.editing = null;
            S.editingPath = "";
            renderTab();
          }
          break;
        case "save-post":
          saveAll();
          break;
        case "del": {
          const id = e.target.closest("[data-id]")?.dataset.id;
          const p = S.posts.find((x) => x.id === id);
          if (!p) break;
          confirmDialog({
            title: "删除这篇文章？",
            message: `「${p.title || "无标题"}」会从仓库里删掉（包括 ${p.path || "对应的文件"}），历史提交里还能找回来。`,
            okText: "删除",
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            S.posts = S.posts.filter((x) => x.id !== id);
            if (p.path) S.deleted.push(p.path);
            updateDirtyBadge();
            await saveAll();
            renderTab();
          });
          break;
        }
        case "pin": {
          const id = e.target.closest("[data-id]")?.dataset.id;
          const p = S.posts.find((x) => x.id === id);
          if (!p) break;
          p.pinned = !p.pinned;
          updateDirtyBadge();
          renderTab();
          break;
        }
        case "pick-cover":
          $("#cover-file")?.click();
          break;
        case "clear-cover": {
          const p = currentPost();
          if (p) {
            p.cover = "";
            updateDirtyBadge();
            renderTab();
          }
          break;
        }
        case "nav-add":
          S.site.nav = Array.isArray(S.site.nav) ? S.site.nav : [];
          S.site.nav.push({ label: "新链接", to: "/" });
          updateDirtyBadge();
          renderTab();
          break;
        case "nav-del":
          S.site.nav.splice(Number(e.target.closest("[data-i]").dataset.i), 1);
          updateDirtyBadge();
          renderTab();
          break;
        case "social-add":
          S.site.social = Array.isArray(S.site.social) ? S.site.social : [];
          S.site.social.push({ label: "", url: "", icon: "link" });
          updateDirtyBadge();
          renderTab();
          break;
        case "social-del":
          S.site.social.splice(Number(e.target.closest("[data-i]").dataset.i), 1);
          updateDirtyBadge();
          renderTab();
          break;
        case "song-add":
          addSong($("#song-add")?.value || "");
          break;
        case "song-del": {
          const idx = Number(e.target.closest("[data-i]")?.dataset.i);
          if (Number.isInteger(idx)) {
            ensureMusic();
            S.site.music.songs.splice(idx, 1);
            updateDirtyBadge();
            renderTab();
          }
          break;
        }
        case "test-repo":
          testRepo();
          break;
        case "save-repo":
          saveRepo();
          break;
        case "clear-token":
          store.remove(TOKEN_KEY);
          toast("已清除本机令牌");
          break;
        case "clear-theme":
          store.remove("blog.boot");
          store.remove("blog.mode");
          toast("已清除主题缓存");
          break;
        case "logout":
          S.ctx.exit?.();
          break;
        default:
          break;
      }
    },
    { signal }
  );

  // 通用数据绑定
  document.addEventListener(
    "input",
    (e) => {
      const el = e.target.closest("[data-bind]");
      if (!el || !S.root.contains(el)) return;
      const path = el.dataset.bind;
      let value = el.type === "checkbox" ? el.checked : el.value;
      if (el.type === "number") value = Number(el.value);
      setPath(S.site, path, value);
      updateDirtyBadge();
      if (path.startsWith("theme.") || path === "site.avatar") applyDraftTheme();
      if (path === "site.title" || path === "site.avatar") {
        const b = $(".adm-brand b");
        if (b && path === "site.title") b.textContent = value || "我的小站";
        const img = $(".adm-brand img");
        if (img && path === "site.avatar") img.src = value || "assets/img/avatar.svg";
      }
    },
    { signal }
  );

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target.closest("[data-bind]");
      if (!el || !S.root.contains(el)) return;
      if (el.type !== "checkbox") return;
      setPath(S.site, el.dataset.bind, el.checked);
      updateDirtyBadge();
      if (el.dataset.bind.startsWith("theme.")) applyDraftTheme();
    },
    { signal }
  );

  // 列表搜索
  document.addEventListener(
    "input",
    debounce((e) => {
      if (e.target?.id !== "list-q") return;
      S.listQuery = e.target.value;
      const body = $("#adm-body");
      if (body && !S.editingId && S.tab === "content") {
        // 只重绘列表，保持输入焦点
        const scroll = window.scrollY;
        const pos = e.target.selectionStart;
        renderTab();
        const q = $("#list-q");
        if (q) {
          q.focus();
          q.setSelectionRange(pos, pos);
        }
        window.scrollTo(0, scroll);
      }
    }, 200),
    { signal }
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (!S.root.contains(document.activeElement) && document.activeElement === document.body) return;
        e.preventDefault();
        saveAll();
      }
      if (e.key === "Escape" && S.editingId && !document.querySelector(".modal-layer")) {
        const act = document.querySelector('[data-act="back-list"]');
        act?.click();
      }
    },
    { signal }
  );

  window.addEventListener(
    "beforeunload",
    (e) => {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    },
    { signal }
  );
}

async function reloadFromRepo() {
  const isLocal = S.mode === "local";
  if (isDirty()) {
    const ok = await confirmDialog({
      title: isLocal ? "重新读取会丢掉修改" : "重新读取会丢掉修改",
      message: isLocal ? "磁盘上的内容会覆盖当前未保存的修改，确定吗？" : "仓库里的内容会覆盖当前未保存的修改，确定吗？",
      okText: "重新读取",
      danger: true,
    });
    if (!ok) return;
  }
  if (isLocal) {
    await startLocal();
    toast("已从磁盘重新读取");
    return;
  }
  await startApp();
  toast("已从仓库重新读取");
}

async function testRepo() {
  const owner = $("#repo-owner").value.trim();
  const name = $("#repo-name").value.trim();
  const branch = $("#repo-branch").value.trim() || "main";
  const token = $("#repo-token").value.trim() || store.get(TOKEN_KEY, "");
  if (!owner || !name) return toast("先填用户名和仓库名", "err");
  if (!token) return toast("需要一个令牌", "err");

  const btn = $('[data-act="test-repo"]');
  btn?.classList.add("is-busy");
  try {
    const gh = new GitHub({ token, owner, repo: name, branch });
    const info = await gh.check();
    if (!info.canPush) throw new Error("令牌只能读、不能写：请把 Contents 权限改成 Read and write 后重新生成");
    toast(`连接正常：${info.fullName}`);
  } catch (e) {
    toast(e.message || "连接失败", "err");
  } finally {
    btn?.classList.remove("is-busy");
  }
}

async function saveRepo() {
  const owner = $("#repo-owner").value.trim();
  const name = $("#repo-name").value.trim();
  const branch = $("#repo-branch").value.trim() || "main";
  const token = $("#repo-token").value.trim() || store.get(TOKEN_KEY, "");
  if (!owner || !name) return toast("先填用户名和仓库名", "err");
  if (!token) return toast("需要一个令牌", "err");

  try {
    const gh = new GitHub({ token, owner, repo: name, branch });
    const info = await gh.check();
    if (!info.canPush) throw new Error("令牌只能读、不能写：请把 Contents 权限改成 Read and write 后重新生成");
    S.site.admin = S.site.admin || {};
    S.site.admin.repo = { owner, name, branch };
    store.set(TOKEN_KEY, token);
    S.gh = gh;
    S.sha = {};
    updateDirtyBadge();
    toast("仓库已切换，记得保存并发布");
    renderShell();
  } catch (e) {
    toast(e.message || "保存失败", "err");
  }
}
