/* 把旧的单文件 content/posts.json 迁成「一篇文章一个文件 + 索引」
 *
 *   node scripts/migrate-posts.mjs
 *
 * 迁移后：
 *   content/posts/<标签>/<slug>.json   每篇正文
 *   content/posts/index.json           索引（列表、归档、标签、搜索只读它）
 *   content/posts.json                 删除（历史还在 git 里）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_FILE, postPath, toMeta, SCHEMA_VERSION } from "../assets/js/posts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacy = path.join(root, "content/posts.json");

if (!fs.existsSync(legacy)) {
  console.log("没有 content/posts.json，已经是新结构了。");
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(legacy, "utf8"));
const posts = Array.isArray(raw.posts) ? raw.posts : [];
const metas = [];
let written = 0;

for (const post of posts) {
  const meta = toMeta(post);
  const rel = postPath(post);
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const { path: _drop, ...body } = post;
  const file = {
    version: SCHEMA_VERSION,
    ...body,
    slug: meta.slug,
    updatedAt: post.updatedAt || new Date().toISOString(),
  };
  fs.writeFileSync(abs, JSON.stringify(file, null, 2) + "\n", "utf8");
  metas.push({ ...meta, path: rel });
  written++;
  console.log(`  ${meta.draft ? "[草稿]" : "[发布]"} ${rel}`);
}

const indexAbs = path.join(root, INDEX_FILE);
fs.mkdirSync(path.dirname(indexAbs), { recursive: true });
fs.writeFileSync(
  indexAbs,
  JSON.stringify({ version: SCHEMA_VERSION, updatedAt: new Date().toISOString(), posts: metas }, null, 2) + "\n",
  "utf8"
);

fs.unlinkSync(legacy);

console.log("");
console.log(`迁移完成：${written} 篇 → content/posts/，索引写入 ${INDEX_FILE}`);
console.log("旧的 content/posts.json 已删除（git 历史里还能找回）。");
