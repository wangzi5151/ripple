/**
 * Doc —— 系统的核心：一个「操作集合 + 确定性折叠」的 CRDT 引擎。
 *
 * 三条不变量（tests/doc.test.mjs 会逐条验证）：
 *  1. 状态是 op 集合的函数：同样的 op 集合无论以什么顺序应用，结果完全相同；
 *  2. 合并 = 集合并集：交换律、结合律、幂等律自动成立；
 *  3. 增量 apply 与「重放」（把 op 排序后从头折叠）结果一致。
 *
 * 状态里三种 CRDT 语义：
 *  - 实体存活：LWW（mk / rm / rs 按 (wall, counter, node, seq) 全序取胜者）
 *  - 字段：LWW register，键为 (实体, 路径)
 *  - 标签等集合：OR-Set（add 带唯一 tag，remove 记录它观察到的 tag → 并发 add 胜出）
 *  - 正文文本：RGA（"插在某元素之后" + 墓碑删除），子节点按 (wall,counter,node,seq) 排序
 *
 * 快照（snapshot）是同一套状态的紧凑形式，它同样带着全序时间戳，
 * 因此「用快照做状态合并」和「应用 op」走的是同一批 mutator，天然幂等、可交换。
 */

import { createClock } from './hlc.js';
import { OP, compareOps, makeOpId, validateOp, versionOf, opsMissingFrom } from './ops.js';

export const SNAPSHOT_VERSION = 1;

/** 全序时间戳：[wall, counter, node, seq] */
export function compareStamp(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  if (a[3] !== b[3]) return a[3] < b[3] ? -1 : 1;
  return 0;
}

export function stampOfOp(op) {
  return [op.h[0], op.h[1], op.n, op.q];
}

export function stampGreater(a, b) {
  return b === null || b === undefined || compareStamp(a, b) > 0;
}

const SEP = '\u0000';
function setKey(entityId, setName, member) {
  return `${entityId}${SEP}${setName}${SEP}${member}`;
}
function splitSetKey(key) {
  const [e, s, ...rest] = key.split(SEP);
  return { e, s, m: rest.join(SEP) };
}

/* ------------------------------------------------------------------ */
/* 稳定序列化与哈希（同构：Node 与浏览器都能跑）                        */
/* ------------------------------------------------------------------ */

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** FNV-1a 64 位，仅为比较状态是否一致，非密码学用途。 */
export function hashString(input) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/* ------------------------------------------------------------------ */
/* Doc                                                                 */
/* ------------------------------------------------------------------ */

export class Doc {
  /**
   * @param {{node: string, clock?: object, seq?: number}} options
   */
  constructor(options = {}) {
    if (!options.node) throw new Error('Doc requires a node id');
    this.node = options.node;
    this.clock = options.clock ?? createClock(options.node);
    this.seq = options.seq ?? 0;

    /** @type {Map<string, object>} opId -> op */
    this.opMap = new Map();
    /** @type {Map<string, object>} 实体 id -> 实体状态 */
    this.entities = new Map();
    /** @type {Map<string, object>} 集合键 -> OR-Set 状态 */
    this.sets = new Map();
    /** @type {Map<string, object>} 文本 id -> RGA 状态 */
    this.texts = new Map();
    this.dirtyTexts = new Set();
    this.renderCache = new Map();
  }

  /* ---------------- op 生命周期 ---------------- */

  /**
   * 生成一个本地 op：推进 HLC、占用序号、立刻应用。
   * @param {string} type
   * @param {object} payload
   */
  mint(type, payload) {
    const h = this.clock.tick();
    this.seq += 1;
    const op = { i: makeOpId(this.node, this.seq), n: this.node, q: this.seq, h, t: type, ...payload };
    validateOp(op);
    this.applyOp(op, { local: true });
    return op;
  }

  hasOp(opId) {
    return this.opMap.has(opId);
  }

  /**
   * 应用一个 op（本地或远端）。
   * @returns {boolean} 是否产生了新信息（重复 op 返回 false）
   */
  applyOp(op, meta = {}) {
    validateOp(op);
    if (this.opMap.has(op.i)) return false;
    if (!meta.local) {
      this.clock.observe(op.h);
      const { seq } = parseSeq(op);
      if (op.n === this.node && seq > this.seq) this.seq = seq;
    }
    this.opMap.set(op.i, op);
    const stamp = stampOfOp(op);
    switch (op.t) {
      case OP.MAKE:
        this.mutateEntity(stamp, op.e, { kind: op.k, parent: op.parent ?? null, alive: true });
        break;
      case OP.REMOVE:
        this.mutateEntity(stamp, op.e, { alive: false });
        break;
      case OP.RESTORE:
        this.mutateEntity(stamp, op.e, { alive: true });
        break;
      case OP.SET:
        this.mutateField(stamp, op.e, op.p, op.v);
        break;
      case OP.TEXT_INSERT:
        this.mutateTextInsert(stamp, op.d, op.i, op.a ?? null, op.c);
        break;
      case OP.TEXT_DELETE:
        this.mutateTextDelete(op.d, op.e);
        break;
      case OP.SET_ADD:
        this.mutateSetAdd(op.e, op.s, op.m, op.r ?? op.i);
        break;
      // tag 默认取 op id：同一个 op 在所有副本上 tag 相同，remove 才能精确观察它
      case OP.SET_REMOVE:
        this.mutateSetRemove(op.e, op.s, op.m, op.r ?? []);
        break;
      default:
        throw new Error(`unhandled op type: ${op.t}`);
    }
    return true;
  }

  addOps(ops) {
    let added = 0;
    for (const op of [...ops].sort(compareOps)) {
      if (this.applyOp(op)) added += 1;
    }
    return added;
  }

  /** 已保存的 op，按全序排列。 */
  allOps() {
    return [...this.opMap.values()].sort(compareOps);
  }

  get opCount() {
    return this.opMap.size;
  }

  version() {
    return versionOf(this.opMap.values());
  }

  opsMissingFrom(remoteVersion) {
    return opsMissingFrom(this.opMap.values(), remoteVersion);
  }

  /* ---------------- 状态 mutator（与 op 顺序无关） ---------------- */

  mutateEntity(stamp, id, patch) {
    let ent = this.entities.get(id);
    if (!ent) {
      ent = {
        id,
        kind: patch.kind ?? null,
        kindStamp: patch.kind === undefined ? null : stamp,
        parent: patch.parent ?? null,
        parentStamp: patch.parent === undefined ? null : stamp,
        alive: false,
        aliveStamp: null,
        created: stamp,
        fields: new Map(),
      };
      this.entities.set(id, ent);
    }
    if (patch.kind !== undefined && stampGreater(stamp, ent.kindStamp)) {
      ent.kind = patch.kind;
      ent.kindStamp = stamp;
    }
    if (patch.parent !== undefined && stampGreater(stamp, ent.parentStamp)) {
      ent.parent = patch.parent;
      ent.parentStamp = stamp;
    }
    if (patch.alive !== undefined && stampGreater(stamp, ent.aliveStamp)) {
      ent.alive = patch.alive;
      ent.aliveStamp = stamp;
    }
    if (compareStamp(stamp, ent.created) < 0) ent.created = stamp;
    return ent;
  }

  mutateField(stamp, entityId, path, value) {
    const ent = this.mutateEntity(stamp, entityId, {});
    const current = ent.fields.get(path);
    if (!current || stampGreater(stamp, current.stamp)) {
      ent.fields.set(path, { v: value, stamp });
    }
  }

  mutateTextInsert(stamp, docId, elemId, after, char) {
    const text = this.ensureText(docId);
    if (text.elems.has(elemId)) return;
    const elem = { id: elemId, char, parent: after, stamp, kids: [] };
    text.elems.set(elemId, elem);
    if (after === null || after === undefined) {
      insertSorted(text.roots, elem, text.elems);
    } else {
      const parent = text.elems.get(after);
      if (parent) {
        insertSorted(parent.kids, elem, text.elems);
      } else {
        // 前驱未知（例如已被裁剪）：退化为根节点，保证不丢字符。
        text.orphans.push(elem);
        insertSorted(text.roots, elem, text.elems);
      }
    }
    this.dirtyTexts.add(docId);
  }

  mutateTextDelete(docId, elemId) {
    const text = this.ensureText(docId);
    const elem = text.elems.get(elemId);
    if (!elem || elem.char === null) return;
    elem.char = null;
    this.dirtyTexts.add(docId);
  }

  mutateSetAdd(entityId, setName, member, tag) {
    const key = setKey(entityId, setName, member);
    let entry = this.sets.get(key);
    if (!entry) {
      entry = { addTags: new Set(), removedTags: new Set() };
      this.sets.set(key, entry);
    }
    entry.addTags.add(tag);
  }

  mutateSetRemove(entityId, setName, member, observedTags) {
    const key = setKey(entityId, setName, member);
    let entry = this.sets.get(key);
    if (!entry) {
      entry = { addTags: new Set(), removedTags: new Set() };
      this.sets.set(key, entry);
    }
    for (const tag of observedTags) entry.removedTags.add(tag);
  }

  ensureText(docId) {
    let text = this.texts.get(docId);
    if (!text) {
      text = { id: docId, elems: new Map(), roots: [], orphans: [], version: 0 };
      this.texts.set(docId, text);
    }
    return text;
  }

  /* ---------------- 读取状态 ---------------- */

  isAlive(entityId) {
    return this.entities.get(entityId)?.alive === true;
  }

  getEntity(entityId) {
    return this.entities.get(entityId);
  }

  /** 实体字段的普通对象视图。 */
  fields(entityId) {
    const ent = this.entities.get(entityId);
    const out = {};
    if (!ent) return out;
    for (const [path, cell] of ent.fields) out[path] = cell.v;
    return out;
  }

  field(entityId, path, fallback = undefined) {
    const cell = this.entities.get(entityId)?.fields.get(path);
    return cell ? cell.v : fallback;
  }

  /** 某父实体下的活子实体，按 order 字段排序。 */
  childrenOf(parentId, filter = null) {
    const out = [];
    for (const ent of this.entities.values()) {
      if (!ent.alive) continue;
      if (ent.parent !== parentId) continue;
      if (filter && !filter(ent)) continue;
      out.push(ent);
    }
    return out.sort((a, b) => {
      const oa = a.fields.get('order')?.v ?? null;
      const ob = b.fields.get('order')?.v ?? null;
      if (oa !== ob) return oa === null ? -1 : ob === null ? 1 : oa < ob ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** 活着的成员（OR-Set 语义：观察到的 add 都被 remove 掉才算删除）。 */
  setMembers(entityId, setName) {
    const out = [];
    for (const [key, entry] of this.sets) {
      const { e, s, m } = splitSetKey(key);
      if (e !== entityId || s !== setName) continue;
      let live = false;
      for (const tag of entry.addTags) {
        if (!entry.removedTags.has(tag)) {
          live = true;
          break;
        }
      }
      if (live) out.push(m);
    }
    return out.sort();
  }

  /** 该成员当前所有「活着的」add tag，删除时要把它们一起观察掉。 */
  setAddTags(entityId, setName, member) {
    const entry = this.sets.get(setKey(entityId, setName, member));
    if (!entry) return [];
    return [...entry.addTags].filter((t) => !entry.removedTags.has(t)).sort();
  }

  /** RGA 渲染：可见元素按顺序拼接。 */
  text(docId) {
    if (!this.dirtyTexts.has(docId) && this.renderCache.has(docId)) return this.renderCache.get(docId);
    const text = this.texts.get(docId);
    let out = '';
    if (text) {
      const walk = (elem) => {
        if (elem.char !== null) out += elem.char;
        for (const kid of elem.kids) walk(kid);
      };
      for (const root of text.roots) walk(root);
    }
    this.dirtyTexts.delete(docId);
    this.renderCache.set(docId, out);
    return out;
  }

  /** 可见元素的 id，按渲染顺序（文本编辑需要它来决定 "after"）。 */
  textElements(docId) {
    const text = this.texts.get(docId);
    const out = [];
    if (!text) return out;
    const walk = (elem) => {
      if (elem.char !== null) out.push(elem.id);
      for (const kid of elem.kids) walk(kid);
    };
    for (const root of text.roots) walk(root);
    return out;
  }

  /** 全部实体（含已删除），按 id 排序 —— 便于调试与快照。 */
  allEntities() {
    return [...this.entities.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /* ---------------- 快照 ---------------- */

  /**
   * 紧凑快照。它保留了元素 id 与全序时间戳，因此新 op 仍可引用快照里的元素 id，
   * 也能与快照做状态合并（mergeSnapshot）。
   */
  snapshot() {
    const entities = this.allEntities().map((ent) => [
      ent.id,
      ent.kind,
      ent.parent,
      ent.alive ? 1 : 0,
      ent.aliveStamp,
      [...ent.fields.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, cell]) => [path, cell.v, cell.stamp]),
    ]);
    const sets = [];
    for (const [key, entry] of [...this.sets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const { e, s, m } = splitSetKey(key);
      sets.push([e, s, m, [...entry.addTags].sort(), [...entry.removedTags].sort()]);
    }
    const texts = [];
    for (const [docId, text] of [...this.texts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      // 元素按 id 排序输出：否则 Map 的插入顺序会让「等价状态」产生不同指纹。
      texts.push([
        docId,
        [...text.elems.values()]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((el) => [el.id, el.char, el.parent, el.stamp]),
      ]);
    }
    return {
      v: SNAPSHOT_VERSION,
      node: this.node,
      clock: this.clock.state,
      version: this.version(),
      entities,
      sets,
      texts,
    };
  }

  /** 把快照（或别人给的状态）合并进来：走与 op 相同的 mutator，幂等且可交换。 */
  mergeSnapshot(snapshot, options = {}) {
    if (!snapshot || snapshot.v !== SNAPSHOT_VERSION) {
      throw new Error(`unsupported snapshot version: ${snapshot?.v}`);
    }
    this.clock.advance(snapshot.clock ?? [0, 0]);
    for (const [id, kind, parent, alive, aliveStamp, fields] of snapshot.entities ?? []) {
      const created = fields.length > 0 ? fields[0][2] : aliveStamp;
      const ent = this.mutateEntity(aliveStamp ?? created, id, {
        kind,
        parent,
        alive: Boolean(alive),
      });
      if (compareStamp(created, ent.created) < 0) ent.created = created;
      for (const [path, value, stamp] of fields) this.mutateField(stamp, id, path, value);
    }
    for (const [e, s, m, addTags, removedTags] of snapshot.sets ?? []) {
      for (const tag of addTags) this.mutateSetAdd(e, s, m, tag);
      if (removedTags?.length) this.mutateSetRemove(e, s, m, removedTags);
    }
    for (const [docId, elems] of snapshot.texts ?? []) {
      // 先建节点再挂父子关系，避免父元素尚未出现。
      for (const [id, char, parent, stamp] of elems) {
        const text = this.ensureText(docId);
        if (text.elems.has(id)) {
          const existing = text.elems.get(id);
          if (existing.char !== null && char === null) existing.char = null;
        } else {
          text.elems.set(id, { id, char, parent, stamp, kids: [] });
        }
      }
      const text = this.ensureText(docId);
      for (const elem of [...text.elems.values()]) {
        if (elem.parent === null || !text.elems.has(elem.parent)) {
          if (!text.roots.includes(elem)) text.roots.push(elem);
        }
      }
      sortTree(text);
      this.dirtyTexts.add(docId);
    }
    if (options.mergeOps === true && snapshot.ops) this.addOps(snapshot.ops);
    return this;
  }

  static fromSnapshot(snapshot, options = {}) {
    const doc = new Doc({ node: options.node ?? snapshot.node, seed: options.seed });
    doc.mergeSnapshot(snapshot);
    if (options.ops) doc.addOps(options.ops);
    return doc;
  }

  /* ---------------- 序列化 ---------------- */

  toJSON() {
    return {
      v: SNAPSHOT_VERSION,
      node: this.node,
      clock: this.clock.state,
      seq: this.seq,
      ops: this.allOps(),
    };
  }

  static fromJSON(json, options = {}) {
    const doc = new Doc({ node: json.node ?? options.node, seq: 0 });
    doc.clock.advance(json.clock ?? [0, 0]);
    doc.addOps(json.ops ?? []);
    doc.seq = Math.max(json.seq ?? 0, ...(json.ops ?? []).filter((o) => o.n === doc.node).map((o) => o.q), 0);
    return doc;
  }

  /** 深拷贝（测试与「设备模拟器」用）。 */
  clone(node = this.node) {
    const doc = new Doc({ node, seq: this.seq });
    doc.clock.advance(this.clock.state);
    doc.mergeSnapshot(this.snapshot());
    doc.addOps(this.allOps());
    doc.seq = this.seq;
    return doc;
  }

  /**
   * 状态指纹：只覆盖「共享状态」本身（实体、集合、文本），
   * 不含 node / clock / version 这些副本本地元数据 —— 否则各副本永远不可能相等。
   */
  stateHash() {
    const snap = this.snapshot();
    return hashString(stableStringify({ entities: snap.entities, sets: snap.sets, texts: snap.texts }));
  }

  /** 完整快照指纹（含元数据），用于确认同一设备重启后完全一致。 */
  snapshotHash() {
    return hashString(stableStringify(this.snapshot()));
  }

  /** 人类可读的状态摘要（历史时间线、审计视图用）。 */
  stats() {
    let alive = 0;
    let tombstones = 0;
    for (const ent of this.entities.values()) {
      if (ent.alive) alive += 1;
      else tombstones += 1;
    }
    let chars = 0;
    for (const docId of this.texts.keys()) chars += this.text(docId).length;
    return {
      node: this.node,
      ops: this.opMap.size,
      entities: this.entities.size,
      alive,
      tombstones,
      sets: this.sets.size,
      texts: this.texts.size,
      chars,
      version: this.version(),
    };
  }
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function parseSeq(op) {
  const at = op.i.lastIndexOf('@');
  return { seq: Number(op.i.slice(at + 1)) };
}

/**
 * RGA 的兄弟排序规则：同一锚点下，时间戳更大的（更晚插入的）排在前面，
 * 这样「在 X 之后插入」得到的元素紧贴 X，而不是跑到 X 已有子树的后面。
 * 该顺序只依赖时间戳，与到达顺序无关，因此并发插入时各副本结果一致。
 */
function insertSorted(list, elem, elems) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareStamp(elem.stamp, list[mid].stamp) < 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, elem);
  void elems;
}

/** 降序比较：时间戳大的在前。 */
export function compareStampDesc(a, b) {
  return compareStamp(b, a);
}

function sortTree(text) {
  const byStamp = compareStampDesc;
  const seen = new Set();
  const sortKids = (elem) => {
    if (seen.has(elem.id)) return;
    seen.add(elem.id);
    elem.kids.sort(byStamp);
    for (const kid of elem.kids) sortKids(kid);
  };
  // 重建 kids：清空后按 parent 重新挂载，保证幂等。
  for (const elem of text.elems.values()) elem.kids = [];
  text.roots = [];
  for (const elem of text.elems.values()) {
    if (elem.parent !== null && text.elems.has(elem.parent)) {
      text.elems.get(elem.parent).kids.push(elem);
    } else {
      text.roots.push(elem);
    }
  }
  text.roots.sort(byStamp);
  for (const root of text.roots) sortKids(root);
}

export { setKey, splitSetKey };
