/* 端到端自测 + 截图
   - 用系统 Edge 跑真实页面
   - 用本地假 GitHub API 拦截请求，不碰真仓库
   QA_MODE=playwright node scripts/qa.mjs
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE || "http://127.0.0.1:5173/";
const SHOTS = path.join(root, ".shots");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CDP_PORT = 9333;

fs.mkdirSync(SHOTS, { recursive: true });

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

/* 测试用的固定内容：不依赖站点里当前实际有哪些文章 */
const FIXTURE_POSTS = {
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  posts: [
    {
      id: "t1",
      slug: "fixture-hello",
      title: "第一篇：置顶的测试文章",
      date: "2026-11-18",
      tags: ["随笔", "测试"],
      cover: "assets/img/cover-1.svg",
      excerpt: "这是一篇用于自动化测试的置顶文章。",
      pinned: true,
      draft: false,
      body: "## 第一节\n\n正文内容，用来验证目录生成。\n\n## 第二节\n\n再写一点东西，聊一聊 CSS 和排版。\n\n## 第三节\n\n最后一节，收个尾。",
    },
    {
      id: "t2",
      slug: "fixture-css",
      title: "第二篇：关于 CSS 的测试",
      date: "2026-11-12",
      tags: ["前端", "CSS"],
      cover: "assets/img/cover-2.svg",
      excerpt: "第二篇测试文章的摘要。",
      draft: false,
      body: "## 小标题\n\nCSS 的一些小事。\n\n```css\nbody { color: red }\n```\n",
    },
    {
      id: "t3",
      slug: "fixture-life",
      title: "第三篇：生活碎片",
      date: "2026-10-28",
      tags: ["生活"],
      cover: "",
      excerpt: "没有封面的文章。",
      draft: false,
      body: "随便写点什么。\n\n> 引用一句。\n",
    },
    {
      id: "t4",
      slug: "fixture-draft",
      title: "一篇草稿",
      date: "2026-11-20",
      tags: ["草稿"],
      cover: "",
      excerpt: "",
      draft: true,
      body: "草稿内容。",
    },
    {
      id: "t5",
      slug: "fixture-more",
      title: "第四篇：再凑一篇",
      date: "2026-09-15",
      tags: ["日常", "测试"],
      cover: "",
      excerpt: "为了让列表里有三张卡片。",
      draft: false,
      body: "凑数的一篇。\n\n## 小标题\n\n内容。\n",
    },
  ],
};

const siteFixture = JSON.parse(fs.readFileSync(path.join(root, "content/site.json"), "utf8"));
siteFixture.admin = { repo: { owner: "tester", name: "my-blog", branch: "main" }, auth: null };

const repo = {
  "content/site.json": JSON.stringify(siteFixture),
  "content/posts.json": JSON.stringify(FIXTURE_POSTS),
};
const shas = { "content/posts.json": "sha-posts-1" };
let shaSeq = 0;
let denyToken = false;
let fail409Once = false;
const commits = [];

const errors = [];
const steps = [];

function step(name, ok, detail = "") {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

function waitForCDP(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() - started > timeout) return reject(new Error("CDP 端口没有起来"));
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function launchEdge() {
  const { spawn } = await import("node:child_process");
  const profile = path.join(process.env.TEMP || ".", `dsh-edge-qa-${Date.now()}`);
  const child = spawn(
    EDGE,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true }
  );
  await waitForCDP(`http://127.0.0.1:${CDP_PORT}/json/version`);
  return { child, profile };
}

async function main() {
  const mode = process.env.QA_MODE || "cdp";
  let edgeHandle = null;
  let browser;
  let ctx;

  if (mode === "playwright") {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    ctx = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  } else {
    const cdp = process.env.CDP_URL || "";
    if (cdp) {
      browser = await chromium.connectOverCDP(cdp);
    } else {
      edgeHandle = await launchEdge();
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    }
    ctx = browser.contexts()[0] || (await browser.newContext());
  }

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 980 });

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  const shot = async (name, full = true) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: full });
  };

  /* 模拟「GitHub Pages 已经重新部署」：站点静态 JSON 跟着仓库内容走 */
  await page.route(/\/content\/(site|posts)\.json(\?.*)?$/, async (route) => {
    const key = route.request().url().includes("posts.json") ? "content/posts.json" : "content/site.json";
    return route.fulfill({ status: 200, contentType: "application/json", body: repo[key] });
  });

  /* 网易云播放器在测试里不需要真的加载 */
  await page.route(/music\.163\.com/, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title>" })
  );

  await page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = decodeURIComponent(url.pathname);
    const method = req.method();

    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (/^\/repos\/[^/]+\/[^/]+$/.test(p) && method === "GET") {
      if (denyToken) return json(403, { message: "Resource not accessible by personal access token" });
      return json(200, {
        full_name: "tester/my-blog",
        default_branch: "main",
        private: false,
        html_url: "https://github.com/tester/my-blog",
        permissions: { admin: true, push: true, pull: true },
      });
    }
    if (p.endsWith("/branches")) return json(200, [{ name: "main" }]);

    const m = p.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    if (m) {
      const file = m[1];
      if (method === "GET") {
        if (!(file in repo) || repo[file] == null) return json(404, { message: "Not Found" });
        return json(200, {
          path: file,
          sha: shas[file] || "sha-x",
          encoding: "base64",
          content: b64(repo[file]),
          size: Buffer.byteLength(repo[file]),
        });
      }
      if (method === "PUT") {
        if (fail409Once) {
          fail409Once = false;
          return json(409, { message: "sha does not match [given: old-sha, expected: new-sha]" });
        }
        const body = JSON.parse(req.postData() || "{}");
        repo[file] = unb64(body.content || "");
        shaSeq++;
        shas[file] = `sha-${shaSeq}`;
        commits.push({ file, message: body.message, size: repo[file].length });
        return json(200, { content: { sha: shas[file] }, commit: { sha: `c${shaSeq}` } });
      }
    }
    return json(200, {});
  });

  /* ---------------------------------------------------------- 公共站点 */
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".card, .featured", { timeout: 8000 });

  const cards = await page.locator(".card").count();
  const hasFeatured = await page.locator(".featured").count();
  step("首页渲染文章卡片", cards >= 3, `${cards} 张卡片 + ${hasFeatured} 个头条`);
  step("置顶文章出现在头条", hasFeatured === 1);

  const pageTitle = await page.title();
  step("页面标题来自配置", pageTitle.includes("灰灰的小站"), pageTitle);

  await shot("01-home-light.png");

  // 顶栏导航链接（曾经因为把 /archive 直接写进 href 而失灵）
  for (const [label, sel] of [
    ["归档", ".year-group"],
    ["标签", ".tag-pill"],
    ["关于", ".prose"],
    ["首页", ".hero"],
  ]) {
    await page.click(`.nav a:has-text("${label}")`);
    await page.waitForSelector(sel, { timeout: 5000 });
    const hash = await page.evaluate(() => location.hash);
    step(`导航「${label}」可以点击`, true, hash || "(空)");
  }
  await page.goto(BASE, { waitUntil: "networkidle" });

  // 深色模式
  await page.click("#btn-mode");
  await page.waitForTimeout(350);
  const currentMode = await page.getAttribute("html", "data-mode");
  step("切换到深色模式", currentMode === "dark", `data-mode=${currentMode}`);
  await shot("02-home-dark.png");
  await page.click("#btn-mode");
  await page.waitForTimeout(250);

  // 文章页
  await page.click(".featured .card-link");
  await page.waitForSelector(".post-title");
  const postTitle = (await page.textContent(".post-title"))?.trim();
  step("打开文章详情", Boolean(postTitle), postTitle || "");
  const toc = await page.locator(".toc a").count();
  step("长文生成目录", toc >= 2, `${toc} 条`);
  await shot("03-post.png");

  // 归档 / 标签 / 关于
  await page.goto(`${BASE}#/archive`, { waitUntil: "networkidle" });
  await page.waitForSelector(".year-group");
  step("归档按年份分组", (await page.locator(".year-group").count()) >= 1);
  await shot("04-archive.png");

  await page.goto(`${BASE}#/tags`, { waitUntil: "networkidle" });
  await page.waitForSelector(".tag-pill");
  step("标签云渲染", (await page.locator(".tag-pill").count()) >= 3);

  await page.goto(`${BASE}#/about`, { waitUntil: "networkidle" });
  await page.waitForSelector(".prose");
  step("关于页面渲染 Markdown", (await page.locator(".prose h2").count()) >= 1);

  // 搜索
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#search-layer:not([hidden])");
  await page.fill("#search-input", "CSS");
  await page.waitForTimeout(300);
  const results = await page.locator(".sr").count();
  step("搜索能筛出结果", results >= 1, `${results} 条`);
  await shot("05-search.png", false);
  await page.keyboard.press("Escape");

  /* ---------------------------------------------------------- 控制台初始化 */
  await page.goto(`${BASE}#/admin`, { waitUntil: "networkidle" });
  await page.waitForSelector("#setup-form");
  step("未初始化时进入首次设置页", true);
  await shot("06-admin-setup.png");

  await page.fill("#s-pw", "sakura-moon-2026");
  await page.fill("#s-pw2", "sakura-moon-2026");
  await page.fill("#s-owner", "tester");
  await page.fill("#s-repo", "my-blog");
  await page.fill("#s-branch", "main");
  await page.fill("#s-token", "github_pat_fake_token_for_test");
  await page.click("#s-submit");

  await page.waitForSelector(".adm-nav", { timeout: 20000 });
  step("初始化成功并进入控制台", true);

  const storedAuth = JSON.parse(repo["content/site.json"] || "{}")?.admin?.auth;
  step("密码以 PBKDF2 哈希写入仓库", Boolean(storedAuth?.hash && storedAuth?.salt), `${storedAuth?.iterations} 次迭代`);
  step("仓库里没有明文密码", !JSON.stringify(repo["content/site.json"]).includes("sakura-moon-2026"));
  const tokenLs = await page.evaluate(() => localStorage.getItem("blog.gh.token"));
  step("令牌存在本机 localStorage", Boolean(tokenLs && tokenLs.includes("fake_token")));
  step("令牌没有写进仓库", !JSON.stringify(repo).includes("fake_token"));

  await page.waitForSelector(".prow");
  await shot("07-admin-list.png");

  /* ---------------------------------------------------------- 外观 */
  await page.click('[data-tab="appearance"]');
  await page.waitForSelector(".preset");
  await shot("08-admin-appearance.png");

  await page.click('[data-preset="mint"]');
  await page.waitForTimeout(400);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  step("切换主题预设即时生效", accent.toLowerCase() === "#6cc3a9", `--accent=${accent}`);
  await shot("09-admin-mint.png");

  // 切回站点原本的预设，避免残留「未保存」挡住后面的切换
  await page.click(`[data-preset="${siteFixture.theme?.preset || "sakura"}"]`);

  /* 面板里的明暗预览 */
  await page.click('[data-act="preview-mode"]');
  await page.waitForTimeout(300);
  step("面板可以预览夜间模式", (await page.getAttribute("html", "data-mode")) === "dark");
  await shot("09b-admin-dark.png");
  await page.click('[data-act="preview-mode"]');
  await page.waitForTimeout(200);

  /* ---------------------------------------------------------- 编辑器 */
  await page.click('[data-tab="content"]');
  await page.click('[data-act="new-post"]');
  await page.waitForSelector("#md-input");
  await page.locator("#e-title").fill("测试文章：来自自动化检查");
  const md = page.locator("#md-input");
  await md.scrollIntoViewIfNeeded();
  await md.click();
  await md.fill(
    "## 小标题\n\n这是**加粗**、*斜体*和 `行内代码`。\n\n- 第一项\n- 第二项\n\n> 引用一句话\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |\n"
  );
  await page.waitForTimeout(400);
  const previewText = await page.textContent("#md-preview-body");
  step("编辑器实时预览 Markdown", previewText.includes("小标题") && previewText.includes("行内代码"));
  step("预览支持表格", (await page.locator("#md-preview-body table").count()) === 1);
  await shot("10-admin-editor.png");

  // 选「发布」再保存；故意让第一次 PUT 返回 409，验证会自动重新取 sha 再提交
  await page.click('#e-status [data-draft="false"]');
  fail409Once = true;
  await page.click('[data-act="save-post"]');
  await page.waitForTimeout(2200);
  const savedPosts = JSON.parse(repo["content/posts.json"] || "{}");
  const created = (savedPosts.posts || []).find((p) => p.title === "测试文章：来自自动化检查");
  step("保存后文章写入 posts.json", Boolean(created), `${commits.length} 次提交`);
  step("遇到 409 会自动重试成功", Boolean(created));
  step("提交信息可读", commits.some((c) => c.message.includes("测试文章")));

  /* ---------------------------------------------------------- 安全 */
  await page.click('[data-tab="security"]');
  await page.waitForSelector("#pw-form");
  await shot("11-admin-security.png");

  await page.fill("#pw-old", "not-the-password");
  await page.fill("#pw-new", "another-strong-pass-2026");
  await page.fill("#pw-new2", "another-strong-pass-2026");
  await page.click('#pw-form button[type="submit"]');
  await page.waitForTimeout(700);
  const badOld = await page.evaluate(() => document.querySelector(".toast.err")?.textContent || "");
  step("改密码时校验旧密码", badOld.includes("当前密码不对"), badOld.trim());

  /* ---------------------------------------------------------- 音乐 */
  await page.click('[data-tab="music"]');
  await page.waitForSelector("#song-add");
  await page.fill("#song-add", "https://music.163.com/song?id=1234567");
  await page.click('[data-act="song-add"]');
  await page.waitForTimeout(400);
  const songId = await page.locator('[data-song="id"]').first().inputValue();
  step("粘贴分享链接能解析出歌曲 ID", songId === "1234567", songId);

  await page.fill('[data-song="name"]', "测试歌曲");
  await page.fill('[data-song="artist"]', "测试歌手");
  await page.waitForTimeout(400);
  step("音乐预览出现卡片", (await page.locator("#music-preview .song").count()) === 1);
  await shot("11b-admin-music.png");

  await page.click('[data-act="save"]');
  await page.waitForTimeout(1600);
  const musicSite = JSON.parse(repo["content/site.json"] || "{}");
  step("音乐配置写入 site.json", Boolean(musicSite.music?.songs?.length), `${musicSite.music?.songs?.length || 0} 首`);

  /* ---------------------------------------------------------- 发布后的前台 */
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");
  const onSite = await page.locator(".card-title", { hasText: "测试文章" }).count();
  step("发布后前台立即能看到", onSite >= 1);

  /* 前台音乐 */
  step("有音乐后导航自动出现「音乐」", (await page.locator('.nav a:has-text("音乐")').count()) === 1);
  step("首页出现音乐卡片", (await page.locator(".music-grid .song").count()) >= 1);
  await page.locator(".music-grid .song-play").first().click();
  await page.waitForTimeout(500);
  step("点播放会嵌入网易云播放器", (await page.locator(".song-player iframe").count()) === 1);
  await page.evaluate(() => {
    location.hash = "#/music";
  });
  await page.waitForSelector(".music-list");
  step("音乐页可以打开", (await page.locator(".music-list .song").count()) >= 1);
  await shot("11c-music-page.png");
  await page.goto(BASE, { waitUntil: "networkidle" });

  /* ---------------------------------------------------------- 二次访问需要密码 */
  await page.evaluate(() => localStorage.removeItem("blog.gh.token"));
  await page.reload({ waitUntil: "networkidle" });
  await page.goto(`${BASE}#/admin`, { waitUntil: "networkidle" });
  await page.waitForSelector("#lock-form", { timeout: 10000 });
  step("再次访问要求密码", true);
  await page.fill("#lock-pw", "wrong-password");
  await page.click("#lock-btn");
  await page.waitForTimeout(900);
  const errVisible = await page.locator("#lock-err.is-on").count();
  step("错误密码被拒绝", errVisible === 1);

  await page.fill("#lock-pw", "sakura-moon-2026");
  await page.click("#lock-btn");
  await page.waitForSelector("#token-form", { timeout: 15000 });
  step("密码正确后要求本机令牌", true);
  await shot("12-admin-token.png");

  // 令牌权限不足时，应该给出可操作的中文提示，而不是 GitHub 的英文原文
  denyToken = true;
  await page.fill("#t-token", "github_pat_no_permission");
  await page.click("#t-btn");
  await page.waitForTimeout(900);
  const gateErr = (await page.textContent("#t-err")) || "";
  step("令牌权限不足时给出可操作提示", gateErr.includes("Contents"), gateErr.slice(0, 46));
  denyToken = false;

  await page.fill("#t-token", "github_pat_fake_token_for_test");
  await page.click("#t-btn");
  await page.waitForSelector(".adm-nav", { timeout: 15000 });
  step("令牌正确后进入控制台", true);

  /* ---------------------------------------------------------- 字体 / 圆角 / 退出 */
  await page.click('[data-tab="appearance"]');
  await page.waitForSelector("[data-font]");
  await page.click('[data-font="serif"]');
  await page.waitForTimeout(250);
  step("切换字体会即时生效", (await page.getAttribute("html", "data-font")) === "serif");

  await page.locator("#radius-range").evaluate((el) => {
    el.value = "30";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const radius = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--radius").trim()
  );
  step("圆角滑杆即时生效", radius === "30px", `--radius=${radius}`);

  await page.click('[data-act="exit"]');
  await page.waitForSelector(".site-head", { timeout: 10000 });
  step("退出控制台回到前台", (await page.locator(".card, .featured").count()) >= 1);

  /* ---------------------------------------------------------- 404 */
  await page.goto(`${BASE}no-such-page`, { waitUntil: "domcontentloaded" });
  const has404 = (await page.content()).includes("走丢了");
  step("404 页面正常显示", has404);

  /* ---------------------------------------------------------- 移动端 */
  await ctx.close();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mp = await mobile.newPage();
  mp.on("pageerror", (err) => errors.push(`mobile pageerror: ${err.message}`));

  // 手机端也要用同一份测试内容，否则空站点没有卡片可测
  await mp.route(/\/content\/(site|posts)\.json(\?.*)?$/, (route) => {
    const key = route.request().url().includes("posts.json") ? "content/posts.json" : "content/site.json";
    return route.fulfill({ status: 200, contentType: "application/json", body: repo[key] });
  });
  await mp.route(/music\.163\.com/, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title>" })
  );

  await mp.goto(BASE, { waitUntil: "networkidle" });
  await mp.waitForSelector(".card");
  await mp.waitForTimeout(700);
  await mp.screenshot({ path: path.join(SHOTS, "13-mobile.png"), fullPage: true });
  step("移动端首页正常渲染", (await mp.locator(".card").count()) >= 1);

  // 移动端导航抽屉：点完要收起
  await mp.click("#btn-menu");
  await mp.waitForSelector(".nav.open");
  await mp.click('.nav a:has-text("标签")');
  await mp.waitForTimeout(500);
  const menuClosed = (await mp.locator(".nav.open").count()) === 0;
  const mobileHash = await mp.evaluate(() => location.hash);
  step("移动端导航点完自动收起", menuClosed && mobileHash === "#/tags", mobileHash);

  await mobile.close();
  await browser.close();
  if (edgeHandle) {
    try {
      edgeHandle.child.kill();
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(edgeHandle.profile, { recursive: true, force: true });
    } catch {}
  }

  const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  step("没有 JavaScript 报错", realErrors.length === 0, realErrors.join(" | "));

  console.log(`\n截图目录：${SHOTS}`);
  console.log(`提交记录：${commits.map((c) => c.message).join(" / ")}`);
}

main().catch((err) => {
  console.error("QA 运行失败：", err);
  process.exit(1);
});
