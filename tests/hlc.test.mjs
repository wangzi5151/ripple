import test from 'node:test';
import assert from 'node:assert/strict';

import { createClock, compareHlc, hlcToString, hlcFromString, maxHlc } from '../src/js/crdt/hlc.js';

test('物理时钟停止前进时逻辑计数器仍然单调递增', () => {
  let now = 1_700_000_000_000;
  const clock = createClock('A', { now: () => now });
  const a = clock.tick();
  const b = clock.tick();
  const c = clock.tick();
  assert.equal(a[0], now);
  assert.equal(a[1], 0);
  assert.equal(b[1], 1);
  assert.equal(c[1], 2);
  assert.ok(compareHlc(a, b) < 0 && compareHlc(b, c) < 0);

  now += 5_000; // 物理时间跳进
  const d = clock.tick();
  assert.deepEqual(d, [now, 0]);
  assert.ok(compareHlc(c, d) < 0);
});

test('observe() 保证之后的事件因果地晚于远端事件', () => {
  const local = createClock('local', { now: () => 1000 });
  const remote = createClock('remote', { now: () => 9_999 });
  const remoteTs = remote.tick();
  const remoteTs2 = remote.tick();

  local.observe(remoteTs2);
  const mine = local.tick();
  assert.ok(compareHlc(mine, remoteTs) > 0, `${hlcToString(mine)} 应大于 ${hlcToString(remoteTs)}`);
  assert.ok(compareHlc(mine, remoteTs2) > 0);
});

test('observe() 在同时刻比较时也能打破平局', () => {
  const a = createClock('a', { now: () => 500 });
  const b = createClock('b', { now: () => 500 });
  const t1 = a.tick();
  const t2 = b.tick();
  assert.equal(compareHlc(t1, t2), 0);
  const t3 = a.observe(t2);
  assert.ok(compareHlc(t3, t2) > 0);
  const t4 = b.observe(t3);
  assert.ok(compareHlc(t4, t3) > 0);
});

test('advance() 只抬升水位，不产生新事件', () => {
  const clock = createClock('A', { now: () => 100 });
  clock.tick();
  clock.advance([500, 3]);
  assert.deepEqual(clock.state, [500, 3]);
  clock.advance([200, 9]);
  assert.deepEqual(clock.state, [500, 3]);
  assert.deepEqual(clock.tick(), [500, 4]);
});

test('序列化往返与 maxHlc', () => {
  const clock = createClock('n1', { now: () => 42 });
  const t = clock.tick();
  assert.deepEqual(hlcFromString(hlcToString(t)), t);
  assert.deepEqual(maxHlc([[1, 0], [3, 7], [3, 2], [2, 99]]), [3, 7]);
  assert.equal(maxHlc([]), null);
});

test('远端时钟明显超前时记录漂移告警但保持因果', () => {
  const clock = createClock('A', { now: () => 1000, maxDriftMs: 1000 });
  const before = clock.driftWarnings;
  clock.observe([60_000, 0]);
  assert.equal(clock.driftWarnings, before + 1);
  assert.ok(compareHlc(clock.tick(), [60_000, 0]) > 0);
});
