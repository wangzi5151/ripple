import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHub } from '../server/hub.js';
import { createRippleServer } from '../server/index.js';
import { openWsClient, waitFor } from './helpers/net.mjs';

function envelope(node, q, payload = {}) {
  return { i: `${node}@${q}`, n: node, q, h: [1000 + q, 0], t: 'lw', ...payload };
}

function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

test('op 限额按 UTF-8 字节计算，而不是 JavaScript 字符数', () => {
  const limit = 200;
  const hub = createHub({ limits: { maxOpBytes: limit } });
  const ctx = { client: 'a', room: null };
  hub.handle(ctx, { t: 'hello', p: 1, room: 'r', client: 'a' });

  const op = envelope('a', 1, { d: '中'.repeat(70) });
  const charLength = JSON.stringify(op).length;
  const byteLength = bytesOf(op);
  assert.ok(charLength <= limit, `test setup: ${charLength} <= ${limit}`);
  assert.ok(byteLength > limit, `test setup: ${byteLength} > ${limit}`);

  const out = hub.handle(ctx, { t: 'ops', ops: [op] });
  assert.equal(out[0].msg.t, 'error');
  assert.match(out[0].msg.msg, /too_large/);
  assert.equal(hub.roomInfo('r').ops, 0);
  assert.equal(hub.roomInfo('r').bytes, 0);
  assert.equal(hub.stats().opsRejected, 1);
});

test('快照限额同样按字节计算，超限不替换旧快照', () => {
  const limit = 100;
  const hub = createHub({ limits: { maxSnapshotBytes: limit } });
  const ctx = { client: 'a', room: null };
  hub.handle(ctx, { t: 'hello', p: 1, room: 's', client: 'a' });

  const snapshot = { v: 1, version: {}, data: '中'.repeat(40) };
  const charLength = JSON.stringify(snapshot).length;
  const byteLength = bytesOf(snapshot);
  assert.ok(charLength <= limit, `test setup: ${charLength} <= ${limit}`);
  assert.ok(byteLength > limit, `test setup: ${byteLength} > ${limit}`);

  const out = hub.handle(ctx, { t: 'snapshot', snapshot });
  assert.equal(out[0].msg.code, 'too_large');
  assert.equal(hub.roomInfo('s').hasSnapshot, false);
});

test('room.bytes 统计 op 与快照，并在裁剪/替换时保持正确', () => {
  const hub = createHub({ limits: { maxOpsPerRoom: 3, maxOpBytes: 4096 } });
  const ctx = { client: 'a', room: null };
  hub.handle(ctx, { t: 'hello', p: 1, room: 'r', client: 'a' });

  const ops = [1, 2, 3, 4, 5].map((q) => envelope('a', q, { d: '中'.repeat(q) }));
  hub.handle(ctx, { t: 'ops', ops });

  const room = hub.roomInfo('r');
  assert.equal(room.ops, 2, '超过 maxOpsPerRoom 后会裁到 80%');
  const expectedOpsBytes = hub
    .exportRoom('r')
    .ops.reduce((sum, op) => sum + bytesOf(op), 0);
  assert.equal(room.bytes, expectedOpsBytes);
  assert.equal(room.horizon.a, 3);

  const snapshot = { v: 1, version: { a: 5 }, data: '快照' };
  hub.handle(ctx, { t: 'snapshot', snapshot });
  const afterSnapshot = hub.roomInfo('r');
  assert.equal(afterSnapshot.ops, 0, '快照地平线会裁掉已覆盖的 op');
  assert.equal(afterSnapshot.bytes, bytesOf(snapshot));

  const snapshot2 = { v: 2, version: { a: 5 }, data: '新的快照' };
  hub.handle(ctx, { t: 'snapshot', snapshot: snapshot2 });
  const afterReplace = hub.roomInfo('r');
  assert.equal(afterReplace.bytes, bytesOf(snapshot2), '替换快照不应累加旧快照字节');
});

test('真实 WebSocket：超限 op 被拒绝，房间不写入', async () => {
  const app = createRippleServer({ dataDir: null, quiet: true, limits: { maxOpBytes: 200 } });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const client = await openWsClient(`ws://127.0.0.1:${address.port}/ws`);
  try {
    client.send(JSON.stringify({ t: 'hello', p: 1, room: 'limits', client: 'c1' }));
    const welcome = await client.nextJson();
    assert.equal(welcome.t, 'welcome');

    const op = envelope('c1', 1, { d: '中'.repeat(70) });
    assert.ok(bytesOf(op) > 200);
    client.send(JSON.stringify({ t: 'ops', ops: [op] }));
    const reply = await client.nextJson();
    assert.equal(reply.t, 'error');
    assert.match(reply.msg, /too_large/);
    assert.equal(app.hub.roomInfo('limits').ops, 0);
    assert.equal(app.hub.roomInfo('limits').bytes, 0);
  } finally {
    client.close();
    await app.close();
  }
});

test('持久化恢复：重启后快照、地平线与字节统计一致', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ripple-persist-'));
  let app1;
  let app2;
  let client1;
  let client2;
  try {
    app1 = createRippleServer({ dataDir: dir, quiet: true });
    const address1 = await app1.listen({ port: 0, host: '127.0.0.1' });
    client1 = await openWsClient(`ws://127.0.0.1:${address1.port}/ws`);
    client1.send(JSON.stringify({ t: 'hello', p: 1, room: 'persist', client: 'c1' }));
    assert.equal((await client1.nextJson()).t, 'welcome');

    const ops = [envelope('c1', 1, { d: '第一' }), envelope('c1', 2, { d: '第二' })];
    client1.send(JSON.stringify({ t: 'ops', ops }));
    await waitFor(() => app1.hub.roomInfo('persist')?.ops === 2, { label: 'ops 写入' });

    const snapshot = { v: 1, version: { c1: 2 }, data: '持久化快照' };
    client1.send(JSON.stringify({ t: 'snapshot', snapshot }));
    await waitFor(
      () => {
        const info = app1.hub.roomInfo('persist');
        return info?.hasSnapshot === true && info.ops === 0 && info.horizon.c1 === 2;
      },
      { label: '快照与裁剪' },
    );
    const before = app1.hub.roomInfo('persist');
    client1.close();
    client1 = null;
    await app1.close();
    app1 = null;

    app2 = createRippleServer({ dataDir: dir, quiet: true });
    const address2 = await app2.listen({ port: 0, host: '127.0.0.1' });
    const after = app2.hub.roomInfo('persist');
    assert.equal(after.hasSnapshot, true);
    assert.equal(after.horizon.c1, 2);
    assert.equal(after.ops, 0);
    assert.equal(after.bytes, before.bytes);

    client2 = await openWsClient(`ws://127.0.0.1:${address2.port}/ws`);
    client2.send(JSON.stringify({ t: 'hello', p: 1, room: 'persist', client: 'c2', have: {} }));
    const welcome = await client2.nextJson();
    assert.equal(welcome.snapshotRequired, true);
    assert.equal(welcome.snapshot.data, '持久化快照');
  } finally {
    client1?.close();
    client2?.close();
    if (app1) await app1.close();
    if (app2) await app2.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
