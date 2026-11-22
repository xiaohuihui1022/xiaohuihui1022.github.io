/* 本地控制台的入口
 * 复用同一套控制面板（admin.js），只是把「读写 GitHub」换成了「读写本地磁盘 + git commit」 */

import { mount } from "./admin.js";
import { applyTheme } from "./theme.js";
import { escapeHtml } from "./core.js";

const token = window.__CONSOLE_TOKEN__ || "";
const app = document.getElementById("app");

async function call(path, body) {
  const res = await fetch(`/api${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "x-console-token": token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const backend = {
  load: () => call("/state"),
  readFile: async (path) => (await call("/read", { path })).text,
  saveFiles: (files) => call("/files", { files }),
  putImage: (path, base64) => call("/image", { path, base64 }),
  git: () => call("/git"),
  commit: (message, push) => call("/commit", { message, push }),
};

function fail(message) {
  app.innerHTML = `
  <div class="lock-wrap">
    <div class="lock-card">
      <div class="mark" style="font-size:26px;text-align:center;color:var(--accent)">✧</div>
      <h1>打不开本地控制台</h1>
      <p class="lead">${escapeHtml(message)}</p>
      <p class="hint" style="text-align:center">
        在项目目录里运行 <code>node scripts/console.mjs</code>，再用它打印出来的地址打开。
      </p>
    </div>
  </div>`;
}

try {
  if (!token || token === "%%CONSOLE_TOKEN%%") {
    throw new Error("没有拿到本地令牌。这个页面要由本地服务提供，不能直接双击打开。");
  }
  const state = await backend.load();
  applyTheme(state.site?.theme || {}, { persist: false });

  await mount(app, {
    mode: "local",
    backend,
    sitePayload: state.site || {},
    postsPayload: state.posts || { posts: [] },
    reload: async () => {},
    exit: () => {
      location.href = "/";
    },
  });
} catch (e) {
  console.error(e);
  fail(e?.message || "未知错误");
}
