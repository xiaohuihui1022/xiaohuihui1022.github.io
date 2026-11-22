/* 文章存储规则
 *
 *   content/posts/index.json          索引：只有元信息，列表/归档/标签/搜索都读它
 *   content/posts/<标签>/<slug>.json   正文：一篇文章一个文件
 *
 * 不按 tag 分文件夹也能用（path 存在索引里），但默认按「第一个标签」归类，
 * 没有标签的落到 _uncategorized。
 */

import { slugify, truncate, readingTime } from "./core.js";

export const POSTS_DIR = "content/posts";
export const INDEX_FILE = `${POSTS_DIR}/index.json`;
export const UNCATEGORIZED = "_uncategorized";
export const SCHEMA_VERSION = 2;

/* 文件夹名：去掉文件系统不认的字符，保留中文 */
export function folderName(tag) {
  const s = String(tag || "")
    .trim()
    .replace(/[\\/:*?"<>|#%^~`{}$[\]@!+]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 40);
  return s || "";
}

export function primaryTag(post) {
  const tags = Array.isArray(post?.tags) ? post.tags : [];
  for (const t of tags) {
    const name = String(t || "").trim();
    if (name) return name;
  }
  return "";
}

export function postPath(post) {
  const slug = slugify(post?.slug || post?.title || post?.id || "post", "post");
  const folder = folderName(primaryTag(post)) || UNCATEGORIZED;
  return `${POSTS_DIR}/${folder}/${slug}.json`;
}

/* 正文 → 索引里的一条 */
export function toMeta(post) {
  const body = String(post?.body || "");
  const tags = (Array.isArray(post?.tags) ? post.tags : []).map((t) => String(t).trim()).filter(Boolean);
  return {
    id: post.id,
    slug: post.slug,
    title: post.title || "无标题",
    date: post.date || "",
    tags,
    cover: post.cover || "",
    excerpt: post.excerpt || truncate(body, 110),
    pinned: Boolean(post.pinned),
    draft: Boolean(post.draft),
    path: post.path && post.path.startsWith(POSTS_DIR) ? post.path : postPath(post),
    readingTime: readingTime(body),
    words: body.replace(/\s/g, "").length,
    updatedAt: post.updatedAt || "",
  };
}

export function buildIndex(metas, updatedAt) {
  return {
    version: SCHEMA_VERSION,
    updatedAt: updatedAt || new Date().toISOString(),
    posts: metas,
  };
}

/* 旧版单文件 posts.json → 索引（给平滑迁移和兜底用） */
export function metasFromLegacy(posts) {
  return (Array.isArray(posts) ? posts : []).map((p) => toMeta({ ...p, path: p.path || postPath(p) }));
}
