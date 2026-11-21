/* 本地预览服务器：node scripts/serve.mjs [port]
   只用于开发预览，部署到 GitHub Pages 时不需要它。 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || 5173);

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
  ".xml": "application/xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let filePath = path.join(root, urlPath);
  if (urlPath.endsWith("/")) filePath = path.join(filePath, "index.html");

  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const notFound = path.join(root, "404.html");
      if (fs.existsSync(notFound)) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        fs.createReadStream(notFound).pipe(res);
      } else {
        res.writeHead(404).end("not found");
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const noStore = [".html", ".json", ".js", ".css"].includes(ext);
    res.writeHead(200, {
      "content-type": type,
      "cache-control": noStore ? "no-store" : "public, max-age=60",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`preview  http://127.0.0.1:${port}/`);
});
