/* 本地控制台
 *
 *   node scripts/console.mjs [端口]
 *
 * - 直接读写本目录下的 content/*.json，不经过 GitHub API
 * - 密码沿用 content/site.json 里的 PBKDF2 哈希，跟网页版是同一个
 * - 所有改动攒到最后，点一次「提交」生成一个 git commit（可选顺带 push）
 * - 只监听 127.0.0.1，并且每次启动生成一个临时令牌，防止别的网页调用本地接口
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || process.env.PORT || 8787);
const TOKEN = crypto.randomBytes(16).toString("hex");
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

const CONTENT_FILES = new Set(["content/site.json", "content/posts.json"]);

/* ---------------------------------------------------------------- 工具 */

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: root, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        killed: Boolean(err?.killed),
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        message: err?.message || "",
      });
    });
  });
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  } catch (e) {
    throw new Error(`读取 ${file} 失败：${e.message}`);
  }
}

function writeFileSafe(relPath, text) {
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep)) throw new Error("路径越界");
  if (!CONTENT_FILES.has(relPath)) throw new Error("只允许写入 content/site.json 和 content/posts.json");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  return relPath;
}

function writeImage(relPath, base64) {
  const clean = String(relPath || "").replace(/\\/g, "/");
  if (!/^assets\/uploads\/[\w.-]+\.(webp|jpe?g|png|svg|gif|avif)$/i.test(clean)) {
    throw new Error("图片路径不合法");
  }
  const abs = path.resolve(root, clean);
  if (!abs.startsWith(path.join(root, "assets", "uploads") + path.sep)) throw new Error("路径越界");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(String(base64 || ""), "base64"));
  return clean;
}

/* ---------------------------------------------------------------- 接口 */

async function api(req, res, pathname) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return sendJSON(res, 403, { error: "来源不被允许" });
  if (req.headers["x-console-token"] !== TOKEN) return sendJSON(res, 401, { error: "令牌不对，请重新打开控制台" });

  if (pathname === "/api/state" && req.method === "GET") {
    try {
      return sendJSON(res, 200, {
        site: readJSON("content/site.json"),
        posts: readJSON("content/posts.json"),
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname === "/api/file" && req.method === "POST") {
    try {
      const body = await readBody(req);
      writeFileSafe(body.path, body.text);
      return sendJSON(res, 200, { ok: true, path: body.path });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (pathname === "/api/image" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const saved = writeImage(body.path, body.base64);
      return sendJSON(res, 200, { ok: true, path: saved });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (pathname === "/api/git" && req.method === "GET") {
    const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await run("git", ["status", "--porcelain=v1"]);
    const changes = status.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3) }));
    const upstream = await run("git", ["rev-list", "--count", "@{u}..HEAD"]);
    const ahead = upstream.ok ? Number(upstream.stdout.trim()) || 0 : 0;
    return sendJSON(res, 200, {
      branch: branch.ok ? branch.stdout.trim() : "",
      changes,
      ahead,
      clean: changes.length === 0,
    });
  }

  if (pathname === "/api/commit" && req.method === "POST") {
    const body = await readBody(req);
    const message = String(body.message || "").trim() || "更新站点内容";

    const add = await run("git", ["add", "-A"]);
    if (!add.ok) return sendJSON(res, 500, { error: "git add 失败", detail: add.stderr || add.message });

    const staged = await run("git", ["diff", "--cached", "--name-only"]);
    if (!staged.stdout.trim()) return sendJSON(res, 400, { error: "没有需要提交的改动" });

    const commit = await run("git", ["commit", "-m", message], 60000);
    if (!commit.ok) {
      return sendJSON(res, 500, { error: "git commit 失败", detail: commit.stderr || commit.message });
    }

    const sha = (await run("git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
    let pushed = false;
    let pushError = "";
    if (body.push) {
      const push = await run("git", ["push"], 120000);
      pushed = push.ok;
      if (!push.ok) pushError = (push.stderr || push.message || "").split("\n").slice(-4).join("\n");
    }
    return sendJSON(res, 200, { ok: true, sha, files: staged.stdout.trim().split("\n").length, pushed, pushError });
  }

  return sendJSON(res, 404, { error: "没有这个接口" });
}

/* ---------------------------------------------------------------- 静态 */

function serveStatic(req, res, pathname) {
  if (pathname === "/console" || pathname === "/console.html") {
    try {
      const html = fs
        .readFileSync(path.join(root, "console.html"), "utf8")
        .replace("%%CONSOLE_TOKEN%%", TOKEN);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch {
      res.writeHead(500).end("console.html 不见了");
    }
    return;
  }

  let filePath = path.join(root, pathname);
  if (pathname.endsWith("/")) filePath = path.join(filePath, "index.html");
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const noStore = [".html", ".json", ".js", ".css"].includes(ext);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": noStore ? "no-store" : "public, max-age=60",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------------------------------------------------------- 启动 */

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
  if (pathname.startsWith("/api/")) {
    api(req, res, pathname).catch((e) => sendJSON(res, 500, { error: e?.message || "服务端错误" }));
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/console`;
  console.log("");
  console.log("  本地控制台已启动");
  console.log(`  控制台  ${url}`);
  console.log(`  预览站  http://127.0.0.1:${port}/`);
  console.log("");
  console.log("  改动只在点「提交」之后才会生成 git 提交。Ctrl+C 结束。");
  console.log("");
  if (process.env.CONSOLE_OPEN !== "0") {
    execFile(process.platform === "win32" ? "cmd" : "open", process.platform === "win32" ? ["/c", "start", "", url] : [url], () => {});
  }
});
