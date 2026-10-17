import test from 'node:test';
import assert from 'node:assert/strict';

import { Doc, compareStamp, stampOfOp, hashString, stableStringify } from '../src/js/crdt/doc.js';
import { OP } from '../src/js/crdt/ops.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 构造一个带内容的看板，返回 {doc, ops} */
function seedBoard(node = 'seed') {
  const doc = new Doc({ node });
  doc.mint(OP.MAKE, { e: 'board', k: 'board' });
  doc.mint(OP.SET, { e: 'board', p: 'title', v: '发布计划' });
  doc.mint(OP.MAKE, { e: 'col-todo', k: 'column', parent: 'board' });
  doc.mint(OP.SET, { e: 'col-todo', p: 'title', v: '待办' });
  doc.mint(OP.SET, { e: 'col-todo', p: 'order', v: 'V' });
  doc.mint(OP.MAKE, { e: 'card-1', k: 'card', parent: 'col-todo' });
  doc.mint(OP.SET, { e: 'card-1', p: 'title', v: '写文档' });
  doc.mint(OP.SET, { e: 'card-1', p: 'order', v: 'V' });
  doc.mint(OP.SET_ADD, { e: 'card-1', s: 'tags', m: '文档', r: `${node}@${doc.seq}` });
  const chars = [...'第一版'];
  let after = null;
  for (const ch of chars) {
    const op = doc.mint(OP.TEXT_INSERT, { d: 'card-1/note', a: after, c: ch });
    after = op.i;
  }
  return { doc, ops: doc.allOps() };
}

test('LWW 字段：并发写入的结果与到达顺序无关', () => {
  const a = new Doc({ node: 'a' });
  const b = new Doc({ node: 'b' });
  a.mint(OP.MAKE, { e: 'c1', k: 'card' });
  b.mint(OP.MAKE, { e: 'c1', k: 'card' });
  a.mint(OP.SET, { e: 'c1', p: 'title', v: '标题 A' });
  b.mint(OP.SET, { e: 'c1', p: 'title', v: '标题 B' });

  // 双向同步：两人的 op 集合最终相同
  a.addOps(b.allOps());
  b.addOps(a.allOps());
  // 双方都选了时间戳更大的那次写入
  const writes = a.allOps().filter((op) => op.t === OP.SET);
  const winner = [...writes].sort((x, y) => compareStamp(stampOfOp(x), stampOfOp(y))).pop().v;
  assert.equal(a.field('c1', 'title'), winner);
  assert.equal(b.field('c1', 'title'), winner);
  assert.equal(a.stateHash(), b.stateHash());

  // 只交换对方「后写」的那条 op：值仍然一致，但状态指纹不同（op 集合不同）——
  // 这正说明收敛性来自相同的 op 集合，而不是「恰好读到同一个 Map」。
  const partialA = new Doc({ node: 'pa' });
  partialA.addOps(a.allOps().filter((op) => op.t === OP.SET));
  assert.equal(partialA.field('c1', 'title'), winner);
});

test('实体存活是 LWW：mk / rm / rs 的先后由时间戳决定', () => {
  const doc = new Doc({ node: 'a' });
  doc.mint(OP.MAKE, { e: 'c1', k: 'card' });
  assert.equal(doc.isAlive('c1'), true);
  const rm = doc.mint(OP.REMOVE, { e: 'c1' });
  assert.equal(doc.isAlive('c1'), false);

  const other = new Doc({ node: 'b' });
  other.addOps([...doc.allOps(), rm]);
  assert.equal(other.isAlive('c1'), false);

  doc.mint(OP.RESTORE, { e: 'c1' });
  assert.equal(doc.isAlive('c1'), true);
  other.addOps(doc.allOps());
  assert.equal(other.isAlive('c1'), true);

  // 先收到 rm/mk 的顺序颠倒也不影响结果
  const reordered = new Doc({ node: 'c' });
  reordered.addOps(shuffled(doc.allOps(), mulberry32(7)));
  assert.equal(reordered.isAlive('c1'), true);
  assert.equal(reordered.stateHash(), doc.stateHash());
});

test('OR-Set：观察到的 add 被删除，并发的 add 胜出', () => {
  const a = new Doc({ node: 'a' });
  const b = new Doc({ node: 'b' });
  const addA = a.mint(OP.SET_ADD, { e: 'c1', s: 'tags', m: '紧急', r: 'a@1' });
  b.addOps([addA]);
  assert.deepEqual(b.setMembers('c1', 'tags'), ['紧急']);

  // b 观察到 add 后删除
  const rmB = b.mint(OP.SET_REMOVE, {
    e: 'c1',
    s: 'tags',
    m: '紧急',
    r: b.setAddTags('c1', 'tags', '紧急'),
  });
  a.addOps([rmB]);
  assert.deepEqual(a.setMembers('c1', 'tags'), [], '观察到的添加应被删除');
  assert.deepEqual(b.setMembers('c1', 'tags'), []);

  // 并发：a 再次添加，b 基于旧观察删除 → 并发 add 胜出
  const addA2 = a.mint(OP.SET_ADD, { e: 'c1', s: 'tags', m: '紧急', r: 'a@9' });
  const rmB2 = b.mint(OP.SET_REMOVE, {
    e: 'c1',
    s: 'tags',
    m: '紧急',
    r: b.setAddTags('c1', 'tags', '紧急'),
  });
  a.addOps([rmB2]);
  b.addOps([addA2]);
  assert.deepEqual(a.setMembers('c1', 'tags'), ['紧急']);
  assert.deepEqual(b.setMembers('c1', 'tags'), ['紧急']);
  assert.equal(a.stateHash(), b.stateHash());
});

test('RGA 文本：顺序输入、删除与墓碑上的再插入', () => {
  const doc = new Doc({ node: 'a' });
  const ops = [];
  let after = null;
  for (const ch of [...'abcde']) {
    const op = doc.mint(OP.TEXT_INSERT, { d: 't', a: after, c: ch });
    ops.push(op);
    after = op.i;
  }
  assert.equal(doc.text('t'), 'abcde');
  assert.deepEqual(doc.textElements('t').map((id) => id.split('@')[1]), ['1', '2', '3', '4', '5']);

  // 删除 'c'（第 3 个元素），再在它之后插入 'X'
  const cId = doc.textElements('t')[2];
  doc.mint(OP.TEXT_DELETE, { d: 't', e: cId });
  assert.equal(doc.text('t'), 'abde');
  doc.mint(OP.TEXT_INSERT, { d: 't', a: cId, c: 'X' });
  assert.equal(doc.text('t'), 'abXde');
  assert.equal([...doc.text('t')].length, 5);
});

test('RGA 文本：同一位置并发插入的结果确定且一致', () => {
  const base = new Doc({ node: 'base' });
  const first = base.mint(OP.TEXT_INSERT, { d: 't', a: null, c: 'A' });
  const last = base.mint(OP.TEXT_INSERT, { d: 't', a: first.i, c: 'Z' });

  const x = new Doc({ node: 'x' });
  const y = new Doc({ node: 'y' });
  x.addOps(base.allOps());
  y.addOps(base.allOps());
  const ix = x.mint(OP.TEXT_INSERT, { d: 't', a: first.i, c: 'x' });
  const iy = y.mint(OP.TEXT_INSERT, { d: 't', a: first.i, c: 'y' });

  x.addOps([iy]);
  y.addOps([ix]);
  assert.equal(x.text('t'), y.text('t'));
  assert.equal(x.stateHash(), y.stateHash());
  assert.equal(x.text('t').length, 4);
  assert.ok(x.text('t').startsWith('A') && x.text('t').endsWith('Z'));
  void last;
});

test('RGA 文本：emoji 按码点保存，ZWJ 组合字形原样保留', () => {
  const doc = new Doc({ node: 'a' });
  let after = null;
  for (const ch of [...'👩‍💻账']) {
    const op = doc.mint(OP.TEXT_INSERT, { d: 't', a: after, c: ch });
    after = op.i;
  }
  assert.equal(doc.text('t'), '👩‍💻账');
  // 码点粒度：👩 + ZWJ + 💻 + 账
  assert.equal([...doc.text('t')].length, 4);
  // 已知取舍：RGA 以码点为单位，同位置并发编辑理论上可能拆开 ZWJ 序列。
  // 本用例确认在不同位置顺序输入时组合字形完好。
  const graphemes = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(doc.text('t'))];
  assert.equal(graphemes.length, 2);
});

test('幂等：同一批 op 应用两次不会改变状态', () => {
  const { ops } = seedBoard('seed');
  const doc = new Doc({ node: 'x' });
  const first = doc.addOps(ops);
  const hash = doc.stateHash();
  const second = doc.addOps(ops);
  assert.equal(first, ops.length);
  assert.equal(second, 0);
  assert.equal(doc.stateHash(), hash);
});

test('收敛：任意排列的同一 op 集合得到完全相同的状态', () => {
  const { doc: seed, ops } = seedBoard('seed');
  const rand = mulberry32(99);
  const hashes = new Set();
  for (let i = 0; i < 25; i += 1) {
    const doc = new Doc({ node: `r${i}` });
    doc.addOps(shuffled(ops, rand));
    hashes.add(doc.stateHash());
  }
  assert.equal(hashes.size, 1, `期望单一状态，实际 ${hashes.size} 种`);
  assert.equal([...hashes][0], seed.stateHash());
});

test('增量 apply 与「重放排序后的 op」结果一致', () => {
  const incremental = new Doc({ node: 'a' });
  incremental.mint(OP.MAKE, { e: 'b', k: 'board' });
  const other = new Doc({ node: 'b' });
  other.mint(OP.MAKE, { e: 'b', k: 'board' });
  const c1 = other.mint(OP.MAKE, { e: 'c1', k: 'card', parent: 'b' });
  const c2 = incremental.mint(OP.MAKE, { e: 'c2', k: 'card', parent: 'b' });
  incremental.addOps([c1]);
  incremental.mint(OP.SET, { e: 'c2', p: 'title', v: '并行' });
  other.addOps([c2]);
  other.mint(OP.SET, { e: 'c1', p: 'title', v: '另一个' });
  incremental.addOps(other.allOps());
  other.addOps(incremental.allOps());

  const replay = new Doc({ node: 'replay' });
  replay.addOps(incremental.allOps());
  assert.equal(replay.stateHash(), incremental.stateHash());
  assert.equal(replay.stateHash(), other.stateHash());
});

test('三副本并发编辑 + 乱序投递后收敛（随机 fuzz）', () => {
  const rand = mulberry32(2026);
  const { doc: seedDoc, ops: baseOps } = seedBoard('seed');
  let phase = baseOps;
  for (let round = 0; round < 12; round += 1) {
    const replicas = ['p1', 'p2', 'p3'].map((node) => {
      const doc = new Doc({ node });
      doc.addOps(phase);
      return doc;
    });
    // 每个副本在「离线」状态下各自编辑
    for (const [index, doc] of replicas.entries()) {
      const cardId = `card-${index + 1}`;
      doc.mint(OP.MAKE, { e: cardId, k: 'card', parent: 'col-todo' });
      doc.mint(OP.SET, { e: cardId, p: 'title', v: `任务 ${round}-${index}` });
      doc.mint(OP.SET_ADD, { e: cardId, s: 'tags', m: `tag${round}`, r: `${doc.node}@${doc.seq}` });
      doc.mint(OP.MAKE, { e: cardId, k: 'card', parent: 'col-todo' });
      doc.mint(OP.SET, { e: 'card-1', p: 'title', v: `改自 ${doc.node}` });
      const elem = doc.mint(OP.TEXT_INSERT, { d: 'card-1/note', a: null, c: String.fromCharCode(97 + index) });
      if (round % 3 === 0) doc.mint(OP.TEXT_DELETE, { d: 'card-1/note', e: elem.i });
      if (round % 4 === 0) doc.mint(OP.REMOVE, { e: cardId });
      if (round % 5 === 0) doc.mint(OP.RESTORE, { e: cardId });
    }
    // 网络：把所有 op 打乱后互相投递（含重复投递）
    const all = replicas.flatMap((doc) => doc.allOps());
    const wire = [...shuffled(all, rand), ...shuffled(all, rand).slice(0, 5)];
    for (const doc of replicas) doc.addOps(wire);
    const hashes = new Set(replicas.map((doc) => doc.stateHash()));
    assert.equal(hashes.size, 1, `第 ${round} 轮未收敛`);
    phase = replicas[0].allOps();
    void rand;
  }
  assert.ok(seedDoc.opCount > 0);
});

test('快照：导出/导入往返状态完全相同', () => {
  const { doc } = seedBoard('seed');
  const snap = doc.snapshot();
  const loaded = Doc.fromSnapshot(snap, { node: 'new-device' });
  assert.equal(loaded.stateHash(), doc.stateHash());
  assert.equal(loaded.text('card-1/note'), '第一版');
  assert.deepEqual(loaded.childrenOf('col-todo').map((e) => e.id), ['card-1']);
  assert.deepEqual(loaded.setMembers('card-1', 'tags'), ['文档']);
});

test('快照状态合并：晚到的并发 op 仍能正确挂到快照元素上', () => {
  const { doc: full } = seedBoard('seed');
  const snap = full.snapshot();
  const compacted = Doc.fromSnapshot(snap, { node: 'compact' });
  const attachPoint = compacted.textElements('card-1/note')[0];

  // 快照裁剪之后，另一台设备仍在编辑（引用快照里的元素 id）
  const online = Doc.fromSnapshot(snap, { node: 'online' });
  const late = online.mint(OP.TEXT_INSERT, { d: 'card-1/note', a: attachPoint, c: '！' });
  online.mint(OP.SET, { e: 'card-1', p: 'title', v: '写文档（在线）' });

  compacted.addOps([late, ...online.allOps()]);
  full.addOps([late, ...online.allOps()]);
  assert.equal(compacted.stateHash(), full.stateHash());
  assert.equal(compacted.text('card-1/note'), full.text('card-1/note'));
});

test('状态合并（mergeSnapshot）幂等且可交换', () => {
  const a = new Doc({ node: 'a' });
  const b = new Doc({ node: 'b' });
  a.mint(OP.MAKE, { e: 'x', k: 'card' });
  a.mint(OP.SET, { e: 'x', p: 'title', v: 'A 的标题' });
  b.mint(OP.MAKE, { e: 'x', k: 'card' });
  b.mint(OP.SET, { e: 'x', p: 'title', v: 'B 的标题' });
  b.mint(OP.MAKE, { e: 'y', k: 'card' });

  const ab = a.clone('ab');
  const ba = b.clone('ba');
  ab.mergeSnapshot(b.snapshot());
  ba.mergeSnapshot(a.snapshot());
  assert.equal(ab.stateHash(), ba.stateHash());

  const hash = ab.stateHash();
  ab.mergeSnapshot(b.snapshot());
  ab.mergeSnapshot(b.snapshot());
  assert.equal(ab.stateHash(), hash);
});

test('时间戳全序与稳定序列化 / 哈希工具的边界情况', () => {
  assert.ok(compareStamp([1, 0, 'a', 1], [1, 0, 'a', 2]) < 0);
  assert.ok(compareStamp([1, 0, 'b', 1], [1, 0, 'a', 9]) > 0);
  assert.ok(compareStamp([2, 0, 'a', 1], [1, 9, 'z', 9]) > 0);
  assert.equal(compareStamp([1, 1, 'a', 1], [1, 1, 'a', 1]), 0);
  assert.equal(stableStringify({ b: 1, a: [{ z: 1, y: 2 }] }), '{"a":[{"y":2,"z":1}],"b":1}');
  assert.equal(hashString(''), 'cbf29ce484222325');
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});

test('toJSON / fromJSON 往返并保留序号与时钟', () => {
  const { doc } = seedBoard('seed');
  doc.mint(OP.SET, { e: 'board', p: 'title', v: '改名' });
  const json = JSON.parse(JSON.stringify(doc.toJSON()));
  const restored = Doc.fromJSON(json);
  assert.equal(restored.stateHash(), doc.stateHash());
  assert.equal(restored.seq, doc.seq);
  const next = restored.mint(OP.SET, { e: 'board', p: 'subtitle', v: 'x' });
  assert.ok(next.q > doc.seq);
  assert.ok(next.h[0] > 0);
});
