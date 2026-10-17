import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERR,
  MSG,
  PROTOCOL_VERSION,
  coveredBy,
  decodeMessage,
  describeMessage,
  encodeMessage,
  errorMessage,
  hello,
  opIdsOf,
  opsMessage,
  packOps,
  syncRequest,
  validateEnvelope,
  welcome,
} from '../src/js/sync/protocol.js';

function env(i, n, q, h, extra = {}) {
  return { i, n, q, h, t: 'lw', ...extra };
}

test('信封校验：接受合法 op，拒绝缺字段与超长节点名', () => {
  assert.equal(validateEnvelope(env('a@1', 'a', 1, [1, 0])), true);
  assert.equal(validateEnvelope({ i: 'a@1', n: 'a', q: 1, h: [1, 0], z: 1, iv: 'x', d: 'y' }), true, '加密信封不需要 t');
  assert.throws(() => validateEnvelope({ i: 'a@1', n: 'a', q: 1 }), /missing field "h"/);
  assert.throws(() => validateEnvelope({ i: 'a@1', n: 'a'.repeat(65), q: 1, h: [1, 0] }), /bad op.n/);
  assert.throws(() => validateEnvelope(env('a@1', 'a', 0, [1, 0])), /bad op.q/);
  assert.throws(() => validateEnvelope(env('a@1', 'a', 1, [1])), /bad op.h/);
  assert.throws(() => validateEnvelope({ i: 'a@1', n: 'a', q: 1, h: [1, 0] }), /bad op.t/);
  assert.throws(() => validateEnvelope({ i: 'a@1', n: 'a', q: 1, h: [1, 0], z: 1, iv: 'x' }), /needs d and iv/);
});

test('消息编解码与错误码', () => {
  const text = encodeMessage(hello({ room: 'r', client: 'c', have: { a: 3 } }));
  const parsed = decodeMessage(text);
  assert.equal(parsed.t, MSG.HELLO);
  assert.equal(parsed.p, PROTOCOL_VERSION);
  assert.deepEqual(parsed.have, { a: 3 });
  assert.match(describeMessage(parsed), /hello room=r client=c/);

  assert.throws(() => decodeMessage('{oops'), (error) => error.code === ERR.BAD_MESSAGE);
  assert.throws(() => decodeMessage('[1,2]'), (error) => error.code === ERR.BAD_MESSAGE);
  assert.throws(() => decodeMessage('{"a":1}'), /must be an object with "t"/);
  assert.equal(errorMessage(ERR.TOO_LARGE, '太大').code, ERR.TOO_LARGE);
  assert.match(describeMessage(welcome({ room: 'r', server: 's', peers: [1], version: {} })), /welcome peers=1/);
  assert.match(describeMessage(opsMessage([env('a@1', 'a', 1, [1, 0])], { encrypted: true })), /1 \(encrypted\)/);
  assert.match(describeMessage(syncRequest({ have: { a: 1 } })), /sync reply=true/);
});

test('packOps 按上限分批，encrypt 钩子生效', async () => {
  const ops = Array.from({ length: 7 }, (_, index) => env(`a@${index + 1}`, 'a', index + 1, [index, 0]));
  const chunks = await packOps(ops, { max: 3 });
  assert.deepEqual(chunks.map((c) => c.length), [3, 3, 1]);
  const encrypted = await packOps(ops, { max: 10, encrypt: async (list) => list.map((op) => ({ ...op, z: 1 })) });
  assert.equal(encrypted[0].every((op) => op.z === 1), true);
  assert.deepEqual(opIdsOf(ops).length, 7);
});

test('coveredBy：地平线判断决定「能发增量」还是「必须发快照」', () => {
  assert.equal(coveredBy({ a: 5 }, { a: 5 }), true);
  assert.equal(coveredBy({ a: 9 }, { a: 5 }), true, '客户端领先没问题');
  assert.equal(coveredBy({ a: 3 }, { a: 5 }), false);
  assert.equal(coveredBy({}, {}), true);
  assert.equal(coveredBy({ a: 5 }, { a: 5, b: 1 }), false);
});

test('单条消息超过上限时抛错，避免打爆中继', () => {
  const big = { t: 'ops', ops: [{ blob: 'x'.repeat(600 * 1024) }] };
  assert.throws(() => encodeMessage(big), /message too large/);
});
