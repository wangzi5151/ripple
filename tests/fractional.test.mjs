import test from 'node:test';
import assert from 'node:assert/strict';

import { between, betweenMany, after, before, isValidOrderKey } from '../src/js/crdt/fractional.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('between() 在无界区间给出中间键', () => {
  const k = between(null, null);
  assert.equal(isValidOrderKey(k), true);
  assert.ok(k > '0');
});

test('between() 严格位于上下界之间', () => {
  const cases = [
    [null, null],
    [null, 'V'],
    ['V', null],
    ['0V', '1'],
    ['0V', '1'],
    ['0001', '0002'],
    ['zzz', null],
    [null, '0001'],
  ];
  for (const [a, b] of cases) {
    const k = between(a, b);
    assert.equal(isValidOrderKey(k), true, `key=${k}`);
    if (a !== null) assert.ok(a < k, `${a} < ${k}`);
    if (b !== null) assert.ok(k < b, `${k} < ${b}`);
  }
});

test('反复二分插入仍然保持严格递增', () => {
  let lo = null;
  let hi = null;
  const keys = [];
  for (let i = 0; i < 200; i += 1) {
    const k = between(lo, hi);
    keys.push(k);
    assert.equal(isValidOrderKey(k), true);
  }
  // 每次把新区间收窄到 (k, hi)，同时检查嵌套序列递增
  const ascending = [];
  let a = null;
  let b = null;
  for (let i = 0; i < 100; i += 1) {
    const k = between(a, b);
    ascending.push(k);
    a = k;
  }
  for (let i = 1; i < ascending.length; i += 1) {
    assert.ok(ascending[i - 1] < ascending[i], `${ascending[i - 1]} < ${ascending[i]}`);
  }
});

test('随机插入保持全序且无重复', () => {
  const rand = mulberry32(20240517);
  for (let round = 0; round < 40; round += 1) {
    const list = [between(null, null)];
    for (let i = 0; i < 60; i += 1) {
      const pos = Math.floor(rand() * (list.length + 1));
      const lower = pos === 0 ? null : list[pos - 1];
      const upper = pos === list.length ? null : list[pos];
      list.splice(pos, 0, between(lower, upper));
    }
    const sorted = [...list].sort();
    assert.deepEqual(list, sorted);
    assert.equal(new Set(list).size, list.length);
  }
});

test('after/before 与 betweenMany 的结果都合法且有序', () => {
  assert.ok(after('V') > 'V');
  assert.ok(before('V') < 'V');
  const batch = betweenMany('A', 'B', 9);
  assert.equal(batch.length, 9);
  assert.deepEqual(batch, [...batch].sort());
  for (const k of batch) {
    assert.ok('A' < k && k < 'B', `${k} 应在 (A,B) 内`);
    assert.equal(isValidOrderKey(k), true);
  }
  const unbounded = betweenMany(null, null, 5);
  assert.equal(new Set(unbounded).size, 5);
  assert.deepEqual(unbounded, [...unbounded].sort());
});

test('非法输入被拒绝', () => {
  assert.throws(() => between('B', 'A'), /out of order/);
  assert.throws(() => between('V', 'V'), /out of order/);
  assert.throws(() => between(null, 'V0'), /must not end with/);
  assert.throws(() => between('V-', null), /invalid char/);
  assert.equal(isValidOrderKey(''), false);
  assert.equal(isValidOrderKey('V0'), false);
});
