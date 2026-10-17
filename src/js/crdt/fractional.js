/**
 * 分数排序键（fractional indexing）。
 *
 * 卡片／列的排序不用「整数 position」，而用一个可比较的字符串键：
 * 在 a 和 b 之间插入只需要生成一个新键，其它元素的键完全不用改，
 * 于是并发移动的合并退化成一次 LWW 写入 —— 不需要重排整个列表。
 *
 * 不变量：
 *  1. 键的字符集是 base62，其 ASCII 顺序与字典序一致；
 *  2. 生成的键永远不以最低位字符 '0' 结尾（否则上方再无插入空间）；
 *  3. null 表示「无界」，between(null, null) 取中间键。
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const LOW = DIGITS[0];
const MID = DIGITS[Math.floor(BASE / 2)];

function digitIndex(ch) {
  const i = DIGITS.indexOf(ch);
  if (i < 0) throw new Error(`order key contains invalid char: ${JSON.stringify(ch)}`);
  return i;
}

function assertKey(key, label) {
  if (key === null || key === undefined) return;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`${label} must be null or a non-empty base62 string`);
  }
  for (const ch of key) digitIndex(ch);
  if (key.endsWith(LOW)) throw new Error(`${label} must not end with "0": ${key}`);
}

/**
 * 规范化后的中点算法：a < b，a 用 '' 表示 -∞，b 用 null 表示 +∞。
 */
function midpoint(a, b) {
  if (b !== null && !(a < b)) throw new Error(`order keys out of order: ${a} !< ${b}`);
  if (a.endsWith(LOW) || (b !== null && b.endsWith(LOW))) {
    throw new Error('order keys must not end with "0"');
  }
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? LOW) === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a.length > 0 ? digitIndex(a[0]) : 0;
  const digitB = b !== null ? digitIndex(b[0]) : BASE;
  if (digitB - digitA > 1) {
    const m = Math.floor((digitA + digitB) / 2);
    return DIGITS[m];
  }
  if (a.length > 1) return a.slice(0, 1) + midpoint(a.slice(1), null);
  return DIGITS[digitA] + midpoint('', null);
}

/**
 * 生成一个严格位于 a 和 b 之间的排序键。
 * @param {string|null} a 下界（null = -∞）
 * @param {string|null} b 上界（null = +∞）
 */
export function between(a = null, b = null) {
  assertKey(a, 'a');
  assertKey(b, 'b');
  if (a !== null && b !== null && !(a < b)) {
    throw new Error(`order keys out of order: ${a} !< ${b}`);
  }
  return midpoint(a ?? '', b ?? null);
}

function fill(a, b, n, out) {
  if (n <= 0) return;
  if (n === 1) {
    out.push(between(a, b));
    return;
  }
  const pivot = between(a, b);
  const left = Math.floor((n - 1) / 2);
  fill(a, pivot, left, out);
  out.push(pivot);
  fill(pivot, b, n - 1 - left, out);
}

/** 批量生成 n 个位于 a、b 之间、按升序排列的键。 */
export function betweenMany(a, b, n) {
  const out = [];
  fill(a ?? null, b ?? null, n, out);
  return out;
}

/** 追加到末尾：between(last, null) */
export function after(last) {
  return between(last ?? null, null);
}

/** 插到最前：between(null, first) */
export function before(first) {
  return between(null, first ?? null);
}

export function compareOrder(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

export function isValidOrderKey(key) {
  try {
    assertKey(key, 'key');
    return typeof key === 'string' && key.length > 0;
  } catch {
    return false;
  }
}

export { DIGITS, BASE, MID };
