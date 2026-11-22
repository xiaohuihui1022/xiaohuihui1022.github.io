/* 轻量 Markdown 渲染器
   支持：标题、段落、粗斜体、删除线、行内代码、围栏代码块、引用、有序/无序列表（可嵌套）、
   表格、分隔线、链接、图片（带图注）、裸链接自动识别。
   所有原始 HTML 一律转义，避免内容注入。 */

import { escapeHtml, safeUrl, slugify } from "./core.js";

const MARK = "\u0000";

/* 可用的字色名，和 CSS 里的 .c-* 一一对应 */
export const COLOR_NAMES = ["rose", "violet", "mint", "sky", "amber", "cherry", "gray", "ink"];

function unmark(html, stash) {
  let out = html;
  let guard = 0;
  const re = /\u0000(\d+)\u0000/g;
  while (re.test(out) && guard++ < 12) {
    out = out.replace(re, (_, idx) => stash[Number(idx)] ?? "");
  }
  return out;
}

/* ------------------------------------------------------------ 行内 */

export function inline(text) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `${MARK}${stash.length - 1}${MARK}`;
  };

  let s = escapeHtml(text);

  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));

  // 图片
  s = s.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
    (whole, alt, src, title) => {
      const url = safeUrl(src, "");
      if (!url) return whole;
      const cap = title ? `<figcaption>${alt || title}</figcaption>` : alt ? `<figcaption>${alt}</figcaption>` : "";
      // referrerpolicy：不少图床（尤其是镜像站）会按 Referer 防盗链，不发送来源通常能放行
      const img = `<img src="${url}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer"${
        title ? ` title="${title}"` : ""
      } />`;
      return keep(cap ? `<figure>${img}${cap}</figure>` : img);
    }
  );

  // 链接
  s = s.replace(
    /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
    (whole, label, href, title) => {
      const url = safeUrl(href, "");
      if (!url) return whole;
      const ext = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : "";
      return keep(`<a href="${url}"${ext}${title ? ` title="${title}"` : ""}>${label}</a>`);
    }
  );

  // 裸链接
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<>)）]+)/g, (_, pre, url) =>
    `${pre}${keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`)}`
  );

  // 强调
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>");

  // 字色：{rose|文字} 或 {#e5849e|文字}
  // 放在强调之后，这样里面可以嵌 **加粗** 之类
  s = s.replace(/\{([#a-zA-Z0-9]{2,12})\|([^{}\n]+)\}/g, (whole, token, text) => {
    const name = String(token).toLowerCase();
    if (COLOR_NAMES.includes(name)) return `<span class="md-color c-${name}">${text}</span>`;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(token)) {
      return `<span class="md-color" style="--c:${token.toLowerCase()}">${text}</span>`;
    }
    return whole;
  });

  // 行尾两空格或反斜杠 → 硬换行
  s = s.replace(/ {2,}\n/g, "<br />\n").replace(/\\\n/g, "<br />\n");

  return unmark(s, stash);
}

/* ------------------------------------------------------------ 块级 */

function isBlank(line) {
  return /^\s*$/.test(line);
}

function headingId(text, state) {
  const base = slugify(text, "h");
  let id = base;
  let n = 1;
  while (state.ids.has(id)) id = `${base}-${++n}`;
  state.ids.add(id);
  return id;
}

function startsBlock(line) {
  return (
    /^\s{0,3}(#{1,6})\s+/.test(line) ||
    /^\s{0,3}(```|~~~)/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
  );
}

function parseList(lines, start, state) {
  const first = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[start]);
  if (!first) return ["", start];
  const baseIndent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);

    if (!m) {
      if (isBlank(line)) {
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        const nm = j < lines.length ? /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[j]) : null;
        if (nm && nm[1].length >= baseIndent && items.length) {
          i = j;
          continue;
        }
        break;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s{0,3}(#{1,6})\s+/.test(line)) break;
      if (items.length) {
        items[items.length - 1].text += "\n" + line.trim();
        i++;
        continue;
      }
      break;
    }

    const indent = m[1].length;
    if (indent < baseIndent) break;

    if (indent > baseIndent && items.length) {
      const [nested, next] = parseList(lines, i, state);
      items[items.length - 1].nested += nested;
      i = next;
      continue;
    }

    if (/^\d/.test(m[2]) !== ordered) break;

    items.push({ text: m[3], nested: "" });
    i++;
  }

  const tag = ordered ? "ol" : "ul";
  const body = items
    .map((it) => {
      const text = inline(it.text.replace(/\n/g, "  \n"));
      return `<li>${text}${it.nested}</li>`;
    })
    .join("");
  return [`<${tag}>${body}</${tag}>`, i];
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseTable(lines, start, state) {
  const head = splitRow(lines[start]);
  const sep = splitRow(lines[start + 1]);
  if (sep.length !== head.length || !sep.every((c) => /^:?-{1,}:?$/.test(c))) return ["", start];

  const align = sep.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return "";
  });

  const cell = (tag, text, idx) => {
    const a = align[idx] ? ` style="text-align:${align[idx]}"` : "";
    return `<${tag}${a}>${inline(text)}</${tag}>`;
  };

  let i = start + 2;
  const rows = [];
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
    const cells = splitRow(lines[i]);
    rows.push(`<tr>${head.map((_, idx) => cell("td", cells[idx] ?? "", idx)).join("")}</tr>`);
    i++;
  }

  const html =
    `<div class="table-wrap"><table><thead><tr>` +
    head.map((h, idx) => cell("th", h, idx)).join("") +
    `</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  return [html, i];
}

/* ------------------------------------------------------------ 主入口 */

export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const state = { ids: new Set() };
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // 围栏代码块
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || "";
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // 标题
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const id = headingId(text.replace(/[*_`~]/g, ""), state);
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    // 音乐卡片：{{music:1234567}}
    const tune = /^\s*\{\{\s*music\s*:\s*(\d{3,})\s*\}\}\s*$/.exec(line);
    if (tune) {
      out.push(`<div class="music-inline" data-music="${tune[1]}"></div>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    // 表格
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const [html, next] = parseTable(lines, i, state);
      if (html) {
        out.push(html);
        i = next;
        continue;
      }
    }

    // 引用
    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (/^\s{0,3}>/.test(cur)) {
          buf.push(cur.replace(/^\s{0,3}>\s?/, ""));
          i++;
          continue;
        }
        if (!isBlank(cur) && buf.length && !startsBlock(cur)) {
          buf.push(cur);
          i++;
          continue;
        }
        break;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // 列表
    if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(line)) {
      const [html, next] = parseList(lines, i, state);
      if (html) {
        out.push(html);
        i = next;
        continue;
      }
    }

    // 段落
    const buf = [];
    while (i < lines.length && !isBlank(lines[i]) && (buf.length === 0 || !startsBlock(lines[i]))) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join("\n"))}</p>`);
  }

  return out.join("\n");
}

/* 从渲染结果里抽目录（h2/h3） */
export function extractToc(root) {
  return Array.from(root.querySelectorAll("h2[id], h3[id]")).map((node) => ({
    id: node.id,
    text: node.textContent.replace(/^\s*✧\s*/, "").trim(),
    level: Number(node.tagName.slice(1)),
  }));
}
