/* 密码学相关：PBKDF2-SHA256 派生校验值，浏览器 WebCrypto 完成
   - 仓库里只保存 salt + 派生出的哈希，不保存明文，也无法反推
   - 迭代次数写进配置，将来可以平滑提高 */

export const ITERATIONS = 600000;
export const MIN_LENGTH = 10;

function toB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(str) {
  const bin = atob(String(str || "").replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password, salt, iterations) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    256
  );
  return new Uint8Array(bits);
}

function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function makeAuth(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = ITERATIONS;
  const hash = await derive(password, salt, iterations);
  return {
    algo: "PBKDF2-SHA256",
    iterations,
    salt: toB64(salt),
    hash: toB64(hash),
    createdAt: new Date().toISOString(),
  };
}

export async function verifyPassword(password, auth) {
  if (!auth || !auth.salt || !auth.hash) return false;
  const iterations = Number(auth.iterations) || ITERATIONS;
  const hash = await derive(password, fromB64(auth.salt), iterations);
  return equal(hash, fromB64(auth.hash));
}

/* 密码强度：只做提示，不替用户做主 */
export function strength(password) {
  const p = String(password || "");
  let score = 0;
  if (p.length >= MIN_LENGTH) score++;
  if (p.length >= 14) score++;
  if (p.length >= 18) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p)) score++;
  if (/^(.)\1+$/.test(p) || /^(?:0123|1234|abcd|qwer|password|admin)/i.test(p)) score = 0;

  const level = score <= 1 ? 0 : score <= 3 ? 1 : score <= 4 ? 2 : 3;
  return [
    { level: 0, label: "太短了", hint: "至少 10 位，建议 16 位以上" },
    { level: 1, label: "偏弱", hint: "再长一点，或混入数字和符号" },
    { level: 2, label: "不错", hint: "已经很安全了" },
    { level: 3, label: "很强", hint: "这个密码很难被暴力破解" },
  ][level];
}

/* 生成一个好记的口令短语，降低用户随手写 123456 的概率 */
export function suggestPassword() {
  const a = ["小满", "青柠", "雨天", "云朵", "橘子", "晚风", "星野", "薄荷", "猫尾", "纸鸢", "春日", "海盐"];
  const b = ["面包", "汽水", "糖果", "月亮", "电车", "信箱", "风筝", "枕头", "花园", "灯塔", "唱片", "贝壳"];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const num = String(Math.floor(Math.random() * 9000) + 1000);
  const sym = "!@#$%&*"[Math.floor(Math.random() * 7)];
  return `${pick(a)}${pick(b)}${num}${sym}`;
}
