import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOSE_CODE,
  OPCODE,
  acceptKey,
  createFrameParser,
  createSocketChannel,
  encodeFrame,
  frameParts,
  makeHandshakeRequest,
  makeHandshakeResponse,
  parseHttpHeaders,
} from '../server/ws.js';

test('握手：RFC 6455 示例向量与响应头', () => {
  // 规范里的例子
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  const { text, key } = makeHandshakeRequest({ host: 'example.com:8787', path: '/ws', key: 'dGhlIHNhbXBsZSBub25jZQ==' });
  assert.match(text, /^GET \/ws HTTP\/1\.1\r\n/);
  assert.match(text, /Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==/);
  assert.match(text, /Sec-WebSocket-Version: 13\r\n\r\n$/);

  const response = makeHandshakeResponse(text);
  const parsed = parseHttpHeaders(response);
  assert.equal(parsed.isResponse, true);
  assert.equal(parsed.statusCode, 101);
  assert.equal(parsed.version, 'HTTP/1.1');
  assert.equal(parsed.headers.upgrade, 'websocket');
  assert.equal(parsed.headers['sec-websocket-accept'], acceptKey(key));
  assert.throws(() => makeHandshakeResponse('GET / HTTP/1.1\r\n\r\n'), /Sec-WebSocket-Key/);
});

test('帧编码：长度档位（0 / 125 / 126 / 65535 / 65536）', () => {
  for (const length of [0, 1, 125, 126, 1234, 65535, 65536]) {
    const payload = Buffer.alloc(length, 0x61);
    const frame = encodeFrame({ opcode: OPCODE.TEXT, payload, mask: false });
    const parser = createFrameParser();
    const { messages } = parser.push(frame);
    assert.equal(messages.length, 1, `长度 ${length}`);
    assert.equal(messages[0].data.length, length);
    assert.equal(messages[0].type, 'text');
  }
  // 126 用 16 位长度、65536 用 64 位长度
  assert.equal(encodeFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(126), mask: false })[1] & 0x7f, 126);
  assert.equal(encodeFrame({ opcode: OPCODE.BINARY, payload: Buffer.alloc(65536), mask: false })[1] & 0x7f, 127);
});

test('掩码：客户端帧被正确解掩码，未掩码帧原样通过', () => {
  const payload = Buffer.from('中文明文 abc');
  const masked = frameParts({ opcode: OPCODE.TEXT, payload, mask: true, maskKey: Buffer.from([9, 9, 9, 9]) });
  assert.equal(masked[1] & 0x80, 0x80, 'mask 位应被置上');
  assert.equal(masked.subarray(2, 6).toString('hex'), '09090909');
  const parser = createFrameParser();
  assert.equal(parser.push(masked).messages[0].data.toString('utf8'), payload.toString('utf8'));

  const plain = frameParts({ opcode: OPCODE.TEXT, payload, mask: false });
  assert.equal(plain[1] & 0x80, 0);
  assert.equal(createFrameParser().push(plain).messages[0].data.toString('utf8'), payload.toString('utf8'));
});

test('分片：续帧拼接成一条消息（含按字节喂入的极端情况）', () => {
  const part1 = frameParts({ opcode: OPCODE.TEXT, payload: Buffer.from('前一半'), fin: false, mask: true });
  const part2 = frameParts({ opcode: OPCODE.CONTINUATION, payload: Buffer.from('后一半'), fin: false, mask: true });
  const part3 = frameParts({ opcode: OPCODE.CONTINUATION, payload: Buffer.from('结尾'), fin: true, mask: true });
  const all = Buffer.concat([part1, part2, part3]);

  const parser = createFrameParser();
  const direct = parser.push(all);
  assert.equal(direct.messages.length, 1);
  assert.equal(direct.messages[0].data.toString('utf8'), '前一半后一半结尾');

  const bytewise = createFrameParser();
  const messages = [];
  for (const byte of all) {
    messages.push(...bytewise.push(Buffer.from([byte])).messages);
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.toString('utf8'), '前一半后一半结尾');
});

test('控制帧：ping/pong 事件与 close 关闭码解析', () => {
  const parser = createFrameParser();
  const ping = parser.push(frameParts({ opcode: OPCODE.PING, payload: Buffer.from('hb'), mask: true }));
  assert.equal(ping.events[0].type, 'ping');
  assert.equal(ping.events[0].data.toString(), 'hb');

  const closePayload = Buffer.alloc(5);
  closePayload.writeUInt16BE(CLOSE_CODE.GOING_AWAY, 0);
  closePayload.write('bye', 2);
  const closed = parser.push(frameParts({ opcode: OPCODE.CLOSE, payload: closePayload, mask: true }));
  assert.equal(closed.events[0].type, 'close');
  assert.equal(closed.events[0].code, 1001);
  assert.equal(closed.events[0].reason, 'bye');

  const empty = createFrameParser().push(frameParts({ opcode: OPCODE.CLOSE, payload: Buffer.alloc(0), mask: true }));
  assert.equal(empty.events[0].code, null);
});

test('非法帧被拒绝：控制帧过长、分片控制帧、过大载荷、RSV 位', () => {
  assert.throws(() => encodeFrame({ opcode: OPCODE.PING, payload: Buffer.alloc(126) }), /不能超过 125/);
  assert.throws(() => encodeFrame({ opcode: OPCODE.PING, payload: Buffer.from('x'), fin: false }), /不能被分片/);

  const big = Buffer.alloc(10);
  big[0] = 0x81;
  big[1] = 127;
  big.writeBigUInt64BE(9_000_000n, 2);
  assert.throws(() => createFrameParser({ maxPayload: 1024 }).push(Buffer.concat([big, Buffer.alloc(0)])), /超过上限/);

  const rsv = Buffer.from([0x91, 0x00]);
  assert.throws(() => createFrameParser().push(rsv), /RSV/);

  const orphan = frameParts({ opcode: OPCODE.CONTINUATION, payload: Buffer.from('x'), mask: true });
  assert.throws(() => createFrameParser().push(orphan), /意外的续帧/);

  const unknownOpcode = Buffer.from([0x83, 0x00]);
  assert.throws(() => createFrameParser().push(unknownOpcode), /未知 opcode/);
});

test('不完整帧缓冲起来等后续字节（半包不会误判）', () => {
  const payload = Buffer.alloc(200, 0x62);
  const frame = frameParts({ opcode: OPCODE.BINARY, payload, mask: true });
  const parser = createFrameParser();
  const half = parser.push(frame.subarray(0, 100));
  assert.equal(half.messages.length, 0);
  assert.ok(parser.buffered > 0);
  const rest = parser.push(frame.subarray(100));
  assert.equal(rest.messages.length, 1);
  assert.equal(rest.messages[0].data.length, 200);
  assert.equal(parser.buffered, 0);
});

test('createSocketChannel：消息/心跳/关闭的完整生命周期', async () => {
  const written = [];
  const handlers = { message: [], close: [], error: [], pong: [] };
  const fakeSocket = {
    write(buffer) {
      written.push(Buffer.from(buffer));
      return true;
    },
    end() {},
    on(type, handler) {
      (handlers[type] ??= []).push(handler);
      return this;
    },
    emit(type, ...args) {
      for (const handler of handlers[type] ?? []) handler(...args);
    },
  };
  const channel = createSocketChannel(fakeSocket);
  const received = [];
  channel.on('message', (message) => received.push(message.data));
  fakeSocket.emit('data', frameParts({ opcode: OPCODE.TEXT, payload: Buffer.from('hello'), mask: true }));
  assert.deepEqual(received, ['hello']);

  // 收到 ping 自动回 pong
  fakeSocket.emit('data', frameParts({ opcode: OPCODE.PING, payload: Buffer.from('p'), mask: true }));
  const pong = written[written.length - 1];
  assert.equal(pong[0] & 0x0f, OPCODE.PONG);

  // 主动 ping 与关闭
  channel.ping(Buffer.from('hb'));
  assert.equal(written[written.length - 1][0] & 0x0f, OPCODE.PING);
  let closeInfo = null;
  channel.on('close', (info) => {
    closeInfo = info;
  });
  fakeSocket.emit('data', frameParts({ opcode: OPCODE.CLOSE, payload: Buffer.from([0x03, 0xe8]), mask: true }));
  assert.equal(closeInfo.code, 1000);

  // 底层断开且没有 close 帧 → 归类为异常断开
  const channel2 = createSocketChannel(fakeSocket);
  let info2 = null;
  channel2.on('close', (info) => {
    info2 = info;
  });
  fakeSocket.emit('close');
  assert.equal(info2.code, CLOSE_CODE.ABNORMAL);
  assert.equal(info2.clean, false);
});
