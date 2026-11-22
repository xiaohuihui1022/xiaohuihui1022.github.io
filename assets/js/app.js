/* 站点入口：取数、路由、交互 */

import { $, $$, escapeHtml, icon, toast, store, debounce, copyText, fmtDot } from "./core.js";
import { applyTheme, toggleMode, PRESETS } from "./theme.js";
import { renderMarkdown, extractToc } from "./markdown.js";
import {
  applyChrome,
  setActiveNav,
  updateModeIcon,
  homeHTML,
  postHTML,
  archiveHTML,
  tagsHTML,
  tagHTML,
  aboutHTML,
  musicPageHTML,
  hydrateMusic,
  gamesPageHTML,
  gamePageHTML,
  gameBySlug,
  missingHTML,
  published,
  orderedPosts,
  allTags,
  postUrl,
} from "./views.js";

const APP = $("#app");

const state = {
  site: null,
  posts: [],
  route: { name: "home", path: "/" },
  mode: "light",
  admin: null,
  adminMounted: false,
};

/* ------------------------------------------------------------ 数据 */

async function fetchJSON(path, bust = false) {
  const url = bust ? `${path}?t=${Date.now()}` : path;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function normalize(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const posts = Array.isArray(data.posts) ? data.posts : [];
  return {
    site: data.site || {},
    theme: data.theme || {},
    nav: Array.isArray(data.nav) ? data.nav : [],
    social: Array.isArray(data.social) ? data.social : [],
    about: data.about || "",
    admin: data.admin || {},
    version: data.version || 1,
    updatedAt: data.updatedAt || "",
  };
}

function normalizeSitePayload(raw) {
  // site.json 的顶层就是站点配置；把 admin 单独拎出来
  const data = raw && typeof raw === "object" ? raw : {};
  return data;
}

async function loadContent({ bust = false } = {}) {
  const [siteRaw, postsRaw] = await Promise.all([
    fetchJSON("content/site.json", bust),
    fetchJSON("content/posts.json", bust),
  ]);
  state.siteRaw = siteRaw || {};
  state.site = normalizeSitePayload(siteRaw);
  state.posts = Array.isArray(postsRaw.posts) ? postsRaw.posts : [];
  state.postsRaw = postsRaw || { posts: [] };
}

/* ------------------------------------------------------------ 路由 */

function parseRoute() {
  const rawHash = location.hash.replace(/^#/, "");
  const decoded = decodeURIComponent(rawHash || "/");
  const [pathPart, queryPart] = decoded.split("?");
  const params = new URLSearchParams(queryPart || "");
  const seg = pathPart.split("/").filter(Boolean);
  const page = Math.max(1, Number(params.get("page")) || 1);

  if (!seg.length) return { name: "home", path: "/", page };
  const [a, b] = seg;
  if (a === "post" && b) return { name: "post", path: `/${a}/${b}`, slug: b };
  if (a === "tag" && b) return { name: "tag", path: `/${a}`, tag: b };
  if (a === "archive") return { name: "archive", path: "/archive" };
  if (a === "tags") return { name: "tags", path: "/tags" };
  if (a === "about") return { name: "about", path: "/about" };
  if (a === "music") return { name: "music", path: "/music" };
  if (a === "games") return { name: "games", path: "/games" };
  if (a === "game" && b) return { name: "game", path: "/games", slug: b };
  if (a === "admin") return { name: "admin", path: "/admin" };
  return { name: "missing", path: `/${a}` };
}

function go(hash, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
  if (replace) render();
}

/* ------------------------------------------------------------ 渲染 */

function viewHTML() {
  const { site, posts, route } = state;
  switch (route.name) {
    case "home":
      return homeHTML({ site, posts, page: route.page });
    case "post": {
      const post = posts.find((p) => (p.slug || p.id) === route.slug);
      if (!post || post.draft) return missingHTML({ what: "文章" });
      return postHTML({ site, posts, post });
    }
    case "archive":
      return archiveHTML({ site, posts });
    case "tags":
      return tagsHTML({ site, posts });
    case "tag":
      return tagHTML({ site, posts, tag: route.tag });
    case "about":
      return aboutHTML({ site });
    case "music":
      return musicPageHTML({ site });
    case "games":
      return gamesPageHTML();
    case "game":
      return gamePageHTML(route.slug);
    default:
      return missingHTML({ what: "页面" });
  }
}

function render({ scroll = true } = {}) {
  if (state.adminMounted) return;
  const { site, route } = state;
  APP.innerHTML = viewHTML();

  setActiveNav(route);
  document.body.classList.remove("is-locked");
  // 游戏页用沉浸式布局：藏掉页脚，让 iframe 尽量占满
  document.body.classList.toggle("is-immersive", route.name === "game");

  const s = site.site || {};
  const baseTitle = s.title || "我的小站";
  if (route.name === "post") {
    const post = state.posts.find((p) => (p.slug || p.id) === route.slug);
    document.title = post ? `${post.title} · ${baseTitle}` : `找不到文章 · ${baseTitle}`;
    const desc = document.querySelector('meta[name="description"]');
    if (desc && post) desc.setAttribute("content", post.excerpt || String(post.body || "").slice(0, 120));
  } else if (route.name === "home") {
    document.title = baseTitle;
  } else if (route.name === "game") {
    const g = gameBySlug(route.slug);
    document.title = `${g ? g.title : "游戏"} · ${baseTitle}`;
  } else {
    document.title = `${baseTitle} · ${
      route.name === "archive"
        ? "归档"
        : route.name === "tags"
        ? "标签"
        : route.name === "about"
        ? "关于"
        : route.name === "music"
        ? "音乐"
        : route.name === "games"
        ? "游戏"
        : route.name === "tag"
        ? route.tag
        : "页面"
    }`;
  }

  afterRender();
  if (scroll) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

function afterRender() {
  hydrateMusic(APP, state.site);
  wireCodeCopy();
  wireImageFallback();
  buildToc();
  updateReadProgress();
}

/* 正文图片加载失败时给个明确提示，而不是一个碎图标 */
function wireImageFallback() {
  if (STATE_IMG_BOUND) return;
  STATE_IMG_BOUND = true;
  APP.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (!img.closest(".prose")) return;
      if (img.dataset.fallback) return;
      img.dataset.fallback = "1";

      const src = img.getAttribute("src") || "";
      const box = document.createElement("div");
      box.className = "img-fail";
      box.innerHTML = `<span>图片没能加载（图床可能禁止了跨站引用）</span>${
        src ? `<a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">在新标签打开</a>` : ""
      }`;
      // 图片常常被包在 <a> 里（[![图](src)](页面)），整个换掉，避免 <a> 套 <a>
      const target = img.closest("a") || img;
      target.replaceWith(box);
    },
    true
  );
}
let STATE_IMG_BOUND = false;

/* ------------------------------------------------------------ 代码块复制 */

function wireCodeCopy() {
  $$("#app pre").forEach((pre) => {
    if (pre.querySelector(".copy-code")) return;
    const btn = document.createElement("button");
    btn.className = "copy-code";
    btn.type = "button";
    btn.innerHTML = `${icon("copy")}<span>复制</span>`;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const code = pre.querySelector("code");
      const ok = await copyText(code ? code.textContent : pre.textContent);
      btn.innerHTML = ok ? `${icon("check")}<span>已复制</span>` : `${icon("alert")}<span>失败</span>`;
      setTimeout(() => (btn.innerHTML = `${icon("copy")}<span>复制</span>`), 1600);
    });
    pre.appendChild(btn);
  });
}

/* ------------------------------------------------------------ 目录 */

let tocObserver = null;

function buildToc() {
  const toc = $("#toc");
  const prose = $("#prose");
  if (tocObserver) {
    tocObserver.disconnect();
    tocObserver = null;
  }
  if (!toc || !prose) return;

  const items = extractToc(prose);
  if (items.length < 2) {
    toc.remove();
    return;
  }

  toc.innerHTML = `<div class="toc-title">目录</div>${items
    .map(
      (it) =>
        `<a href="#${encodeURIComponent(it.id)}" class="lv${it.level}" data-id="${escapeHtml(it.id)}">${escapeHtml(it.text)}</a>`
    )
    .join("")}`;

  toc.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    const el = document.getElementById(a.dataset.id);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 96;
      window.scrollTo({ top, behavior: "smooth" });
      history.replaceState(null, "", `${location.hash.split("#")[0] || ""}`);
    }
  });

  const heads = items.map((it) => document.getElementById(it.id)).filter(Boolean);
  const links = new Map($$("a", toc).map((a) => [a.dataset.id, a]));
  let current = null;

  tocObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      const target = visible[0]?.target || null;
      if (!target || target.id === current) return;
      current = target.id;
      links.forEach((a, id) => a.classList.toggle("is-on", id === current));
      const active = links.get(current);
      if (active) {
        // 只滚动目录本身。用 scrollIntoView 会连带把整个页面滚走
        // （目录是 fixed 定位，但布局位置在文档流里），滚到底部时表现为「被拽回顶部」
        const box = toc.getBoundingClientRect();
        const ab = active.getBoundingClientRect();
        if (ab.top < box.top + 20) {
          toc.scrollTop -= box.top + 20 - ab.top;
        } else if (ab.bottom > box.bottom - 20) {
          toc.scrollTop += ab.bottom - (box.bottom - 20);
        }
      }
    },
    { rootMargin: "-96px 0px -65% 0px", threshold: 0 }
  );
  heads.forEach((h) => tocObserver.observe(h));
}

/* ------------------------------------------------------------ 阅读进度 */

function updateReadProgress() {
  const bar = $("#read-bar");
  if (!bar) return;
  const onPost = state.route.name === "post";
  bar.classList.toggle("is-on", onPost);
  if (!onPost) {
    bar.querySelector("i").style.width = "0%";
    return;
  }
  const doc = document.documentElement;
  const max = doc.scrollHeight - window.innerHeight;
  const pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
  bar.querySelector("i").style.width = `${pct}%`;
}

/* ------------------------------------------------------------ 回到顶部 */

let toTopBtn = null;
function initToTop() {
  toTopBtn = document.createElement("button");
  toTopBtn.className = "to-top";
  toTopBtn.setAttribute("aria-label", "回到顶部");
  toTopBtn.innerHTML = icon("arrow-up");
  toTopBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  document.body.appendChild(toTopBtn);
}

/* ------------------------------------------------------------ 搜索 */

const search = {
  open: false,
  index: [],
  cursor: 0,
  results: [],

  build() {
    this.index = published(state.posts).map((p) => ({
      slug: p.slug || p.id,
      title: p.title || "",
      tags: (p.tags || []).join(" "),
      body: String(p.body || ""),
      cover: p.cover || "",
      date: p.date || "",
      haystack: `${p.title || ""} ${(p.tags || []).join(" ")} ${p.excerpt || ""} ${String(p.body || "")}`.toLowerCase(),
    }));
  },

  show() {
    const layer = $("#search-layer");
    if (!layer) return;
    layer.hidden = false;
    document.body.classList.add("is-locked");
    this.open = true;
    this.build();
    const input = $("#search-input");
    input.value = "";
    this.query("");
    setTimeout(() => input.focus(), 30);
  },

  hide() {
    const layer = $("#search-layer");
    if (!layer) return;
    layer.hidden = true;
    document.body.classList.remove("is-locked");
    this.open = false;
  },

  query(q) {
    const kw = String(q || "").trim().toLowerCase();
    const results = $("#search-results");
    const hint = $("#search-hint");
    const terms = kw.split(/\s+/).filter(Boolean);

    if (!terms.length) {
      this.results = orderedPosts(state.posts).slice(0, 6).map((p) => ({
        slug: p.slug || p.id,
        title: p.title,
        tags: (p.tags || []).join(" · "),
        cover: p.cover,
        date: p.date,
        score: 0,
      }));
      hint.textContent = "最近发布";
    } else {
      const scored = this.index
        .map((it) => {
          let score = 0;
          for (const t of terms) {
            if (it.title.toLowerCase().includes(t)) score += 10;
            if (it.tags.toLowerCase().includes(t)) score += 6;
            if (it.haystack.includes(t)) score += 2;
          }
          return { ...it, score };
        })
        .filter((it) => it.score > 0)
        .sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
      this.results = scored.slice(0, 20);
      hint.textContent = scored.length ? `找到 ${scored.length} 篇` : "";
    }

    this.cursor = 0;
    if (!this.results.length) {
      results.innerHTML = `<div class="search-empty">没有找到「${escapeHtml(q)}」，换个词试试？</div>`;
      return;
    }

    results.innerHTML = this.results
      .map((r, i) => {
        const title = terms.length ? highlight(r.title, terms) : escapeHtml(r.title);
        return `<a class="sr${i === 0 ? " is-on" : ""}" href="#/post/${encodeURIComponent(r.slug)}" data-i="${i}">
          ${r.cover ? `<img class="sr-thumb" src="${escapeHtml(r.cover)}" alt="" loading="lazy" />` : `<span class="sr-thumb"></span>`}
          <span class="sr-main">
            <span class="sr-t">${title}</span>
            <span class="sr-d"><span>${fmtDot(r.date)}</span>${r.tags ? `<span>${escapeHtml(r.tags)}</span>` : ""}</span>
          </span>
        </a>`;
      })
      .join("");
  },

  move(delta) {
    if (!this.results.length) return;
    this.cursor = (this.cursor + delta + this.results.length) % this.results.length;
    $$("#search-results .sr").forEach((el, i) => el.classList.toggle("is-on", i === this.cursor));
    const active = $$("#search-results .sr")[this.cursor];
    if (active) active.scrollIntoView({ block: "nearest" });
  },

  enter() {
    const pick = this.results[this.cursor];
    if (!pick) return;
    this.hide();
    location.hash = `#/post/${encodeURIComponent(pick.slug)}`;
  },
};

function highlight(text, terms) {
  let out = escapeHtml(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }
  return out;
}

function initSearch() {
  const layer = $("#search-layer");
  const input = $("#search-input");
  if (!layer || !input) return;

  const close = () => search.hide();
  layer.addEventListener("click", (e) => {
    if (e.target === layer) close();
  });
  $("#search-results").addEventListener("click", () => close());

  input.addEventListener("input", debounce((e) => search.query(e.target.value), 90));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      search.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      search.move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      search.enter();
    } else if (e.key === "Escape") {
      close();
    }
  });

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      search.open ? close() : search.show();
      return;
    }
    if (e.key === "Escape" && search.open) close();
    if (e.key === "/" && !typing && !search.open && !state.adminMounted) {
      e.preventDefault();
      search.show();
    }
  });
}

/* ------------------------------------------------------------ 花瓣 */

function initPetals() {
  const canvas = $("#petals");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    canvas.style.display = "none";
    return;
  }

  let W = 0;
  let H = 0;
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  let petals = [];
  let raf = 0;
  let running = false;

  const count = () => (W < 640 ? 7 : W < 1100 ? 11 : 15);

  function make() {
    return {
      x: Math.random() * W,
      y: Math.random() * H - H,
      r: 3 + Math.random() * 4.5,
      vy: 12 + Math.random() * 22,
      vx: -6 + Math.random() * 12,
      rot: Math.random() * Math.PI * 2,
      vr: (-0.4 + Math.random() * 0.8) * 0.5,
      sway: Math.random() * Math.PI * 2,
      alpha: 0.16 + Math.random() * 0.24,
      hue: Math.random() < 0.75 ? 0 : 1,
    };
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = count();
    if (petals.length > n) petals.length = n;
    while (petals.length < n) {
      const p = make();
      p.y = Math.random() * H;
      petals.push(p);
    }
  }

  function color(hue) {
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue(hue ? "--accent-2" : "--accent").trim() || "#e5849e";
    return accent;
  }

  function draw(ts) {
    if (!running) return;
    const dt = Math.min(48, ts - (draw.last || ts)) / 1000;
    draw.last = ts;
    ctx.clearRect(0, 0, W, H);
    const c1 = color(0);
    const c2 = color(1);

    for (const p of petals) {
      p.y += p.vy * dt;
      p.sway += dt * 1.1;
      p.x += (p.vx + Math.sin(p.sway) * 10) * dt;
      p.rot += p.vr * dt;

      if (p.y > H + 20 || p.x < -40 || p.x > W + 40) {
        Object.assign(p, make(), { y: -10, x: Math.random() * W });
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.hue ? c2 : c1;
      ctx.beginPath();
      // 樱花瓣：两段弧拼出的水滴形
      ctx.moveTo(0, -p.r);
      ctx.bezierCurveTo(p.r * 1.1, -p.r * 0.4, p.r * 0.8, p.r * 0.9, 0, p.r);
      ctx.bezierCurveTo(-p.r * 0.8, p.r * 0.9, -p.r * 1.1, -p.r * 0.4, 0, -p.r);
      ctx.fill();
      ctx.restore();
    }
    raf = requestAnimationFrame(draw);
  }

  function start() {
    if (running || document.documentElement.classList.contains("no-petals")) return;
    running = true;
    draw.last = 0;
    raf = requestAnimationFrame(draw);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, W, H);
  }

  resize();
  window.addEventListener("resize", debounce(resize, 200));
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  start();

  state.petals = { start, stop, resize };
}

/* ------------------------------------------------------------ 音乐播放 */

function stopSong(host) {
  if (!host) return;
  host.innerHTML = "";
  delete host.dataset.current;
}

function playSong(btn) {
  const id = btn.dataset.play;
  if (!id) return;
  const card = btn.closest(".song");
  const host = card?.querySelector(".song-player") || $("#music-player");
  if (!host) return;

  // 再点一次同一首 = 停止
  if (host.dataset.current === id) {
    stopSong(host);
    card?.classList.remove("is-playing");
    btn.innerHTML = icon("play");
    return;
  }

  // 同一时间只放一首：把其它卡片和顶部播放器清掉
  $$(".song").forEach((el) => {
    el.classList.remove("is-playing");
    const b = el.querySelector("[data-play]");
    if (b) b.innerHTML = icon("play");
    const h = el.querySelector(".song-player");
    if (h && h !== host) stopSong(h);
  });
  const top = $("#music-player");
  if (top && top !== host) stopSong(top);

  host.dataset.current = id;
  host.innerHTML = `<iframe class="music-frame" title="网易云音乐播放器" src="https://music.163.com/outchain/player?type=2&id=${encodeURIComponent(
    id
  )}&auto=1&height=66" height="66" frameborder="no" loading="lazy" allow="autoplay"></iframe>`;
  card?.classList.add("is-playing");
  btn.innerHTML = icon("pause");
}

/* ------------------------------------------------------------ 顶栏交互 */

function initChromeEvents() {
  document.addEventListener("click", (e) => {
    const searchBtn = e.target.closest("#btn-search");
    if (searchBtn) {
      search.show();
      return;
    }

    const playBtn = e.target.closest("[data-play]");
    if (playBtn) {
      e.preventDefault();
      playSong(playBtn);
      return;
    }

    const modeBtn = e.target.closest("#btn-mode");
    if (modeBtn) {
      const next = toggleMode(state.site?.theme || {});
      updateModeIcon(next);
      const p = state.site?.theme?.petals !== false;
      if (p) next === "dark" ? state.petals?.stop() : state.petals?.start();
      return;
    }

    const menuBtn = e.target.closest("#btn-menu");
    if (menuBtn) {
      const nav = $("#nav");
      const open = nav?.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }

    if (e.target.closest(".nav a")) {
      $("#nav")?.classList.remove("open");
      $("#btn-menu")?.setAttribute("aria-expanded", "false");
      return;
    }

    if (!e.target.closest(".nav")) {
      $("#nav")?.classList.remove("open");
      $("#btn-menu")?.setAttribute("aria-expanded", "false");
    }
  });

  window.addEventListener("scroll", () => {
    updateReadProgress();
    if (toTopBtn) toTopBtn.classList.toggle("is-on", window.scrollY > 500);
  }, { passive: true });
}

/* ------------------------------------------------------------ 分页 */

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".pager [data-page]");
  if (!btn || btn.disabled) return;
  const page = Number(btn.dataset.page);
  if (!page || page < 1) return;
  const target = page === 1 ? "#/" : `#/?page=${page}`;
  location.hash = target;
});

/* ------------------------------------------------------------ 启动 */

function bootError(err) {
  console.error(err);
  APP.innerHTML = `
    <div class="empty" style="margin-top:14vh">
      <b>内容没有加载出来</b>
      <span>可能是网络问题，或者 content/*.json 还没准备好。<br />
      <a href="javascript:location.reload()" style="color:var(--accent-text)">重新加载</a></span>
    </div>`;
}

async function enterAdmin() {
  APP.innerHTML = `<div class="boot"><span class="boot-dot"></span><p>正在打开控制台…</p></div>`;
  try {
    const mod = await import("./admin.js");
    state.admin = mod;
    const ctx = {
      sitePayload: state.siteRaw,
      postsPayload: state.postsRaw,
      reload: async () => {
        await loadContent({ bust: true });
        // 面板打开时不要用「已部署的旧配置」覆盖面板里的草稿主题
        if (!state.adminMounted) {
          applyTheme(state.site.theme);
          applyChrome(state.site, { mode: document.documentElement.dataset.mode });
        }
      },
      exit: async () => {
        document.body.classList.remove("admin-on");
        state.adminMounted = false;
        APP.removeAttribute("style");
        await loadContent({ bust: true });
        applyTheme(state.site.theme);
        applyChrome(state.site, { mode: document.documentElement.dataset.mode });
        state.route = parseRoute();
        render();
      },
    };
    document.body.classList.add("admin-on");
    await mod.mount(APP, ctx);
    state.adminMounted = true;
  } catch (err) {
    console.error(err);
    document.body.classList.remove("admin-on");
    toast(`控制台打不开：${err.message || err}`, "err");
    location.hash = "#/";
  }
}

function leaveAdmin() {
  if (state.admin && state.admin.unmount) state.admin.unmount();
  state.adminMounted = false;
  document.body.classList.remove("admin-on");
  APP.removeAttribute("style");
}

async function router() {
  const next = parseRoute();
  const wasAdmin = state.adminMounted || state.route.name === "admin";
  state.route = next;

  if (next.name === "admin") {
    if (!state.adminMounted) await enterAdmin();
    return;
  }
  if (wasAdmin) leaveAdmin();

  render();
}

async function boot() {
  try {
    await loadContent();
  } catch (err) {
    bootError(err);
    return;
  }

  state.mode = applyTheme(state.site.theme || {});
  applyChrome(state.site, { mode: state.mode });
  initSearch();
  initToTop();
  initChromeEvents();
  initPetals();

  window.addEventListener("hashchange", router);
  window.addEventListener("pageshow", () => {
    if (state.route.name === "post") updateReadProgress();
  });

  await router();

  // 系统主题变化时，如果用户没有手动覆盖，则跟随
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const theme = state.site?.theme || {};
    if (theme.mode && theme.mode !== "auto") return;
    if (store.get("blog.mode", null)) return;
    applyTheme(theme);
    updateModeIcon(document.documentElement.dataset.mode);
  });
}

boot();
