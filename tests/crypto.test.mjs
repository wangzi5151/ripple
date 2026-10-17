import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFragment,
  decryptOps,
  deriveRoomId,
  encryptOps,
  isValidKey,
  parseFragment,
  randomKey,
} from '../src/js/sync/crypto.js';

const sampleOps = [
  { i: 'phone@1', n: 'phone', q: 1, h: [1000, 0], t: 'mk', e: 'card-1', k: 'card' },
  { i: 'phone@2', n: 'phone', q: 2, h: [1000, 1], t: 'lw', e: 'card-1', p: 'title', v: '买个蛋糕' },
];

test('密钥生成与校验', async () => {
  const key = await randomKey();
  assert.equal(isValidKey(key), true);
  assert.equal(key.includes('='), false, 'base64url 不带填充');
  assert.equal(key.length, 43, '32 字节 → 43 个 base64url 字符');
  assert.equal(isValidKey('short'), false);
  assert.equal(isValidKey('!!!!'), false);
  assert.notEqual(await randomKey(), key);
});

test('房间标识：同一密钥+房间名稳定，不同密钥/房间名不同，且不泄露原文', async () => {
  const key = await randomKey();
  const a = await deriveRoomId('发布计划', key);
  const b = await deriveRoomId('发布计划', key);
  const c = await deriveRoomId('发布计划', await randomKey());
  const d = await deriveRoomId('另一个房间', key);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a.includes('发布'), false, '房间标识里不应出现明文房间名');
});

test('加密只藏载荷，信封字段明文保留（服务器才能去重排版本）', async () => {
  const key = await randomKey();
  const wire = await encryptOps(key, sampleOps);
  assert.equal(wire.length, 2);
  for (const [index, op] of wire.entries()) {
    assert.equal(op.z, 1);
    assert.equal(op.i, sampleOps[index].i);
    assert.equal(op.n, sampleOps[index].n);
    assert.equal(op.q, sampleOps[index].q);
    assert.deepEqual(op.h, sampleOps[index].h);
    assert.equal(op.t, undefined, '载荷必须被移出信封');
    assert.equal(typeof op.d, 'string');
    assert.equal(JSON.stringify(op).includes('蛋糕'), false, '密文里不应出现明文');
  }
});

test('加解密往返，且两条相同明文得到不同密文（随机 IV）', async () => {
  const key = await randomKey();
  const wire = await encryptOps(key, sampleOps);
  const back = await decryptOps(key, wire);
  assert.deepEqual(back, sampleOps);

  const twice = await encryptOps(key, [sampleOps[1], sampleOps[1]]);
  assert.notEqual(twice[0].d, twice[1].d);
  assert.deepEqual(await decryptOps(key, twice), [sampleOps[1], sampleOps[1]]);
});

test('密钥不匹配或密文被改动时抛出可识别的错误', async () => {
  const key = await randomKey();
  const wire = await encryptOps(key, [sampleOps[0]]);
  const otherKey = await randomKey();
  await assert.rejects(() => decryptOps(otherKey, wire), (error) => error.code === 'decrypt_failed');

  const tampered = [{ ...wire[0], d: `${wire[0].d.slice(0, -2)}AA` }];
  await assert.rejects(() => decryptOps(key, tampered), (error) => error.code === 'decrypt_failed');
});

test('未加密的 op 原样透传，混合批次也能解密', async () => {
  const key = await randomKey();
  const plain = { i: 'laptop@1', n: 'laptop', q: 1, h: [5, 0], t: 'mk', e: 'x', k: 'card' };
  const mixed = [...(await encryptOps(key, [sampleOps[0]])), plain];
  const back = await decryptOps(key, mixed);
  assert.deepEqual(back, [sampleOps[0], plain]);
  assert.deepEqual(await decryptOps(null, [plain]), [plain]);
});

test('分享链接片段：解析与生成', async () => {
  const key = await randomKey();
  const fragment = buildFragment({ room: '团队看板', key });
  const parsed = parseFragment(fragment, { room: 'default' });
  assert.equal(parsed.room, '团队看板');
  assert.equal(parsed.key, key);
  assert.equal(parsed.e2e, true);

  const plain = parseFragment('#room=ripple');
  assert.equal(plain.room, 'ripple');
  assert.equal(plain.key, null);
  assert.equal(plain.e2e, false);

  const fallback = parseFragment('', { room: 'fallback' });
  assert.equal(fallback.room, 'fallback');
});
