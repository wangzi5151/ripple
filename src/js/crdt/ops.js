/**
 * 操作（op）定义与全序。
 *
 * 整个系统只由一类东西构成：不可变的、自描述的 op。
 * 状态 = 对 op 集合做确定性折叠的结果，因此「合并」就等于集合并集 ——
 * 满足交换律、结合律、幂等律（见 tests/opset.test.mjs）。
 */

import { compareHlc, hlcToString } from './hlc.js';

/** op 类型表。payload 字段尽量短，因为 op 要塞进网络和本地存储。 */
export const OP = {
  /** 创建实体：{t:'mk', e, k, parent} */
  MAKE: 'mk',
  /** 删除实体：{t:'rm', e} */
  REMOVE: 'rm',
  /** 恢复实体：{t:'rs', e} */
  RESTORE: 'rs',
  /** LWW 字段写入：{t:'lw', e, p, v} */
  SET: 'lw',
  /** 文本插入：{t:'ti', d, a, c} */
  TEXT_INSERT: 'ti',
  /** 文本删除：{t:'td', d, e} */
  TEXT_DELETE: 'td',
  /** OR-Set 添加：{t:'oa', e, s, m, r} */
  SET_ADD: 'oa',
  /** OR-Set 删除：{t:'or', e, s, m, r:[addOpId...]} */
  SET_REMOVE: 'or',
};

const OP_KINDS = new Set(Object.values(OP));

export function makeOpId(node, seq) {
  return `${node}@${seq}`;
}

/**
 * 信封字段说明（尽量短，因为 op 要塞进网络和存储）：
 *   i = op id（"node@seq"）  n = 节点  q = 节点内序号  h = HLC  t = 类型
 * 载荷字段：e = 实体 id，k = 实体种类，p = 字段路径，v = 值，
 *   d = 文本文档 id，a = 插入位置的前驱元素，c = 字符，
 *   s = 集合名，m = 成员，r = 引用/观察到的 add op id。
 * 注意：序号用 q 而不是 s，避免与集合名 s 撞字段。
 */

export function parseOpId(id) {
  const at = id.lastIndexOf('@');
  return { node: id.slice(0, at), seq: Number(id.slice(at + 1)) };
}

/**
 * op 的全序：HLC 升序 → 节点名 → 序号。
 * 因为 (node, seq) 唯一，这个比较器不会返回 0（除非是同一个 op）。
 */
export function compareOps(a, b) {
  const c = compareHlc(a.h, b.h);
  if (c !== 0) return c;
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  if (a.q !== b.q) return a.q < b.q ? -1 : 1;
  return 0;
}

export function opSignature(op) {
  return `${hlcToString(op.h)}|${op.n}|${op.q}`;
}

export function validateOp(op) {
  if (!op || typeof op !== 'object') throw new Error('op must be an object');
  for (const field of ['i', 'n', 'q', 'h', 't']) {
    if (op[field] === undefined) throw new Error(`op missing field "${field}"`);
  }
  if (!OP_KINDS.has(op.t)) throw new Error(`unknown op type: ${op.t}`);
  if (typeof op.n !== 'string' || op.n.length === 0) throw new Error('op.n must be a non-empty string');
  if (!Number.isInteger(op.q) || op.q < 1) throw new Error('op.q must be a positive integer');
  if (!Array.isArray(op.h) || op.h.length !== 2 || !Number.isFinite(op.h[0]) || !Number.isFinite(op.h[1])) {
    throw new Error('op.h must be [wall, counter]');
  }
  if (op.i !== makeOpId(op.n, op.q)) throw new Error(`op.i mismatch: ${op.i} != ${makeOpId(op.n, op.q)}`);
  switch (op.t) {
    case OP.MAKE:
      if (!op.e || !op.k) throw new Error('mk requires e and k');
      break;
    case OP.REMOVE:
    case OP.RESTORE:
      if (!op.e) throw new Error(`${op.t} requires e`);
      break;
    case OP.SET:
      if (!op.e || !op.p || op.v === undefined) throw new Error('lw requires e, p, v');
      break;
    case OP.TEXT_INSERT:
      if (!op.d || typeof op.c !== 'string' || op.c.length === 0) throw new Error('ti requires d and c');
      break;
    case OP.TEXT_DELETE:
      if (!op.d || !op.e) throw new Error('td requires d and e');
      break;
    case OP.SET_ADD:
      // r（tag）可省略：省略时用 op 自身的 id 作为 tag，天然全局唯一。
      if (!op.e || !op.s || !op.m) throw new Error('oa requires e, s, m');
      break;
    case OP.SET_REMOVE:
      if (!op.e || !op.s || !op.m || !Array.isArray(op.r)) throw new Error('or requires e, s, m, r[]');
      break;
    default:
      break;
  }
  return true;
}

/** op 的唯一标识字段（校验后可用）。 */
export function opKey(op) {
  return op.i;
}

/** 版本向量：{node: 已见过的最大 seq} */
export function versionOf(ops) {
  const version = Object.create(null);
  for (const op of ops) {
    const seen = version[op.n] ?? 0;
    if (op.q > seen) version[op.n] = op.q;
  }
  return version;
}

/** 对方缺少的 op：按 (node, seq) 与对方版本向量比较。 */
export function opsMissingFrom(ops, remoteVersion) {
  const out = [];
  for (const op of ops) {
    const known = remoteVersion?.[op.n] ?? 0;
    if (op.q > known) out.push(op);
  }
  return out.sort(compareOps);
}

/** 版本向量比较：'equal' | 'ahead' | 'behind' | 'concurrent' */
export function compareVersions(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  let aAhead = false;
  let bAhead = false;
  for (const key of keys) {
    const av = a?.[key] ?? 0;
    const bv = b?.[key] ?? 0;
    if (av > bv) aAhead = true;
    if (bv > av) bAhead = true;
  }
  if (aAhead && bAhead) return 'concurrent';
  if (aAhead) return 'ahead';
  if (bAhead) return 'behind';
  return 'equal';
}

/** 找出 version 中缺失的区间描述，便于日志与 UI 展示。 */
export function versionSummary(version) {
  const parts = Object.entries(version ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([node, seq]) => `${node}:${seq}`);
  return parts.length ? parts.join(' ') : '(empty)';
}

export function cloneOp(op) {
  return { ...op, h: [op.h[0], op.h[1]], ...(Array.isArray(op.r) ? { r: [...op.r] } : {}) };
}
