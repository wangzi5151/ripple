/**
 * 端到端加密（可选）。
 *
 * 房间密钥只存在于 URL 片段（#k=…）或本机存储里，永远不发给服务器。
 * 服务器看到的房间名是 `sha256(key | roomName)` 的截断哈希 —— 无法反推密钥，
 * 也无法用字典猜房间名（除非猜到密钥）。op 的载荷（t 与业务字段）加密后装在
 * `d` 里；信封字段 i/n/q/h 保持明文，这样服务器还能去重、排版本、做增量同步。
 *
 * 已知取舍（写进 docs/PROTOCOL.md）：
 *  - 中继能看到 op 的数量、时间戳、节点名与长度 —— 属于元数据泄露；
 *  - 想要完全隐藏元数据，需要换成固定的填充长度 + 私有中继。
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * 统一拿到 WebCrypto。
 * 浏览器与 Node 20+ 直接有 globalThis.crypto；
 * Node 18 的 ESM 里 globalThis.crypto 也可能缺席，于是动态按需引入 node:crypto
 * （只在检测到 Node 时才 import，浏览器打包不会带上它）。
 */
let cachedImpl = null;
async function webcrypto() {
  if (cachedImpl) return cachedImpl;
  const impl = globalThis.crypto;
  if (impl?.subtle && typeof impl.getRandomValues === 'function') {
    cachedImpl = impl;
    return cachedImpl;
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    const module = await import('node:crypto');
    cachedImpl = module.webcrypto;
    return cachedImpl;
  }
  throw new Error('当前环境缺少 WebCrypto（浏览器需要 HTTPS/localhost）');
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

function utf8String(bytes) {
  return new TextDecoder().decode(bytes);
}

export async function randomKey() {
  const bytes = new Uint8Array(KEY_BYTES);
  (await webcrypto()).getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function isValidKey(key) {
  try {
    return base64UrlToBytes(String(key)).length === KEY_BYTES;
  } catch {
    return false;
  }
}

/** 房间标识：服务器用它分组，但拿不到房间名与密钥。 */
export async function deriveRoomId(roomName, key = null) {
  const material = key ? `k:${key}|r:${roomName}` : `r:${roomName}`;
  const digest = await (await webcrypto()).subtle.digest('SHA-256', utf8Bytes(material));
  const bytes = new Uint8Array(digest).slice(0, 8);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function importKey(key) {
  const impl = await webcrypto();
  return impl.subtle.importKey('raw', base64UrlToBytes(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** 加密一批 op 的载荷，返回可直接上线的信封数组。 */
export async function encryptOps(key, ops) {
  if (!key) return ops;
  const cryptoKey = await importKey(key);
  const impl = await webcrypto();
  const out = [];
  for (const op of ops) {
    const iv = new Uint8Array(IV_BYTES);
    impl.getRandomValues(iv);
    const payload = { ...op };
    for (const field of ['i', 'n', 'q', 'h']) delete payload[field];
    const cipher = await impl.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, utf8Bytes(JSON.stringify(payload)));
    out.push({
      i: op.i,
      n: op.n,
      q: op.q,
      h: op.h,
      z: 1,
      iv: bytesToBase64Url(iv),
      d: bytesToBase64Url(new Uint8Array(cipher)),
    });
  }
  return out;
}

/** 解密一批信封；失败时抛出带 code 的错误，调用方可决定丢弃还是报错。 */
export async function decryptOps(key, wireOps) {
  if (!key) return wireOps;
  const cryptoKey = await importKey(key);
  const out = [];
  const impl = await webcrypto();
  for (const op of wireOps) {
    if (op.z !== 1) {
      out.push(op);
      continue;
    }
    try {
      const plain = await impl.subtle.decrypt(
        { name: 'AES-GCM', iv: base64UrlToBytes(op.iv) },
        cryptoKey,
        base64UrlToBytes(op.d),
      );
      out.push({ i: op.i, n: op.n, q: op.q, h: op.h, ...JSON.parse(utf8String(plain)) });
    } catch (cause) {
      const error = new Error(`无法解密 op ${op.i}：密钥不匹配或数据被截断`);
      error.code = 'decrypt_failed';
      error.cause = cause;
      throw error;
    }
  }
  return out;
}

/** URL 片段里的密钥：`#k=<key>` 或 `#room=xxx&k=<key>` */
export function parseFragment(hash, defaults = {}) {
  const text = String(hash ?? '').replace(/^#/, '');
  const params = new URLSearchParams(text);
  return {
    room: params.get('room') ?? defaults.room ?? 'ripple',
    key: params.get('k') ?? defaults.key ?? null,
    e2e: Boolean(params.get('k')) || defaults.e2e === true,
  };
}

export function buildFragment({ room, key }) {
  const params = new URLSearchParams();
  if (room) params.set('room', room);
  if (key) params.set('k', key);
  return `#${params.toString()}`;
}

export const __testing = { bytesToBase64Url, base64UrlToBytes };
