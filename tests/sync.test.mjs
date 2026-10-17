import test from 'node:test';
import assert from 'node:assert/strict';

import { createHub, createFakeNetwork } from '../server/hub.js';
import { MSG } from '../src/js/sync/protocol.js';
import { Doc } from '../src/js/crdt/doc.js';
import { OP } from '../src/js/crdt/ops.js';
import { createSyncEngine, STATUS } from '../src/js/sync/engine.js';
import { memoryStorage } from '../src/js/sync/storage.js';
import { waitFor, openWsClient, nodeWebSocketTransportFactory, mulberry32 } from './helpers/net.mjs';
import { createRippleServer } from '../server/index.js';

function envelope(node, q, type = 'lw', payload = {}) {
  return { i: `${node}@${q}`, n: node, q, h: [1000 + q, 0], t: type, ...payload };
}

function makeCtx(client = 'c1') {
  return { client, room: null };
}

test('hello / join / presence：房间中枢维护在线设备名单', () => {
  const hub = createHub({ serverId: 'test-server' });
  const first = hub.handle(makeCtx('a'), { t: MSG.HELLO, p: 1, room: 'room1', client: 'a', name: '手机', caps: [] });
  assert.equal(first[0].msg.t, MSG.WELCOME);
  assert.equal(first[0].msg.server, 'test-server');
  assert.deepEqual(first[0].msg.peers.map((p) => p.client), ['a']);

  const second = hub.handle(makeCtx('b'), { t: MSG.HELLO, p: 1, room: 'room1', client: 'b', name: '电脑', caps: [] });
  assert.deepEqual(second[0].msg.peers.map((p) => p.client).sort(), ['a', 'b']);
  assert.equal(second[1].to, '*');
  assert.equal(second[1].msg.t, MSG.PRESENCE);
  assert.equal(hub.stats().peers, 2);

  const leave = hub.disconnect({ client: 'a', room: 'room1' });
  assert.equal(leave[0].msg.peers.length, 1);
  assert.equal(leave[0].msg.peers[0].client, 'b');
});

test('房间隔离：不同 room 的 op 不互相广播', () => {
  const hub = createHub();
  const a = makeCtx('a');
  const b = makeCtx('b');
  hub.handle(a, { t: 'hello', p: 1, room: 'red', client: 'a' });
  hub.handle(b, { t: 'hello', p: 1, room: 'blue', client: 'b' });
  const out = hub.handle(a, { t: 'ops', ops: [envelope('a', 1)] });
  assert.equal(out.length, 0, '單人房無需廣播');
  assert.equal(hub.roomInfo('red').ops, 1);
  assert.equal(hub.roomInfo('blue').ops, 0);
});

test('op 去重、版本向量與增量同步', () => {
  const hub = createHub();
  const ctxA = makeCtx('a');
  const ctxB = makeCtx('b');
  hub.handle(ctxA, { t: 'hello', p: 1, room: 'r', client: 'a' });
  hub.handle(ctxB, { t: 'hello', p: 1, room: 'r', client: 'b' });

  const a1 = envelope('node-a', 1);
  const a2 = envelope('node-a', 2);
  const b1 = envelope('node-b', 1);
  let out = hub.handle(ctxA, { t: 'ops', ops: [a1, a2, a1] });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].msg.ops.map((op) => op.i), ['node-a@1', 'node-a@2']);
  assert.deepEqual(hub.roomInfo('r').version, { 'node-a': 2 });

  out = hub.handle(ctxB, { t: 'ops', ops: [b1] });
  assert.equal(out[0].except, 'b');

  out = hub.handle(ctxB, { t: 'sync', have: { 'node-a': 1 }, reply: false });
  assert.deepEqual(
    out.filter((item) => item.msg.t === 'ops').flatMap((item) => item.msg.ops).map((op) => op.i).sort(),
    ['node-a@2', 'node-b@1'],
    'have 未包含 node-b，所以它的 op 也应补发',
  );
  assert.equal(out.at(-1).msg.done, true);
  assert.deepEqual(hub.exportRoom('r').ops.map((op) => op.i).sort(), ['node-a@1', 'node-a@2', 'node-b@1']);
  assert.equal(hub.stats().opsAccepted, 3);
});

test('协议版本、房间容量、op 验证与大小上限', () => {
  const hub = createHub({ limits: { maxPeersPerRoom: 1, maxOpBytes: 120 } });
  const first = hub.handle(makeCtx('a'), { t: 'hello', p: 99, room: 'r', client: 'a' });
  assert.equal(first[0].msg.code, 'unsupported_version');

  const a = makeCtx('a');
  const b = makeCtx('b');
  hub.handle(a, { t: 'hello', p: 1, room: 'r', client: 'a' });
  const full = hub.handle(b, { t: 'hello', p: 1, room: 'r', client: 'b' });
  assert.equal(full[0].msg.code, 'room_full');

  const bad = hub.handle(a, { t: 'ops', ops: [{ i: 'x', n: 'x', q: 1, h: [1, 0], t: 'x'.repeat(300) }] });
  assert.equal(bad[0].msg.code, 'bad_message');
  assert.equal(hub.stats().opsRejected, 1);
});

test('日志压缩与快照地平线：老客户端需要快照，新客户端仍可增量', () => {
  const hub = createHub({ limits: { maxOpsPerRoom: 5 } });
  const ctx = makeCtx('a');
  hub.handle(ctx, { t: 'hello', p: 1, room: 'r', client: 'a' });
  hub.handle(ctx, { t: 'ops', ops: Array.from({ length: 8 }, (_, i) => envelope('a', i + 1)) });
  assert.ok(hub.roomInfo('r').ops <= 5);
  assert.ok(hub.stats().opsPruned > 0);

  const snapshot = { v: 1, version: { a: 4 }, entities: [], sets: [], texts: [], clock: [10, 0] };
  hub.handle(ctx, { t: 'snapshot', snapshot });
  assert.equal(hub.roomInfo('r').horizon.a, 4);
  const stale = hub.handle(ctx, { t: 'sync', have: { a: 1 }, reply: false });
  assert.ok(stale.some((item) => item.msg.t === 'snapshot'));
  const current = hub.handle(ctx, { t: 'sync', have: { a: 4 }, reply: false });
  assert.ok(!current.some((item) => item.msg.t === 'snapshot'));
});

test('服务器可以只中继密文信封，不需要了解 payload', () => {
  const hub = createHub();
  const ctx = makeCtx('a');
  hub.handle(ctx, { t: 'hello', p: 1, room: 'private-room', client: 'a', e2e: true });
  const encrypted = { i: 'a@1', n: 'a', q: 1, h: [10, 0], z: 1, iv: 'iv', d: 'ciphertext' };
  // 单人房没有其他接收方，因此消息不广播；信封只进日志。
  const out = hub.handle(ctx, { t: 'ops', ops: [encrypted], enc: true });
  assert.equal(out.length, 0);
  assert.deepEqual(hub.exportRoom('private-room').ops, [encrypted]);
});

test('FakeNetwork 上两个完整同步引擎：在线合并 + 断网离线编辑 + 重连收敛', async () => {
  const hub = createHub();
  const network = createFakeNetwork({ random: mulberry32(1) });
  network.attach(hub);

  const base = new Doc({ node: 'seed' });
  base.mint(OP.MAKE, { e: 'board', k: 'board' });
  base.mint(OP.SET, { e: 'board', p: 'title', v: '離線板' });
  const docA = base.clone('phone');
  const docB = base.clone('laptop');

  const a = createSyncEngine({ doc: docA, room: 'e2e-room', transportFactory: network.client('phone'), storage: memoryStorage(), random: () => 0 });
  const b = createSyncEngine({ doc: docB, room: 'e2e-room', transportFactory: network.client('laptop'), storage: memoryStorage(), random: () => 0 });
  const eventsA = [];
  const eventsB = [];
  a.on((event) => eventsA.push(event));
  b.on((event) => eventsB.push(event));
  a.start();
  b.start();
  await waitFor(() => a.status === STATUS.ONLINE && b.status === STATUS.ONLINE, { label: '两客户端首次同步在线' });

  const opA = a.doc.mint(OP.SET, { e: 'board', p: 'fromPhone', v: '好' });
  const opB = b.doc.mint(OP.SET, { e: 'board', p: 'fromLaptop', v: '也好' });
  await Promise.all([a.pushOps([opA]), b.pushOps([opB])]);
  await waitFor(() => a.doc.field('board', 'fromLaptop') === '也好' && b.doc.field('board', 'fromPhone') === '好', { label: '在线双向传播' });

  // 关闭连接后在两个设备上独立操作，再手动建立新一轮连接。
  await a.stop();
  await b.stop();
  const offA = a.doc.mint(OP.SET, { e: 'board', p: 'offlineA', v: 1 });
  const offB = b.doc.mint(OP.SET, { e: 'board', p: 'offlineB', v: 2 });
  await a.pushOps([offA]);
  await b.pushOps([offB]);
  a.start();
  b.start();
  await waitFor(
    () => a.status === STATUS.ONLINE && b.status === STATUS.ONLINE && a.doc.field('board', 'offlineB') === 2 && b.doc.field('board', 'offlineA') === 1,
    { label: '重连后离线操作收敛' },
  );
  assert.equal(a.doc.stateHash(), b.doc.stateHash());
  assert.ok(eventsA.some((event) => event.type === 'ops'));
  assert.ok(eventsB.some((event) => event.type === 'ops'));
  assert.ok(a.stats.received >= 2);
  await a.stop();
  await b.stop();
});

test('同步引擎：IndexedDB/localStorage 不可用时仍能内存运行并持久化快照接口', async () => {
  const storage = memoryStorage();
  const doc = new Doc({ node: 'local' });
  doc.mint(OP.MAKE, { e: 'x', k: 'card' });
  const engine = createSyncEngine({ doc, room: 'persist-test', storage });
  engine.pushOps([]);
  await engine.flush();
  const raw = storage._raw;
  assert.equal(raw.doc.ops.length, 1);
  assert.equal(raw.room, 'persist-test');

  const loaded = createSyncEngine({ doc: new Doc({ node: 'replacement' }), storage });
  await loaded.load();
  assert.equal(loaded.doc.hasOp('local@1'), true);
  assert.equal(loaded.doc.isAlive('x'), true);
});

test('真实 HTTP + WebSocket：握手、静态文件/API、同步消息往返', async () => {
  const app = createRippleServer({ dataDir: null, quiet: true });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal((await fetch(`${origin}/api/unknown`).then((r) => r.status)), 404);

    // 页面静态文件尚未做时允许 index 404，其余 HTTP 服务正常；WS 是实测重点
    const client = await openWsClient(`ws://127.0.0.1:${address.port}/ws`);
    client.send(JSON.stringify({ t: 'hello', p: 1, room: 'real-room', client: 'real-client', name: '真机' }));
    const welcome = await client.nextJson();
    assert.equal(welcome.t, 'welcome');
    assert.equal(welcome.peers[0].client, 'real-client');

    client.send(JSON.stringify({ t: 'sync', have: {}, reply: false }));
    const done = await client.nextJson();
    assert.equal(done.t, 'ops');
    assert.equal(done.done, true);

    client.send(JSON.stringify({ t: 'ops', ops: [envelope('real-client', 1)] }));
    await waitFor(() => app.hub.roomInfo('real-room')?.ops === 1, { label: '真 WebSocket op 写入' });
    const room = await fetch(`${origin}/api/rooms/real-room`).then((r) => r.json());
    assert.equal(room.ops, 1);
    assert.equal(JSON.stringify(room).includes('payload'), false, '只读 API 不应回传 op 内容');
    client.close();
  } finally {
    await app.close();
  }
});

// 服务器 sync 回包使用 op 信封，因此也校验 hello/have 的语义。
test('hello 带版本向量时，服务器无需第二次往返即可判断快照需求', () => {
  const hub = createHub();
  const ctx = makeCtx('a');
  const [welcome] = hub.handle(ctx, { t: 'hello', p: 1, room: 'r', client: 'a', have: { old: 0 } });
  assert.equal(welcome.msg.t, 'welcome');
  assert.equal(welcome.msg.snapshotRequired, false);
});
