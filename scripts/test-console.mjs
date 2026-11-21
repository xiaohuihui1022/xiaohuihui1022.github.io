/* 本地控制台的端到端验证：在临时目录里复制一份站点，跑真实的 git 提交
   node .test-console.mjs  */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PW = "local-console-test-2026";
const PORT = 8899;
const src = process.cwd();
const tmp = path.join(os.tmpdir(), `blog-console-test-${Date.now()}`);

if (!fs.existsSync(path.join(src, "content", "site.json"))) {
  console.error("请在项目根目录运行：node scripts/test-console.mjs");
  process.exit(1);
}

const SKIP = new Set(["node_modules", ".git", ".shots", ".pnpm-store", "docs"]);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

const git = (args) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();

function step(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

async function waitFor(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("服务器没有起来");
}

let server;
let browser;

try {
  /* 1. 准备临时仓库 */
  copyDir(src, tmp);
  git(["init", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);

  const siteFile = path.join(tmp, "content/site.json");
  const site = JSON.parse(fs.readFileSync(siteFile, "utf8"));
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(PW, salt, 600000, 32, "sha256");
  site.admin = site.admin || {};
  site.admin.auth = {
    algo: "PBKDF2-SHA256",
    iterations: 600000,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(siteFile, JSON.stringify(site, null, 2) + "\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-m", "set test password"]);

  /* 2. 起本地控制台 */
  server = spawn(process.execPath, [path.join(tmp, "scripts/console.mjs"), String(PORT)], {
    cwd: tmp,
    stdio: "ignore",
    env: { ...process.env, CONSOLE_OPEN: "0" },
  });
  await waitFor(`http://127.0.0.1:${PORT}/console`);
  step("本地服务启动成功", true, `127.0.0.1:${PORT}`);

  /* 3. 打开控制台 */
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`http://127.0.0.1:${PORT}/console`, { waitUntil: "networkidle" });
  await page.waitForSelector("#lock-form", { timeout: 10000 });
  step("本地版要求输入密码（与网页版同一份哈希）", true);

  await page.fill("#lock-pw", "wrong-password");
  await page.click("#lock-btn");
  await page.waitForTimeout(900);
  step("错误密码被拒绝", (await page.locator("#lock-err.is-on").count()) === 1);

  await page.fill("#lock-pw", PW);
  await page.click("#lock-btn");
  await page.waitForSelector(".adm-nav", { timeout: 20000 });
  step("密码正确后进入本地控制台", true);

  /* 4. 改主题 + 改文章，一起提交 */
  await page.click('[data-tab="appearance"]');
  await page.waitForSelector(".preset");
  await page.click('[data-preset="mint"]');
  await page.waitForTimeout(300);
  await page.click('[data-act="save"]');
  await page.waitForTimeout(900);
  step("外观改动写入 site.json", git(["status", "--porcelain"]).includes("content/site.json"));

  await page.click('[data-tab="content"]');
  await page.click('[data-act="new-post"]');
  await page.waitForSelector("#md-input");
  await page.locator("#e-title").fill("本地控制台写的文章");
  const md = page.locator("#md-input");
  await md.scrollIntoViewIfNeeded();
  await md.click();
  await md.fill("## 测试\n\n这篇是本地控制台写的。");
  await page.click('#e-status [data-draft="false"]');

  await page.click('[data-act="save"]');
  await page.waitForTimeout(1200);
  const afterSave = git(["status", "--porcelain"]);
  step("保存后文件写入磁盘", afterSave.includes("content/site.json") && afterSave.includes("content/posts.json"));

  const commitsBefore = Number(git(["rev-list", "--count", "HEAD"]));
  await page.click('[data-act="commit"]');
  await page.waitForSelector(".modal-layer");
  await page.fill("#commit-msg", "本地控制台：换配色 + 新增一篇");
  await page.click('[data-x="ok"]');
  await page.waitForSelector(".modal-layer", { state: "detached", timeout: 20000 });
  await page.waitForTimeout(800);

  const commitsAfter = Number(git(["rev-list", "--count", "HEAD"]));
  step("两次修改只生成一个提交", commitsAfter - commitsBefore === 1, `${commitsBefore} → ${commitsAfter}`);
  step("提交信息就是填的那句", git(["log", "-1", "--pretty=%s"]) === "本地控制台：换配色 + 新增一篇");
  step("提交后工作区干净", git(["status", "--porcelain"]) === "");

  const savedSite = JSON.parse(fs.readFileSync(path.join(tmp, "content/site.json"), "utf8"));
  const savedPosts = JSON.parse(fs.readFileSync(path.join(tmp, "content/posts.json"), "utf8"));
  step("主题改动落盘", savedSite.theme.preset === "mint", `preset=${savedSite.theme.preset}`);
  step("文章落盘", savedPosts.posts.some((p) => p.title === "本地控制台写的文章"));

  await page.screenshot({ path: path.join(src, ".shots", "40-local-console.png"), fullPage: false });
  step("没有 JavaScript 报错", errors.length === 0, errors.join(" | "));
} catch (e) {
  console.error("测试失败：", e.message);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } catch {}
  try {
    server?.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
