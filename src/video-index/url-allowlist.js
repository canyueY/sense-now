/**
 * url-allowlist.js — Bilibili URL SSRF 防护。
 * 仅允许 *.bilibili.com 的 HTTPS；拒绝 b23.tv 短链（yt-dlp 会先跟随重定向再返回 webpage_url）。
 */

const BILI_HOST = /^(?:[\w-]+\.)*(?:bilibili\.com)$/i;
const B23_HOST = /^(?:[\w-]+\.)*(?:b23\.tv)$/i;

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true;
  if (h === '::1' || h === '[::1]') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (h.includes(':')) {
    if (h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  }
  return false;
}

/**
 * 规范化并校验 Bilibili HTTPS URL。拒绝短链、非 HTTPS、内网/localhost。
 * @returns {string} href
 */
export function assertSafeBilibiliUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    const err = new Error('invalid bilibili url');
    err.code = 'BAD_URL';
    throw err;
  }
  if (u.protocol !== 'https:') {
    const err = new Error('bilibili url must be https');
    err.code = 'BAD_URL';
    throw err;
  }
  if (u.username || u.password) {
    const err = new Error('bilibili url must not include credentials');
    err.code = 'BAD_URL';
    throw err;
  }
  if (isPrivateOrLocalHost(u.hostname)) {
    const err = new Error('bilibili url host is forbidden');
    err.code = 'SSRF';
    throw err;
  }
  // 短链会在 yt-dlp 校验 webpage_url 之前就发起重定向请求 → 直接拒绝
  if (B23_HOST.test(u.hostname)) {
    const err = new Error('b23.tv short links are not allowed; use a full bilibili.com URL');
    err.code = 'SSRF';
    throw err;
  }
  if (!BILI_HOST.test(u.hostname)) {
    const err = new Error(`bilibili url host not allowed: ${u.hostname}`);
    err.code = 'SSRF';
    throw err;
  }
  u.hash = '';
  return u.href;
}

/** 校验 yt-dlp 返回的 webpage_url 仍在白名单内。 */
export function assertSafeBilibiliResultUrl(raw) {
  if (!raw) return null;
  return assertSafeBilibiliUrl(raw);
}

export function isAllowedBilibiliHost(hostname) {
  if (isPrivateOrLocalHost(hostname)) return false;
  if (B23_HOST.test(hostname)) return false;
  return BILI_HOST.test(hostname);
}
