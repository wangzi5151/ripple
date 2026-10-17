/**
 * Ripple 服务器：静态站点 + WebSocket 同步端点 + 只读监控 API。
 *
 * 零运行时依赖：只用 node:http / node:fs / node:crypto。
 * 启动：node server/index.js --port 8787 [--data .data] [--host 0.0.0.0] [--static-only]
 *
 * 职责：
 *  - `/` 及静态资源：直接跑手机端 PWA（同一份代码也能从 GitHub Pages 提供，此时不联网同步）；
 *  - `/ws`：WebSocket，把消息交给零知识的房间中枢 hub；
 *  - `/api/*`：健康检查与房间元数据（绝不返回 op 内容）。
 */

import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHub } from './hub.js';
import { createSocketChannel, makeHandshakeResponse, parseHttpHeaders } from './ws.js';
import { createRoomStore } from './persist.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const SRC_DIR = path.join(ROOT, 'src');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function contentTypeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (normalized.includes('..') || normalized.split('/').some((part) => part.startsWith('.'))) return null;
  const full = path.join(root, normalized);
  return full.startsWith(root) ? full : null;
}

async function statFile(filePath) {
  try {
    const info = await fsp.stat(filePath);
    if (info.isDirectory()) return statFile(path.join(filePath, 'index.html'));
    return info;
  } catch {
    return null;
  }
}

export function createRippleServer(options = {}) {
  const quiet = options.quiet === true;
  const log = (event, detail = {}) => {
    if (quiet) return;
    const stamp = new Date().toISOString();
    console.log(`[ripple ${stamp}] ${event} ${Object.keys(detail).length ? JSON.stringify(detail) : ''}`.trim());
  };
  const hub = createHub({ log: (event, detail) => log(`hub:${event}`, detail), limits: options.limits });
  const store = options.dataDir ? createRoomStore(options.dataDir, { log: (e, d) => log(`store:${e}`, d) }) : null;
  const staticOnly = options.staticOnly === true;
  const startedAt = Date.now();
  const peers = new Map(); // socket -> {channel, ctx}
  let requests = 0;

  /**
   * 落盘：hub 是纯逻辑，这里负责把「被接受的 op」和「新快照」写进 JSONL。
   * 被接受的 op 恰好就是广播出去的那条 ops 消息，因此不需要额外接口。
   */
  const originalHandle = hub.handle.bind(hub);
  const handleWithPersist = (ctx, msg) => {
    const deliveries = originalHandle(ctx, msg);
    if (!store) return deliveries;
    for (const delivery of deliveries) {
      if (delivery.to === '*' && delivery.msg?.t === 'ops') {
        for (const op of delivery.msg.ops ?? []) store.appendOp(ctx.room, op);
      }
    }
    if (msg.t === 'snapshot') {
      const exported = hub.exportRoom(ctx.room);
      if (exported?.snapshot) store.appendSnapshot(ctx.room, exported.snapshot);
      store.appendHorizon(ctx.room, exported?.horizon ?? {});
    }
    if (msg.t === 'hello' && ctx.room) {
      const info = hub.roomInfo(ctx.room);
      if (info && Object.keys(info.horizon).length > 0) store.appendHorizon(ctx.room, info.horizon);
    }
    return deliveries;
  };

  const server = http.createServer(async (req, res) => {
    requests += 1;
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
      res.end(body);
    };
    const json = (status, payload) =>
      send(status, JSON.stringify(payload, null, 2), { 'content-type': 'application/json; charset=utf-8' });

    if (url.pathname === '/api/health') {
      return json(200, {
        ok: true,
        name: 'ripple',
        version: options.version ?? '0.1.0',
        uptimeMs: Date.now() - startedAt,
        rooms: hub.stats().rooms,
        peers: hub.stats().peers,
        persistence: Boolean(store),
        staticOnly,
      });
    }
    if (url.pathname === '/api/stats') return json(200, { ...hub.stats(), requests, uptimeMs: Date.now() - startedAt });
    if (url.pathname === '/api/rooms') return json(200, hub.listRooms());
    if (url.pathname.startsWith('/api/rooms/')) {
      const roomId = url.pathname.slice('/api/rooms/'.length);
      const info = hub.roomInfo(roomId);
      return info ? json(200, info) : json(404, { error: 'room_not_found' });
    }
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'not_found' });

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');

    const candidates = [];
    const inSrc = safeJoin(SRC_DIR, url.pathname === '/' ? '/index.html' : url.pathname);
    const inPublic = safeJoin(PUBLIC_DIR, url.pathname);
    if (inSrc) candidates.push(inSrc);
    if (inPublic) candidates.push(inPublic);

    for (const candidate of candidates) {
      const info = await statFile(candidate);
      if (!info) continue;
      const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;
      const headers = {
        'content-type': contentTypeOf(candidate),
        etag,
        'cache-control': candidate.endsWith('sw.js') || candidate.endsWith('.html') ? 'no-cache' : 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...headers, 'content-length': info.size });
        return res.end();
      }
      const body = await fsp.readFile(candidate);
      res.writeHead(200, { ...headers, 'content-length': body.length });
      return res.end(body);
    }

    // SPA 回退：只有导航请求才给 index.html
    if ((req.headers.accept ?? '').includes('text/html')) {
      const index = path.join(SRC_DIR, 'index.html');
      const body = await fsp.readFile(index);
      return send(200, body, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    }
    return send(404, 'not found');
  });

  server.on('upgrade', (req, socket) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (staticOnly || pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    let response;
    try {
      response = makeHandshakeResponse(req.headers['sec-websocket-key'] ? buildRawRequest(req) : '');
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(response);
    socket.setNoDelay(true);
    const channel = createSocketChannel(socket, { maxPayload: options.maxMessageBytes ?? 512 * 1024 });
    const ctx = { client: null, room: null, alive: true };
    peers.set(socket, { channel, ctx });
    log('ws:connect', { peer: `${socket.remoteAddress}:${socket.remotePort}` });

    const heartbeat = setInterval(() => {
      if (!ctx.alive) {
        channel.close(1001, '心跳超时');
        return;
      }
      ctx.alive = false;
      channel.ping();
    }, options.heartbeatMs ?? 30_000);
    heartbeat.unref?.();

    channel.on('pong', () => {
      ctx.alive = true;
    });

    channel.on('message', (message) => {
      ctx.alive = true;
      let parsed;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        channel.send(JSON.stringify({ t: 'error', code: 'bad_message', msg: '消息不是合法 JSON' }));
        return;
      }
      if (parsed.t === 'hello' && parsed.client) ctx.client = String(parsed.client);
      let deliveries;
      try {
        deliveries = handleWithPersist(ctx, parsed);
      } catch (error) {
        log('ws:error', { error: String(error) });
        channel.send(JSON.stringify({ t: 'error', code: 'internal_error', msg: String(error?.message ?? error) }));
        return;
      }
      broadcast(deliveries, socket);
    });

    channel.on('close', ({ code, reason }) => {
      clearInterval(heartbeat);
      peers.delete(socket);
      for (const delivery of hub.disconnect(ctx)) broadcast([delivery], socket);
      log('ws:close', { code, reason: reason || undefined, client: ctx.client });
    });

    channel.on('error', (error) => {
      log('ws:error', { error: String(error?.message ?? error) });
    });
  });

  function broadcast(deliveries, fromSocket) {
    for (const delivery of deliveries) {
      if (delivery.to === '*') {
        for (const [socket, { channel, ctx }] of peers) {
          if (socket === fromSocket && delivery.except === ctx.client) continue;
          if (delivery.room && ctx.room !== delivery.room) continue;
          channel.send(JSON.stringify(delivery.msg));
        }
      } else {
        for (const [, { channel, ctx }] of peers) {
          if (ctx.client === delivery.to) channel.send(JSON.stringify(delivery.msg));
        }
      }
    }
  }

  function buildRawRequest(req) {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else lines.push(`${key}: ${value}`);
    }
    return `${lines.join('\r\n')}\r\n\r\n`;
  }

  return {
    server,
    hub,
    store,
    log,
    async listen({ port = 8787, host = '0.0.0.0' } = {}) {
      if (store) {
        const rooms = await store.load();
        for (const [roomId, state] of rooms) {
          hub.loadRoom(roomId, state);
          log('restore', { room: roomId, ops: state.ops.length, snapshot: Boolean(state.snapshot) });
        }
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      for (const [socket, { channel }] of peers) {
        channel.close(1001, '服务器关闭');
        socket.destroy();
      }
      peers.clear();
      await new Promise((resolve) => server.close(resolve));
      if (store) await store.close();
    },
    get staticOnly() {
      return staticOnly;
    },
  };
}

/* ----------------------------- CLI ----------------------------- */

function parseArgs(argv) {
  const args = { port: 8787, host: '0.0.0.0', data: null, staticOnly: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--data') args.data = argv[++i];
    else if (arg === '--static-only') args.staticOnly = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--no-data') args.data = null;
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const app = createRippleServer({
    dataDir: args.data === null ? path.join(ROOT, '.data') : args.data,
    staticOnly: args.staticOnly,
    quiet: args.quiet,
  });
  const address = await app.listen({ port: args.port, host: args.host });
  app.log('ready', { url: `http://${args.host}:${address.port}`, ws: `ws://${args.host}:${address.port}/ws`, staticOnly: args.staticOnly });
  const shutdown = async (signal) => {
    app.log('shutdown', { signal });
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

export { parseArgs, safeJoin, parseHttpHeaders };
