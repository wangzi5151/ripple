import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OP,
  makeOpId,
  parseOpId,
  compareOps,
  validateOp,
  versionOf,
  opsMissingFrom,
  compareVersions,
  versionSummary,
  cloneOp,
} from '../src/js/crdt/ops.js';

function op(node, seq, type, payload = {}, h = [1_000 + seq, 0]) {
  return { i: makeOpId(node, seq), n: node, q: seq, h, t: type, ...payload };
}

test('makeOpId / parseOpId 往返', () => {
  const id = makeOpId('phone-1', 17);
  assert.equal(id, 'phone-1@17');
  assert.deepEqual(parseOpId(id), { node: 'phone-1', seq: 17 });
});

test('validateOp 接受合法 op 并指出缺失字段', () => {
  assert.equal(validateOp(op('A', 1, OP.MAKE, { e: 'card1', k: 'card' })), true);
  assert.equal(validateOp(op('A', 2, OP.SET, { e: 'card1', p: 'title', v: '买菜' })), true);
  assert.equal(validateOp(op('A', 3, OP.TEXT_INSERT, { d: 'card1/note', a: null, c: 'x' })), true);
  assert.equal(validateOp(op('A', 4, OP.SET_ADD, { e: 'card1', s: 'tags', m: '工作', r: 'A@4' })), true);

  assert.throws(() => validateOp({ n: 'A', s: 1, h: [1, 0], t: OP.MAKE }), /missing field/);
  assert.throws(() => validateOp(op('A', 1, 'nope', {})), /unknown op type/);
  assert.throws(() => validateOp(op('A', 0, OP.MAKE, { e: 'x', k: 'card' })), /positive integer/);
  // 载荷里的 s（集合名）不能和信封里的 q（序号）互相污染
  const orSet = op('A', 5, OP.SET_ADD, { e: 'x', s: 'tags', m: 't', r: 'A@5' });
  assert.equal(orSet.q, 5);
  assert.equal(orSet.s, 'tags');
  assert.equal(validateOp(orSet), true);
  assert.throws(() => validateOp({ ...op('A', 1, OP.MAKE, { e: 'x', k: 'card' }), i: 'A@9' }), /mismatch/);
  assert.throws(() => validateOp({ ...op('A', 1, OP.MAKE, { e: 'x', k: 'card' }), h: [1] }), /\[wall, counter\]/);
  assert.throws(() => validateOp(op('A', 1, OP.TEXT_DELETE, { d: 'x' })), /td requires/);
});

test('compareOps 给出与插入顺序无关的全序', () => {
  const ops = [
    op('b', 1, OP.MAKE, { e: 'x', k: 'card' }, [10, 0]),
    op('a', 2, OP.MAKE, { e: 'y', k: 'card' }, [10, 0]),
    op('a', 1, OP.MAKE, { e: 'z', k: 'card' }, [10, 0]),
    op('c', 1, OP.MAKE, { e: 'w', k: 'card' }, [9, 5]),
  ];
  const shuffled = [ops[2], ops[3], ops[0], ops[1]];
  const a = [...ops].sort(compareOps).map((o) => o.i);
  const b = [...shuffled].sort(compareOps).map((o) => o.i);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['c@1', 'a@1', 'a@2', 'b@1']);
  assert.equal(compareOps(ops[0], ops[0]), 0);
  assert.equal(compareOps(ops[0], cloneOp(ops[0])), 0);
});

test('版本向量：计算、缺失 op、比较', () => {
  const ops = [op('A', 1, OP.MAKE, { e: 'x', k: 'card' }), op('A', 2, OP.REMOVE, { e: 'x' }), op('B', 1, OP.MAKE, { e: 'y', k: 'card' })];
  const v = versionOf(ops);
  assert.deepEqual({ ...v }, { A: 2, B: 1 });
  assert.equal(versionSummary(v), 'A:2 B:1');

  const missing = opsMissingFrom(ops, { A: 1, B: 1 });
  assert.deepEqual(missing.map((o) => o.i), ['A@2']);
  assert.equal(opsMissingFrom(ops, { A: 9, B: 9 }).length, 0);

  assert.equal(compareVersions({ A: 1 }, { A: 1 }), 'equal');
  assert.equal(compareVersions({ A: 2 }, { A: 1 }), 'ahead');
  assert.equal(compareVersions({ A: 1 }, { A: 2 }), 'behind');
  assert.equal(compareVersions({ A: 1, B: 5 }, { A: 2 }), 'concurrent');
});

test('cloneOp 不共享可变数组', () => {
  const original = op('A', 1, OP.SET_REMOVE, { e: 'x', s: 'tags', m: 'x', r: ['A@1'] });
  const copy = cloneOp(original);
  copy.r.push('B@2');
  copy.h[0] = 0;
  assert.deepEqual(original.r, ['A@1']);
  assert.notEqual(original.h[0], 0);
});
