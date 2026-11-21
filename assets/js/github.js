/* GitHub REST 客户端：只做这个站点需要的几件事
   - 读取/写入仓库文件（contents API）
   - 上传图片（同样走 contents API）
   令牌只存在浏览器本地，永远不写进仓库。 */

export class GitHubError extends Error {
  constructor(status, message, data) {
    super(message || `GitHub ${status}`);
    this.status = status;
    this.data = data || {};
  }
}

export function toB64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function fromB64(b64) {
  const bin = atob(String(b64 || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

export function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export class GitHub {
  constructor({ token, owner, repo, branch = "main" }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || "main";
  }

  get slug() {
    return `${this.owner}/${this.repo}`;
  }

  async api(path, opts = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers || {}),
      },
    });

    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      const msg = data?.message || `请求失败（${res.status}）`;
      if (res.status === 401) throw new GitHubError(401, "令牌无效或已过期，请重新填写", data);
      if (res.status === 403 && /rate limit/i.test(msg)) throw new GitHubError(403, "触发了 GitHub 的频率限制，等一会儿再试", data);
      if (res.status === 403 && /resource not accessible/i.test(msg)) {
        throw new GitHubError(
          403,
          "令牌权限不够，检查两处：① Repository access 选 Only select repositories 并勾上这个博客仓库；" +
            "② Permissions → Contents 设为 Read and write（默认是 Read-only）。" +
            "用经典 token 的话则是勾选 repo 权限。改完要重新生成令牌。",
          data
        );
      }
      if (res.status === 404) throw new GitHubError(404, `找不到 ${this.slug}，或者这个令牌没有该仓库的访问权限`, data);
      if (res.status === 409) throw new GitHubError(409, "仓库内容已被别处修改，请刷新后重试", data);
      throw new GitHubError(res.status, msg, data);
    }
    return data;
  }

  async repoInfo() {
    return this.api(`/repos/${this.owner}/${this.repo}`);
  }

  async branches() {
    const list = await this.api(`/repos/${this.owner}/${this.repo}/branches?per_page=100`);
    return (list || []).map((b) => b.name);
  }

  /* 读取文件；文件大于 1MB 时 contents API 不返回 content，退回 raw 地址 */
  async getFile(path) {
    const data = await this.api(
      `/repos/${this.owner}/${this.repo}/contents/${encodeURI(path).replace(/#/g, "%23")}?ref=${encodeURIComponent(this.branch)}`
    );
    if (!data || Array.isArray(data)) {
      throw new GitHubError(404, `${path} 不是文件`, data);
    }
    let text = "";
    if (data.content && data.encoding === "base64") {
      text = fromB64(data.content);
    } else if (data.download_url) {
      const res = await fetch(`${data.download_url}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new GitHubError(res.status, `读取 ${path} 失败`);
      text = await res.text();
    }
    return { text, sha: data.sha, size: data.size, path: data.path };
  }

  async getJSON(path) {
    const file = await this.getFile(path);
    try {
      return { data: JSON.parse(file.text || "{}"), sha: file.sha, text: file.text };
    } catch {
      throw new GitHubError(500, `${path} 不是合法的 JSON`, file);
    }
  }

  async putFile(path, text, message, sha) {
    const body = {
      message,
      content: toB64(text),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    };
    return this.api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(path).replace(/#/g, "%23")}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async putBinary(path, base64, message, sha) {
    const body = { message, content: base64, branch: this.branch, ...(sha ? { sha } : {}) };
    return this.api(`/repos/${this.owner}/${this.repo}/contents/${encodeURI(path).replace(/#/g, "%23")}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  /* 检查令牌是否能往这个仓库写 */
  async check() {
    const info = await this.repoInfo();
    const canPush = Boolean(info?.permissions?.push || info?.permissions?.admin || info?.permissions?.maintain);
    return {
      ok: true,
      canPush,
      private: Boolean(info?.private),
      defaultBranch: info?.default_branch || "main",
      fullName: info?.full_name || this.slug,
      htmlUrl: info?.html_url || "",
    };
  }
}
