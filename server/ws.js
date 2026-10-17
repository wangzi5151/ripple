/**
 * 手写的 WebSocket（RFC 6455）实现：服务端与客户端两端都用它。
 *
 * 为什么不用 ws / socket.io：这个项目要求零依赖，能直接扔到任何机器上跑；
 * 顺便把帧编解码写成可单测的纯函数（tests/ws.test.mjs）。
 *
 * 覆盖：握手（Sec-WebSocket-Accept）、7/16/64 位长度、掩码、
 * 分片与续帧、控制帧（ping/pong/close）、关闭码解析。
 */

import { createHash, randomBytes } from 'node:crypto';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

export const CLOSE_CODE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  NO_STATUS: 1005,
  ABNORMAL: 1006,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  TOO_LARGE: 1009,
  INTERNAL_ERROR: 1011,
};

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CONTROL_PAYLOAD = 125;

export function acceptKey(secWebSocketKey) {
  return createHash('sha1')
    .update(String(secWebSocketKey) + WS_GUID)
    .digest('base64');
}

export function makeHandshakeRequest({ host, path = '/ws', key = randomBytes(16).toString('base64'), protocols = [] }) {
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (protocols.length) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
  return { text: `${lines.join('\r\n')}\r\n\r\n`, key };
}

/** 解析 HTTP 头（用于握手请求与服务端响应）。 */
export function parseHttpHeaders(text) {
  const [head, ...rest] = String(text).split('\r\n\r\n');
  const lines = head.split('\r\n');
  const parts = lines[0].split(' ');
  const isResponse = parts[0].startsWith('HTTP/');
  // 请求行：METHOD TARGET VERSION；响应行：VERSION CODE REASON
  const method = isResponse ? null : parts[0];
  const target = isResponse ? null : parts[1];
  const version = isResponse ? parts[0] : parts[2];
  const statusCode = isResponse ? Number(parts[1]) : null;
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { requestLine: lines[0], method, target, version, statusCode, isResponse, headers, rest: rest.join('\r\n\r\n') };
}

export function makeHandshakeResponse(request, { protocol = null } = {}) {
  const headers = parseHttpHeaders(request);
  const key = headers.headers['sec-websocket-key'];
  if (!key) throw new Error('缺少 Sec-WebSocket-Key');
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ];
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** 编码一帧。客户端 → 服务端必须 mask=true。 */
export function encodeFrame(frame) {
  const data = Buffer.isBuffer(frame.payload) ? frame.payload : Buffer.from(frame.payload ?? []);
  if (frame.opcode >= 0x8) {
    if (data.length > MAX_CONTROL_PAYLOAD) throw new Error(`控制帧载荷不能超过 ${MAX_CONTROL_PAYLOAD} 字节`);
    if (frame.fin === false) throw new Error('控制帧不能被分片');
  }
  return frameParts({ fin: true, mask: false, rsv: 0, ...frame, payload: data });
}

function frameParts(frame) {
  const bytes = [];
  bytes.push((frame.fin === false ? 0x00 : 0x80) | ((frame.rsv ?? 0) << 4) | (frame.opcode & 0x0f));
  const data = Buffer.isBuffer(frame.payload) ? frame.payload : Buffer.from(frame.payload ?? []);
  const maskBit = frame.mask ? 0x80 : 0x00;
  if (data.length < 126) bytes.push(maskBit | data.length);
  else if (data.length < 65536) {
    bytes.push(maskBit | 126);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length, 0);
    bytes.push(...length);
  } else {
    bytes.push(maskBit | 127);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length), 0);
    bytes.push(...length);
  }
  if (!frame.mask) {
    bytes.push(...data);
    return Buffer.from(bytes);
  }
  const maskKey = frame.maskKey ?? randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ maskKey[i % 4];
  bytes.push(...maskKey, ...masked);
  return Buffer.from(bytes);
}

export { frameParts };

/**
 * 增量解析器：把 TCP 分片喂进来，产出完整的消息/控制帧。
 * `push()` 返回 {messages:[], events:[], rest:Buffer}
 */
export function createFrameParser(options = {}) {
  const maxPayload = options.maxPayload ?? 8 * 1024 * 1024;
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = null;
  let fragmentSize = 0;

  function parseFrames(chunk) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    const frames = [];
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = (first >> 4) & 0x07;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) break;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) break;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('帧过大');
        length = Number(big);
        offset += 8;
      }
      if (rsv !== 0) throw new Error('不支持扩展（RSV 位非零）');
      if (length > maxPayload) {
        const error = new Error(`帧载荷超过上限：${length}`);
        error.code = 'too_large';
        throw error;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) break;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + length);
      frames.push({ fin, opcode, masked, payload: Buffer.from(payload) });
    }
    return frames;
  }

  function push(chunk) {
    const messages = [];
    const events = [];
    for (const frame of parseFrames(chunk)) {
      switch (frame.opcode) {
        case OPCODE.CONTINUATION: {
          if (fragmentOpcode === null) throw new Error('意外的续帧');
          fragments.push(frame.payload);
          fragmentSize += frame.payload.length;
          if (fragmentSize > maxPayload) throw new Error('分片消息过大');
          if (frame.fin) {
            messages.push({ type: fragmentOpcode === OPCODE.TEXT ? 'text' : 'binary', data: Buffer.concat(fragments) });
            fragments = [];
            fragmentOpcode = null;
            fragmentSize = 0;
          }
          break;
        }
        case OPCODE.TEXT:
        case OPCODE.BINARY: {
          if (!frame.fin) {
            fragmentOpcode = frame.opcode;
            fragments = [frame.payload];
            fragmentSize = frame.payload.length;
          } else {
            messages.push({ type: frame.opcode === OPCODE.TEXT ? 'text' : 'binary', data: frame.payload });
          }
          break;
        }
        case OPCODE.PING:
          events.push({ type: 'ping', data: frame.payload });
          break;
        case OPCODE.PONG:
          events.push({ type: 'pong', data: frame.payload });
          break;
        case OPCODE.CLOSE: {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null;
          const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
          events.push({ type: 'close', code, reason });
          break;
        }
        default:
          throw new Error(`未知 opcode: ${frame.opcode}`);
      }
    }
    return { messages, events, rest: buffer };
  }

  return { push, get buffered() {
    return buffer.length;
  } };
}

/**
 * 把 WebSocket 连接包成「一次一个消息」的事件接口。
 * 服务端与 Node 测试客户端共用。
 */
export function createSocketChannel(socket, options = {}) {
  const parser = createFrameParser({ maxPayload: options.maxPayload });
  const handlers = { message: [], close: [], error: [], pong: [] };
  let closed = false;

  function emit(type, payload) {
    for (const handler of handlers[type] ?? []) handler(payload);
  }

  function send(text, { binary = false } = {}) {
    if (closed) return false;
    socket.write(frameParts({ opcode: binary ? OPCODE.BINARY : OPCODE.TEXT, payload: Buffer.from(text) }));
    return true;
  }

  function ping(data = Buffer.alloc(0)) {
    if (!closed) socket.write(frameParts({ opcode: OPCODE.PING, payload: data }));
  }

  function close(code = CLOSE_CODE.NORMAL, reason = '') {
    if (closed) return;
    closed = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      socket.write(frameParts({ opcode: OPCODE.CLOSE, payload }));
      socket.end();
    } catch {
      /* 忽略 */
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return;
    let result;
    try {
      result = parser.push(chunk);
    } catch (error) {
      emit('error', error);
      close(CLOSE_CODE.PROTOCOL_ERROR, '解析失败');
      return;
    }
    for (const message of result.messages) {
      emit('message', { type: message.type, data: message.data.toString('utf8'), length: message.data.length });
    }
    for (const event of result.events) {
      if (event.type === 'ping') socket.write(frameParts({ opcode: OPCODE.PONG, payload: event.data }));
      else if (event.type === 'pong') emit('pong', event);
      else if (event.type === 'close') {
        emit('close', { code: event.code ?? CLOSE_CODE.NO_STATUS, reason: event.reason, clean: true });
        closed = true;
        socket.end();
      }
    }
  });

  socket.on('error', (error) => emit('error', error));
  socket.on('close', () => {
    if (!closed) {
      closed = true;
      emit('close', { code: CLOSE_CODE.ABNORMAL, reason: '连接断开', clean: false });
    }
  });

  return {
    send,
    ping,
    close,
    on(type, handler) {
      (handlers[type] ??= []).push(handler);
      return this;
    },
    get closed() {
      return closed;
    },
    sendText: send,
  };
}
