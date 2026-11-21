/* 页面渲染：把 site / posts 变成 HTML 片段 */

import {
  escapeHtml,
  safeUrl,
  icon,
  fmtDot,
  fmtCn,
  relTime,
  readingTime,
  truncate,
  slugify,
} from "./core.js";
import { renderMarkdown } from "./markdown.js";

/* ------------------------------------------------------------ 选择与排序 */

export function published(posts = []) {
  return posts.filter((p) => p && !p.draft);
}

export function byDateDesc(a, b) {
  return String(b.date || "").localeCompare(String(a.date || ""));
}

export function orderedPosts(posts = []) {
  const list = published(posts).slice().sort(byDateDesc);
  return [...list.filter((p) => p.pinned), ...list.filter((p) => !p.pinned)];
}

export function allTags(posts = []) {
  const map = new Map();
  for (const post of published(posts)) {
    for (const tag of post.tags || []) {
      const t = String(tag).trim();
      if (!t) continue;
      map.set(t, (map.get(t) || 0) + 1);
    }
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

export function postUrl(post) {
  return `#/post/${encodeURIComponent(post.slug || post.id)}`;
}
export function tagUrl(tag) {
  return `#/tag/${encodeURIComponent(tag)}`;
}

/* ------------------------------------------------------------ 小组件 */

export function chips(tags = [], limit = 3) {
  const list = (tags || []).filter(Boolean).slice(0, limit);
  if (!list.length) return "";
  return `<div class="chips">${list
    .map((t) => `<a class="chip" href="${tagUrl(t)}">${escapeHtml(t)}</a>`)
    .join("")}</div>`;
}

function coverImg(src, alt, cls = "") {
  const url = safeUrl(src, "");
  if (!url) return "";
  return `<img src="${url}" alt="${escapeHtml(alt || "")}" loading="lazy" decoding="async"${cls ? ` class="${cls}"` : ""} />`;
}

export function cardHTML(post) {
  const excerpt = post.excerpt ? String(post.excerpt) : truncate(post.body, 96);
  return `
  <article class="card">
    ${
      post.cover
        ? `<div class="card-cover">${coverImg(post.cover, post.title)}</div>`
        : `<div class="card-cover cover-blank" aria-hidden="true"></div>`
    }
    <div class="card-body">
      <div class="card-meta">
        <span>${fmtDot(post.date)}</span>
        <i class="sep"></i>
        <span>${readingTime(post.body || "")} 分钟</span>
        ${post.pinned ? `<i class="sep"></i><span class="pin">${icon("star")}置顶</span>` : ""}
      </div>
      <h3 class="card-title"><a class="card-link" href="${postUrl(post)}">${escapeHtml(post.title || "无标题")}</a></h3>
      ${excerpt ? `<p class="card-excerpt">${escapeHtml(excerpt)}</p>` : ""}
      <div class="card-foot">${chips(post.tags, 3)}</div>
    </div>
  </article>`;
}

export function featuredHTML(post) {
  const excerpt = post.excerpt ? String(post.excerpt) : truncate(post.body, 150);
  return `
  <article class="featured">
    <div class="featured-body">
      <div class="card-meta">
        <span class="eyebrow">置顶推荐</span>
      </div>
      <h2 class="card-title" style="font-size:clamp(22px,2.6vw,30px);-webkit-line-clamp:3">
        <a class="card-link" href="${postUrl(post)}">${escapeHtml(post.title || "无标题")}</a>
      </h2>
      ${excerpt ? `<p class="card-excerpt" style="-webkit-line-clamp:3;font-size:14.5px;line-height:1.9">${escapeHtml(excerpt)}</p>` : ""}
      <div class="card-meta" style="margin-top:6px">
        <span>${fmtDot(post.date)}</span><i class="sep"></i><span>${readingTime(post.body || "")} 分钟</span>
      </div>
      <div class="chips" style="margin-top:14px">${(post.tags || [])
        .slice(0, 4)
        .map((t) => `<a class="chip" href="${tagUrl(t)}">${escapeHtml(t)}</a>`)
        .join("")}</div>
    </div>
    <div class="featured-cover ${post.cover ? "" : "cover-blank"}">${post.cover ? coverImg(post.cover, post.title) : ""}</div>
  </article>`;
}

function pagerHTML(page, totalPages) {
  if (totalPages <= 1) return "";
  const nums = [];
  const push = (n) => nums.push(`<button data-page="${n}" class="${n === page ? "is-on" : ""}">${n}</button>`);
  const ellipsis = `<span class="pg-gap">…</span>`;

  if (totalPages <= 7) {
    for (let n = 1; n <= totalPages; n++) push(n);
  } else {
    push(1);
    if (page > 3) nums.push(ellipsis);
    for (let n = Math.max(2, page - 1); n <= Math.min(totalPages - 1, page + 1); n++) push(n);
    if (page < totalPages - 2) nums.push(ellipsis);
    push(totalPages);
  }

  return `
  <div class="pager">
    <button data-page="${page - 1}" ${page <= 1 ? "disabled" : ""} aria-label="上一页">${icon("arrow-left")}</button>
    ${nums.join("")}
    <button data-page="${page + 1}" ${page >= totalPages ? "disabled" : ""} aria-label="下一页">${icon("arrow-right")}</button>
  </div>`;
}

/* ------------------------------------------------------------ 首页 */

export function homeHTML({ site, posts, page = 1 }) {
  const perPage = Math.max(1, Number(site.theme?.postsPerPage) || 9);
  const ordered = orderedPosts(posts);
  const pinned = ordered.filter((p) => p.pinned);
  const head = pinned[0] || ordered[0];

  // 置顶文章占据头条位，其余按分页排布
  const rest = ordered.filter((p) => p !== head);
  const totalPages = Math.max(1, Math.ceil(rest.length / perPage));
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = rest.slice((current - 1) * perPage, current * perPage);

  const tags = allTags(posts);
  const s = site.site || {};
  const last = ordered[0];

  const hero = `
  <section class="hero">
    <div class="hero-text">
      <span class="hero-badge"><span class="dot"></span>${
        last ? `最近更新 · ${relTime(last.date)}` : "刚刚开张，欢迎来坐坐"
      }</span>
      <h1>你好，我是<br /><span class="soft">${escapeHtml(s.author || s.title || "小站主人")}</span>。</h1>
      <p class="hero-desc">${escapeHtml(s.bio || s.description || s.subtitle || "在这里记录代码、生活和一些没什么用的小事。")}</p>
      <div class="hero-actions">
        ${
          head
            ? `<a class="btn btn-primary" href="${postUrl(head)}">${icon("doc")}开始阅读</a>`
            : ""
        }
        <a class="btn btn-ghost" href="#/archive">${icon("home")}全部归档</a>
      </div>
      <div class="hero-meta">
        <span><b>${published(posts).length}</b>篇文章</span>
        <span><b>${tags.length}</b>个标签</span>
        ${s.since ? `<span><b>${escapeHtml(s.since)}</b>年起写字</span>` : ""}
      </div>
    </div>
    ${
      site.theme?.heroArt === false
        ? ""
        : `<div class="hero-art"><img src="assets/img/hero-cat.svg" alt="" width="380" height="340" /></div>`
    }
  </section>`;

  const featured = head && !pinned.length ? "" : head ? `<section class="section" style="margin-top:40px">${featuredHTML(head)}</section>` : "";

  const grid = slice.length
    ? `<div class="post-grid">${slice.map(cardHTML).join("")}</div>`
    : "";

  const empty = ordered.length
    ? ""
    : `<div class="empty" style="margin-top:48px">
         <b>这里还空空的</b>
         <span>还没有发布任何文章。去 <a href="#/admin" style="color:var(--accent-text)">控制台</a> 写下第一篇吧。</span>
       </div>`;

  const list = ordered.length
    ? `<section class="section">
         <div class="section-head">
           <h2 class="section-title">${pinned.length && rest.length ? "接着写的" : "最近写的"}</h2>
           <a class="section-more" href="#/archive">按时间看全部 ${icon("arrow-right")}</a>
         </div>
         ${grid}
         ${pagerHTML(current, totalPages)}
       </section>`
    : "";

  return `<div class="view">${hero}${featured}${empty}${list}${musicSectionHTML(site)}</div>`;
}

/* ------------------------------------------------------------ 文章页 */

export function postHTML({ site, posts, post, baseUrl = "" }) {
  const body = renderMarkdown(post.body || "");
  const chars = String(post.body || "").replace(/\s/g, "").length;
  const list = published(posts).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const idx = list.findIndex((p) => p.slug === post.slug);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  const nav = `
  <nav class="post-nav">
    ${
      prev
        ? `<a class="pn prev" href="${postUrl(prev)}"><span>${icon("arrow-left")}上一篇</span><b>${escapeHtml(prev.title)}</b></a>`
        : `<span class="pn is-empty"></span>`
    }
    ${
      next
        ? `<a class="pn next" href="${postUrl(next)}"><span>下一篇${icon("arrow-right")}</span><b>${escapeHtml(next.title)}</b></a>`
        : `<span class="pn is-empty"></span>`
    }
  </nav>`;

  return `
  <div class="view">
    <article class="post">
      <div class="post-back">
        <a class="btn btn-ghost btn-sm" href="#/">${icon("arrow-left")}返回首页</a>
      </div>
      <header class="post-head">
        ${post.pinned ? `<div class="post-kicker"><span class="pin">${icon("star")}置顶</span></div>` : ""}
        <h1 class="post-title">${escapeHtml(post.title || "无标题")}</h1>
        <div class="post-meta">
          <span class="mi">${icon("calendar")}${fmtCn(post.date)}</span>
          <span class="mi">${icon("clock")}约 ${readingTime(post.body || "")} 分钟</span>
          <span class="mi">${icon("doc")}${chars.toLocaleString("zh-CN")} 字</span>
          ${(post.tags || []).length ? `<div class="chips" style="margin-left:auto">${(post.tags || [])
            .map((t) => `<a class="chip" href="${tagUrl(t)}">${escapeHtml(t)}</a>`)
            .join("")}</div>` : ""}
        </div>
      </header>
      ${post.cover ? `<div class="post-cover">${coverImg(post.cover, post.title)}</div>` : ""}
      <div class="prose" id="prose">${body}</div>
      <footer class="post-foot">
        <div class="post-tags">
          <span class="label">${icon("heart")} 谢谢你读到这里</span>
        </div>
        <a class="btn btn-ghost btn-sm" href="#/archive">${icon("home")}更多文章</a>
      </footer>
    </article>
    ${nav}
    <aside class="toc" id="toc" aria-label="目录"></aside>
  </div>`;
}

/* ------------------------------------------------------------ 归档 */

export function archiveHTML({ posts }) {
  const list = published(posts).slice().sort(byDateDesc);
  const years = new Map();
  for (const p of list) {
    const year = String(p.date || "").slice(0, 4) || "未标注";
    if (!years.has(year)) years.set(year, []);
    years.get(year).push(p);
  }

  const body = list.length
    ? Array.from(years.entries())
        .map(
          ([year, items]) => `
        <section class="year-group">
          <h2 class="year-title">${escapeHtml(year)}<span class="count">${items.length} 篇</span></h2>
          <div class="alist">
            ${items
              .map(
                (p) => `
              <a class="arow" href="${postUrl(p)}">
                <time>${escapeHtml(String(p.date).slice(5))}</time>
                <b>${escapeHtml(p.title)}</b>
                <span class="dots"></span>
                ${chips(p.tags, 2)}
              </a>`
              )
              .join("")}
          </div>
        </section>`
        )
        .join("")
    : `<div class="empty"><b>还没有文章</b><span>去控制台写下第一篇吧。</span></div>`;

  return `
  <div class="view">
    <header class="page-head" style="margin:0 auto">
      <span class="eyebrow">Archive</span>
      <h1 class="page-title">${icon("calendar", "title-i")}全部归档</h1>
      <p class="page-desc">共 ${list.length} 篇文章，按时间倒序排列。慢慢看，不着急。</p>
    </header>
    <div class="archive">${body}</div>
  </div>`;
}

/* ------------------------------------------------------------ 标签 */

export function tagsHTML({ posts }) {
  const tags = allTags(posts);
  return `
  <div class="view">
    <header class="page-head" style="margin:0 auto">
      <span class="eyebrow">Tags</span>
      <h1 class="page-title">${icon("tag", "title-i")}标签</h1>
      <p class="page-desc">${tags.length} 个标签，像书架上的一排小盒子。</p>
    </header>
    ${
      tags.length
        ? `<div class="tag-cloud">${tags
            .map(
              (t) =>
                `<a class="tag-pill" href="${tagUrl(t.name)}"><span>${escapeHtml(t.name)}</span><em>${t.count}</em></a>`
            )
            .join("")}</div>`
        : `<div class="empty" style="max-width:820px;margin:40px auto"><b>还没有标签</b><span>写文章时加上标签就会出现在这里。</span></div>`
    }
  </div>`;
}

export function tagHTML({ posts, tag }) {
  const list = published(posts)
    .filter((p) => (p.tags || []).includes(tag))
    .sort(byDateDesc);
  return `
  <div class="view">
    <header class="page-head" style="margin:0 auto">
      <span class="eyebrow">Tag</span>
      <h1 class="page-title">${icon("tag", "title-i")}${escapeHtml(tag)}</h1>
      <p class="page-desc">这个标签下有 ${list.length} 篇文章。</p>
    </header>
    <div class="post-grid" style="margin-top:36px">
      ${list.map(cardHTML).join("")}
    </div>
    <div style="text-align:center;margin-top:48px">
      <a class="btn btn-ghost btn-sm" href="#/tags">${icon("tag")}看看其它标签</a>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ 关于 */

export function aboutHTML({ site }) {
  const s = site.site || {};
  const socials = (site.social || [])
    .filter((x) => x && x.url)
    .map(
      (x) =>
        `<a class="pill" href="${safeUrl(x.url, "#")}" target="_blank" rel="noopener noreferrer">${icon(
          x.icon || "link"
        )}${escapeHtml(x.label || x.url)}</a>`
    )
    .join("");

  const fallback =
    "## 关于这个小站\n\n这里还没有写自我介绍。\n\n你可以打开 [控制台](#/admin)，在「站点」里填写这一段文字。";

  return `
  <div class="view">
    <header class="page-head" style="margin:0 auto">
      <span class="eyebrow">About</span>
      <h1 class="page-title">${icon("heart", "title-i")}关于</h1>
      <p class="page-desc">${escapeHtml(s.description || "")}</p>
    </header>
    <div style="max-width:var(--prose);margin:40px auto 0">
      <div class="prose" id="prose">${renderMarkdown(site.about || fallback)}</div>
      ${socials ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:40px;padding-top:28px;border-top:1px solid var(--line-soft)">${socials}</div>` : ""}
    </div>
  </div>`;
}

export function missingHTML({ what = "页面" } = {}) {
  return `
  <div class="view">
    <div class="empty" style="margin-top:14vh">
      <b>这个${escapeHtml(what)}走丢了</b>
      <span>可能是链接写错了，也可能已经被收起来。<br />回 <a href="#/" style="color:var(--accent-text)">首页</a> 看看吧。</span>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ 音乐 */

export function musicSongs(site) {
  const m = site?.music || {};
  return (Array.isArray(m.songs) ? m.songs : []).filter((s) => s && (s.id || s.name));
}

export function musicEnabled(site) {
  return Boolean(site?.music?.enabled) && musicSongs(site).length > 0;
}

export function musicCardHTML(song, i = 0) {
  const cover = song.cover
    ? `<img src="${safeUrl(song.cover, "")}" alt="" loading="lazy" />`
    : `<span class="song-note">♪</span>`;
  const name = escapeHtml(song.name || "未命名");
  const title = song.id
    ? `<a href="https://music.163.com/song?id=${encodeURIComponent(song.id)}" target="_blank" rel="noopener noreferrer">${name}</a>`
    : name;
  return `
  <article class="song" data-i="${i}">
    <div class="song-main">
      <div class="song-art">${cover}</div>
      <div class="song-info">
        <b>${title}</b>
        <span>${escapeHtml(song.artist || "")}</span>
      </div>
      ${
        song.id
          ? `<button class="song-play" data-play="${escapeHtml(song.id)}" aria-label="播放 ${name}">${icon("play")}</button>`
          : ""
      }
    </div>
    ${song.id ? `<div class="song-player"></div>` : ""}
  </article>`;
}

/* 把文章里的 {{music:ID}} 占位符补成真正的卡片 */
export function hydrateMusic(root, site) {
  if (!root) return;
  const songs = musicSongs(site);
  root.querySelectorAll(".music-inline[data-music]").forEach((el) => {
    if (el.dataset.ready) return;
    const id = el.dataset.music;
    const song =
      songs.find((s) => String(s.id) === String(id)) ||
      { id, name: "网易云音乐", artist: `歌曲 ${id}`, cover: "" };
    el.innerHTML = musicCardHTML(song);
    el.dataset.ready = "1";
  });
}

export function musicSectionHTML(site) {  if (!musicEnabled(site)) return "";
  const songs = musicSongs(site).slice(0, 3);
  return `
  <section class="section">
    <div class="section-head">
      <h2 class="section-title">${escapeHtml(site.music.title || "最近在听")}</h2>
      <a class="section-more" href="#/music">全部 ${icon("arrow-right")}</a>
    </div>
    <div class="music-grid">${songs.map(musicCardHTML).join("")}</div>
  </section>`;
}

export function musicPageHTML({ site }) {
  const m = site.music || {};
  const songs = musicSongs(site);
  const playlist = String(m.playlistId || "").trim();
  const title = m.title || "最近在听";

  const playlistEmbed =
    playlist && m.embed !== false
      ? `<iframe class="music-frame music-frame-list" title="网易云音乐歌单" src="https://music.163.com/outchain/player?type=0&id=${encodeURIComponent(
          playlist
        )}&auto=0&height=430" height="430" frameborder="no" loading="lazy" allow="autoplay"></iframe>`
      : "";

  const body = songs.length
    ? `<div class="music-list">${songs.map(musicCardHTML).join("")}</div>`
    : `<div class="empty"><b>还没有添加音乐</b><span>去控制台的「音乐」里加一首吧。</span></div>`;

  return `
  <div class="view">
    <header class="page-head" style="margin:0 auto">
      <span class="eyebrow">Music</span>
      <h1 class="page-title">${icon("music", "title-i")}${escapeHtml(title)}</h1>
      <p class="page-desc">${escapeHtml(m.desc || "一些最近在循环的歌。点播放可以直接在网页里听。")}</p>
    </header>
    <div class="music-page">
      <div class="music-player" id="music-player">${playlistEmbed}</div>
      ${body}
      <p class="music-note">
        ${icon("info")}播放器由网易云音乐提供。部分歌曲需要登录或会员才能在网页里播放，点歌名可以去网易云收听。
      </p>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ 站点框架 */

const DEFAULT_NAV = [
  { label: "首页", to: "/" },
  { label: "归档", to: "/archive" },
  { label: "标签", to: "/tags" },
  { label: "关于", to: "/about" },
];

/* 导航目标：/archive 这样的站内路径要变成 #/archive，外部链接保持原样 */
export function navHref(to) {
  const raw = String(to ?? "").trim();
  if (!raw) return "#/";
  if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
  if (raw.startsWith("#")) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "#/"; // javascript: 之类一律不认
  return `#${raw.startsWith("/") ? "" : "/"}${raw}`;
}

export function applyChrome(site, { mode = "light" } = {}) {
  const s = site.site || {};
  const title = s.title || "我的小站";

  document.title = title;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute("content", s.description || `${title} 的个人博客`);
  const og = document.querySelector('meta[property="og:title"]');
  if (og) og.setAttribute("content", title);

  const avatar = document.getElementById("brand-avatar");
  if (avatar && s.avatar) avatar.src = safeUrl(s.avatar, "assets/img/avatar.svg");

  const brandTitle = document.getElementById("brand-title");
  if (brandTitle) brandTitle.textContent = title;
  const brandSub = document.getElementById("brand-sub");
  if (brandSub) brandSub.textContent = s.subtitle || "";

  const nav = document.getElementById("nav");
  if (nav) {
    const items = (Array.isArray(site.nav) && site.nav.length ? site.nav : DEFAULT_NAV).slice();
    // 有音乐就自动补一个入口，不用手动去加导航
    if (musicEnabled(site) && !items.some((x) => String(x?.to || "") === "/music")) {
      items.push({ label: "音乐", to: "/music" });
    }
    nav.innerHTML = items
      .filter((x) => x && x.label)
      .map((x) => {
        const href = navHref(x.to);
        const ext = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${escapeHtml(href)}" data-to="${escapeHtml(x.to || "/")}"${ext}>${escapeHtml(x.label)}</a>`;
      })
      .join("");
  }

  const actions = document.getElementById("head-actions");
  if (actions) {
    actions.innerHTML = `
      <button class="icon-btn" id="btn-search" aria-label="搜索文章" title="搜索（Ctrl / ⌘ + K）">${icon("search")}</button>
      <button class="icon-btn" id="btn-mode" aria-label="切换明暗" title="切换明暗">${icon(mode === "dark" ? "sun" : "moon")}</button>
      <button class="icon-btn menu-btn" id="btn-menu" aria-label="菜单" aria-expanded="false">${icon("menu")}</button>`;
  }

  const footLine = document.getElementById("foot-line");
  if (footLine) {
    footLine.textContent = s.footer || `© ${new Date().getFullYear()} ${s.author || title}`;
  }

  const footLinks = document.getElementById("foot-links");
  if (footLinks) {
    const socials = (site.social || [])
      .filter((x) => x && x.url)
      .map(
        (x) =>
          `<a href="${safeUrl(x.url, "#")}" target="_blank" rel="noopener noreferrer">${icon(
            x.icon || "link"
          )}${escapeHtml(x.label || x.url)}</a>`
      );
    footLinks.innerHTML = [...socials, `<a href="#/admin">${icon("lock")}控制台</a>`].join("");
  }
}

export function setActiveNav(route) {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const path = route.path || "/";
  nav.querySelectorAll("a").forEach((a) => {
    const to = a.dataset.to || "/";
    const on = to === "/" ? path === "/" : path.startsWith(to);
    a.classList.toggle("is-on", on);
  });
}

export function updateModeIcon(mode) {
  const btn = document.getElementById("btn-mode");
  if (btn) btn.innerHTML = icon(mode === "dark" ? "sun" : "moon");
}

/* 后台「外观」页用的缩略预览 */
export function previewCardsHTML(posts) {
  const list = orderedPosts(posts).slice(0, 2);
  if (!list.length) {
    return `<div class="empty" style="padding:36px"><b>还没有文章</b><span>预览会显示最近的两篇。</span></div>`;
  }
  return `<div class="post-grid" style="gap:18px">${list.map(cardHTML).join("")}</div>`;
}
