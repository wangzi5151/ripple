/**
 * 客户端同步引擎。
 *
 * 职责边界很清楚：
 *  - 引擎**不认识**看板语义，只认识「op 集合 + 版本向量」；
 *  - 网络只做「传 op」，冲突解决全部由 CRDT 负责，因此不需要锁、不需要重试队列的语义；
 *  - 离线期间产生的 op 靠「重连时的双向 delta 握手」补齐，不需要逐条 ack。
 *
 * 状态机：idle → connecting → syncing → online ⇄ offline → connecting …
 */

import { Doc } from '../crdt/doc.js';
import { MSG, decodeMessage, encodeMessage, hello, syncRequest, opsMessage, validateEnvelope } from './protocol.js';
import { encryptOps, decryptOps } from './crypto.js';
import { createSaver, pickStorage } from './storage.js';

export const STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  SYNCING: 'syncing',
  ONLINE: 'online',
  OFFLINE: 'offline',
  ERROR: 'error',
};

export function createSyncEngine(options = {}) {
  const storage = options.storage ?? pickStorage(options);
  const timer = options.timer ?? globalThis.setTimeout;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());
  const transportFactory = options.transportFactory ?? webSocketTransportFactory;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const baseBackoffMs = options.baseBackoffMs ?? 800;

  let doc = options.doc ?? new Doc({ node: options.clientId ?? randomClientId() });
  let room = options.room ?? 'ripple';
  let key = options.key ?? null;
  let transport = null;
  let status = STATUS.IDLE;
  let peers = [];
  let remoteVersion = {};
  let attempt = 0;
  let reconnectTimer = null;
  let stopped = true;
  let lastError = null;
  let stats = { sent: 0, received: 0, applied: 0, handshakes: 0, failures: 0, lastSyncAt: null, bytes: 0 };
  const listeners = new Set();

  const saver = createSaver(storage, { delayMs: options.saveDelayMs ?? 400, onError: (error) => emit({ type: 'error', error, scope: 'storage' }) });

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        // 监听器出错不能影响同步
        if (typeof console !== 'undefined') console.error('[sync] listener failed', error);
      }
    }
  }

  function setStatus(next, detail = null) {
    if (status === next && !detail) return;
    status = next;
    emit({ type: 'status', status, detail, remoteVersion, peers, pending: pendingCount() });
  }

  function payload() {
    return {
      doc: doc.toJSON(),
      remoteVersion,
      clientId: doc.node,
      room,
      savedAt: new Date(now()).toISOString(),
    };
  }

  function persist() {
    saver.schedule(payload());
  }

  /** 服务器尚未拥有的本地 op 数量（UI 用它显示「待同步」）。 */
  function pendingCount() {
    let count = 0;
    for (const op of doc.allOps()) {
      if (op.q > (remoteVersion?.[op.n] ?? 0)) count += 1;
    }
    return count;
  }

  function send(message) {
    if (!transport) return false;
    const text = encodeMessage(message);
    stats.bytes += text.length;
    transport.send(text);
    return true;
  }

  async function sendOps(ops, { done = true } = {}) {
    if (ops.length === 0) {
      send(opsMessage([], { done }));
      return;
    }
    const wire = key ? await encryptOps(key, ops) : ops;
    for (const op of wire) validateEnvelope(op);
    const max = options.opsPerMessage ?? 500;
    for (let i = 0; i < wire.length; i += max) {
      const chunk = wire.slice(i, i + max);
      send(opsMessage(chunk, { encrypt: Boolean(key), done: done && i + max >= wire.length }));
      stats.sent += chunk.length;
    }
  }

  async function handleMessage(text) {
    let message;
    try {
      message = decodeMessage(text);
    } catch (error) {
      emit({ type: 'error', error, scope: 'protocol' });
      return;
    }
    emit({ type: 'message', message, direction: 'in' });

    switch (message.t) {
      case MSG.WELCOME: {
        peers = message.peers ?? [];
        emit({ type: 'peers', peers });
        if (message.snapshotRequired && message.snapshot) {
          doc.mergeSnapshot(message.snapshot);
          emit({ type: 'snapshot', snapshot: message.snapshot });
        }
        setStatus(STATUS.SYNCING);
        // 双向 delta 握手：先报「我有什么」，再让对方补我缺的
        send(syncRequest({ have: doc.version(), reply: true }));
        stats.handshakes += 1;
        break;
      }
      case MSG.SYNC: {
        // 服务器把「它现在有什么」告诉我们：这是最准的「已同步到哪」的水位
        if (message.have) {
          remoteVersion = message.have;
          emit({ type: 'version', version: doc.version(), remoteVersion });
        }
        const missing = doc.opsMissingFrom(message.have ?? {});
        await sendOps(missing, { done: true });
        // 从服务端收到它的版本水位后，我们已知服务器的持久状态；把本地当前向量并入水位，
        // 避免把刚送达的本地 op 再错误计入 pending。服务器对缺失的远端 op 会随后广播。
        if (message.have) {
          for (const [node, seq] of Object.entries(doc.version())) {
            remoteVersion[node] = Math.max(remoteVersion[node] ?? 0, seq);
          }
        }
        if (message.reply) {
          // 对方也要我这边缺的：发一次不要求回应的请求，握手就此收敛
          send(syncRequest({ have: doc.version(), reply: false }));
        }
        break;
      }
      case MSG.OPS: {
        let ops = message.ops ?? [];
        if (key) {
          try {
            ops = await decryptOps(key, ops);
          } catch (error) {
            emit({ type: 'error', error, scope: 'crypto' });
            break;
          }
        }
        const applied = doc.addOps(ops);
        stats.received += ops.length;
        stats.applied += applied;
        if (applied > 0) {
          emit({ type: 'ops', ops, applied });
          persist();
        }
        emit({ type: 'version', version: doc.version() });
        if (message.done !== false && status === STATUS.SYNCING) {
          remoteVersion = doc.version();
          stats.lastSyncAt = new Date(now()).toISOString();
          setStatus(STATUS.ONLINE);
        }
        break;
      }
      case MSG.PRESENCE:
        peers = message.peers ?? [];
        emit({ type: 'peers', peers });
        setStatus(status, 'presence');
        break;
      case MSG.ERROR:
        lastError = message;
        stats.failures += 1;
        emit({ type: 'error', error: new Error(`${message.code}: ${message.msg}`), scope: 'server' });
        if (message.code === 'unsupported_version') {
          setStatus(STATUS.ERROR, message.msg);
          close();
        }
        break;
      default:
        emit({ type: 'message', message, direction: 'in', unknown: true });
    }
  }

  function open() {
    if (stopped) return;
    setStatus(STATUS.CONNECTING);
    try {
      transport = transportFactory({
        url: options.url,
        onOpen: () => {
          attempt = 0;
          send(
            hello({
              room,
              client: doc.node,
              name: options.name ?? null,
              caps: ['snapshot'],
              e2e: Boolean(key),
              // 带上「我有什么」，服务器据此判断是否必须发快照，省掉一次往返
              have: doc.version(),
            }),
          );
        },
        onMessage: (text) => {
          void handleMessage(text).catch((error) => emit({ type: 'error', error, scope: 'handler' }));
        },
        onClose: (info) => {
          transport = null;
          if (stopped) return;
          emit({ type: 'disconnect', info });
          scheduleReconnect();
        },
        onError: (error) => {
          lastError = error;
          emit({ type: 'error', error, scope: 'transport' });
        },
      });
    } catch (error) {
      lastError = error;
      setStatus(STATUS.ERROR, String(error?.message ?? error));
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    attempt += 1;
    const capped = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.min(attempt - 1, 8));
    const jitter = Math.floor(random() * (capped / 3));
    const delay = capped + jitter;
    setStatus(STATUS.OFFLINE, `重连将在 ${Math.round(delay / 100) / 10}s 后`);
    stats.failures += 1;
    reconnectTimer = timer(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function close() {
    if (transport) {
      transport.close();
      transport = null;
    }
  }

  return {
    get status() {
      return status;
    },
    get peers() {
      return peers;
    },
    get stats() {
      return { ...stats, pending: pendingCount() };
    },
    get doc() {
      return doc;
    },
    get lastError() {
      return lastError;
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async load() {
      const saved = await storage.load();
      if (saved?.doc) {
        doc = Doc.fromJSON(saved.doc);
        remoteVersion = saved.remoteVersion ?? {};
        emit({ type: 'loaded', saved });
      }
      return saved;
    },

    start() {
      stopped = false;
      if (transport) return;
      open();
    },

    stop() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      close();
      setStatus(STATUS.IDLE);
      return saver.flush();
    },

    /** 本地产生了新 op：立刻上线（若在离线，靠重连握手补发）。 */
    pushOps(ops) {
      persist();
      if (ops.length === 0) return Promise.resolve();
      if (status === STATUS.ONLINE || status === STATUS.SYNCING) {
        return sendOps(ops, { done: true });
      }
      emit({ type: 'queued', ops, pending: pendingCount() });
      return Promise.resolve();
    },

    /** 手动触发一次握手（「立即同步」按钮）。 */
    syncNow() {
      if (status === STATUS.ONLINE || status === STATUS.SYNCING) {
        send(syncRequest({ have: doc.version(), reply: true }));
        setStatus(STATUS.SYNCING);
        return true;
      }
      if (!transport) open();
      return false;
    },

    /** 切换房间密钥（导入别人的分享链接时用）。 */
    setKey(nextKey) {
      key = nextKey ?? null;
      return key;
    },

    setRoom(nextRoom) {
      room = nextRoom;
      remoteVersion = {};
      return room;
    },

    /** 供「设备模拟器」等场景替换本地文档（测试与演示用）。 */
    replaceDoc(nextDoc) {
      doc = nextDoc;
      persist();
      return doc;
    },

    async clearStorage() {
      await storage.clear();
    },

    async flush() {
      await saver.flush();
    },

    get storageName() {
      return storage.name;
    },

    view() {
      return {
        status,
        room,
        clientId: doc.node,
        pending: pendingCount(),
        peers: peers.map((peer) => ({ ...peer })),
        remoteVersion: { ...remoteVersion },
        stats: { ...stats, pending: pendingCount() },
        opCount: doc.opCount,
        docVersion: doc.version(),
      };
    },
  };
}

export function randomClientId(prefix = 'dev') {
  const bytes = new Uint8Array(4);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 浏览器 WebSocket 适配器；测试里换成内存实现即可。 */
export function webSocketTransportFactory({ url, onOpen, onMessage, onClose, onError }) {
  const socket = new WebSocket(url);
  socket.onopen = () => onOpen?.();
  socket.onmessage = (event) => onMessage?.(typeof event.data === 'string' ? event.data : String(event.data));
  socket.onclose = (event) => onClose?.({ code: event.code, reason: event.reason, clean: event.wasClean });
  socket.onerror = (event) => onError?.(new Error(`websocket error: ${event?.message ?? 'unknown'}`));
  return {
    send(text) {
      socket.send(text);
    },
    close() {
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
    },
  };
}
