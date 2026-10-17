/**
 * 测试辅助：可用的假网络 + Node 版 WebSocket 客户端传输。
 * 假网络能模拟延迟、丢包、乱序与断网，用来验证同步引擎的收敛性。
 */
import net from 'node:net';

import {
  acceptKey,
  createFrameParser,
  frameParts,
  makeHandshakeRequest,
  OPCODE,
  parseHttpHeaders,
} from '../../server/ws.js';
import { createFakeNetwork } from '../../server/hub.js';

export { createFakeNetwork };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function waitFor(predicate, { timeoutMs = 4000, intervalMs = 5, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`等待超时：${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** 打开一个真正的 WebSocket 客户端连接（手写握手 + 帧）。 */
export async function openWsClient(url, { timeoutMs = 3000 } = {}) {
  const parsed = new URL(url.startsWith('ws') ? url : `ws://${url}`);
  const host = parsed.hostname;
  const port = Number(parsed.port || 80);
  const path = `${parsed.pathname}${parsed.search}` || '/ws';
  const socket = net.connect({ host, port });
  socket.setNoDelay(true);
  const { text: handshake, key } = makeHandshakeRequest({ host: `${host}:${port}`, path });

  const waiters = [];
  const queue = [];
  let closed = false;
  const parser = createFrameParser();

  function emit(message) {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  }

  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const bytes = Buffer.from(chunk);
      const marker = bytes.indexOf(Buffer.from('\r\n\r\n'));
      if (marker < 0) return;
      const headText = bytes.subarray(0, marker).toString('utf8');
      const { headers } = parseHttpHeaders(`${headText}\r\n\r\n`);
      socket.off('data', onData);
      if (headers['sec-websocket-accept'] !== acceptKey(key)) {
        reject(new Error('握手校验失败'));
        return;
      }
      const rest = bytes.subarray(marker + 4);
      socket.on('data', (data) => {
        parser.push(data).messages.forEach((message) => emit(message.data.toString('utf8')));
      });
      if (rest.length > 0) {
        parser.push(rest).messages.forEach((message) => emit(message.data.toString('utf8')));
      }
      resolve();
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.write(handshake);
    setTimeout(() => reject(new Error('握手超时')), timeoutMs).unref?.();
  });

  return {
    send(text) {
      if (closed) return;
      socket.write(frameParts({ opcode: OPCODE.TEXT, payload: Buffer.from(text), mask: true }));
    },
    next({ timeoutMs: t = 2000 } = {}) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待消息超时')), t);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    async nextJson(options) {
      return JSON.parse(await this.next(options));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        socket.write(frameParts({ opcode: OPCODE.CLOSE, payload: Buffer.alloc(2), mask: true }));
      } catch {
        /* 忽略 */
      }
      socket.destroy();
    },
    get socket() {
      return socket;
    },
  };
}

/** 给同步引擎用的 Node 传输工厂（浏览器里换成 WebSocket 即可）。 */
export function nodeWebSocketTransportFactory({ url, onOpen, onMessage, onClose, onError }) {
  let client = null;
  let closedByUs = false;
  openWsClient(url)
    .then((connection) => {
      if (closedByUs) {
        connection.close();
        return;
      }
      client = connection;
      onOpen?.();
      const pump = async () => {
        try {
          const message = await connection.next({ timeoutMs: 60_000 });
          onMessage?.(message);
          void pump();
        } catch (error) {
          if (!closedByUs) onClose?.({ code: 1006, reason: String(error?.message ?? error), clean: false });
        }
      };
      void pump();
    })
    .catch((error) => onError?.(error));

  return {
    send(text) {
      if (client) client.send(text);
      else setTimeout(() => client?.send(text), 10);
    },
    close() {
      closedByUs = true;
      client?.close();
    },
  };
}
