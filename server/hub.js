/**
 * 房间中枢（纯逻辑，不碰 socket，方便单测）。
 *
 * 关键设计：**服务器是零知识的**。
 * 它只保存 op 信封（i/n/q/h + 可选密文载荷），不做语义解释、不生成快照。
 * 压缩由客户端发起：客户端上传自己的快照（对服务器是一坨不透明数据），
 * 服务器据此设置「日志地平线」并裁剪更早的 op。于是：
 *  - 端到端加密下服务器依然能工作（它本来就不需要看懂内容）；
 *  - 服务器永远不会成为冲突仲裁者，冲突只在客户端由 CRDT 解决。
 */

import {
  MSG,
  ERR,
  PROTOCOL_VERSION,
  errorMessage,
  opsMessage,
  syncRequest,
  validateEnvelope,
  welcome,
} from '../src/js/sync/protocol.js';

export const DEFAULT_LIMITS = {
  maxOpsPerRoom: 20_000,
  maxPeersPerRoom: 32,
  maxOpBytes: 16 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxRooms: 500,
};

export function createHub(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const rooms = new Map();
  const log = options.log ?? (() => {});
  let serverId = options.serverId ?? `srv-${Math.random().toString(36).slice(2, 8)}`;
  const counters = { messages: 0, opsAccepted: 0, opsRejected: 0, opsPruned: 0, snapshots: 0, joins: 0 };

  function getRoom(roomId, create = true) {
    let room = rooms.get(roomId);
    if (!room && create) {
      if (rooms.size >= limits.maxRooms) throw Object.assign(new Error('服务器房间数已达上限'), { code: ERR.RATE_LIMITED });
      room = {
        id: roomId,
        ops: new Map(),
        version: Object.create(null),
        horizon: Object.create(null),
        snapshot: null,
        peers: new Map(),
        createdAt: new Date().toISOString(),
        bytes: 0,
      };
      rooms.set(roomId, room);
    }
    return room;
  }

  function presenceOf(room) {
    return [...room.peers.entries()].map(([client, peer]) => ({
      client,
      name: peer.name,
      since: peer.joinedAt,
      e2e: peer.e2e,
    }));
  }

  function roomVersion(room) {
    return { ...room.version };
  }

  function opsMissingFrom(room, have = {}) {
    const out = [];
    for (const op of room.ops.values()) {
      if (op.q > (have[op.n] ?? 0)) out.push(op);
    }
    return out.sort((a, b) => a.h[0] - b.h[0] || a.h[1] - b.h[1] || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0) || a.q - b.q);
  }

  /** 客户端缺的 op 是否都还在日志里（否则要发快照）。 */
  function isCovered(have = {}, horizon = {}) {
    for (const [node, seq] of Object.entries(horizon)) {
      if ((have[node] ?? 0) < seq) return false;
    }
    return true;
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function prune(room, keepFrom = {}, { horizon = null } = {}) {
    let pruned = 0;
    for (const [id, op] of [...room.ops.entries()]) {
      const limit = (horizon ?? keepFrom)[op.n] ?? 0;
      if (op.q <= limit) {
        room.ops.delete(id);
        room.bytes -= JSON.stringify(op).length;
        pruned += 1;
      }
    }
    counters.opsPruned += pruned;
    return pruned;
  }

  function acceptOps(room, ops, fromClient) {
    const accepted = [];
    const rejected = [];
    for (const op of ops) {
      counters.messages += 0;
      try {
        validateEnvelope(op);
      } catch (error) {
        rejected.push({ id: op?.i ?? null, reason: error.message });
        counters.opsRejected += 1;
        continue;
      }
      if (room.ops.has(op.i)) continue; // 幂等：重复投递直接忽略
      const size = JSON.stringify(op).length;
      if (size > limits.maxOpBytes) {
        rejected.push({ id: op.i, reason: ERR.TOO_LARGE });
        counters.opsRejected += 1;
        continue;
      }
      room.ops.set(op.i, op);
      room.bytes += size;
      room.version[op.n] = Math.max(room.version[op.n] ?? 0, op.q);
      accepted.push(op);
    }
    counters.opsAccepted += accepted.length;
    if (accepted.length > 0) {
      log('ops', { room: room.id, from: fromClient, accepted: accepted.length, rejected: rejected.length });
      if (room.ops.size > limits.maxOpsPerRoom) shrink(room);
    }
    return { accepted, rejected };
  }

  /**
   * 超过上限时的背压：裁掉最旧的 op，并把地平线前移。
   * 这会通知客户端「历史被裁剪，请尽快上传快照」。
   */
  function shrink(room) {
    const byNode = new Map();
    for (const op of room.ops.values()) {
      const list = byNode.get(op.n) ?? [];
      list.push(op.q);
      byNode.set(op.n, list);
    }
    const target = Math.floor(limits.maxOpsPerRoom * 0.8);
    const toDrop = room.ops.size - target;
    const dropCandidates = [...room.ops.values()].sort((a, b) => a.h[0] - b.h[0] || a.h[1] - b.h[1] || a.q - b.q);
    const dropped = dropCandidates.slice(0, toDrop);
    for (const op of dropped) {
      room.ops.delete(op.i);
      room.bytes -= JSON.stringify(op).length;
      room.horizon[op.n] = Math.max(room.horizon[op.n] ?? 0, op.q);
    }
    counters.opsPruned += dropped.length;
    log('shrink', { room: room.id, dropped: dropped.length, horizon: { ...room.horizon } });
    return dropped.length;
  }

  function handle(ctx, msg) {
    counters.messages += 1;
    const out = [];
    switch (msg.t) {
      case MSG.HELLO: {
        if (msg.p !== PROTOCOL_VERSION) {
          out.push({ to: ctx.client, msg: errorMessage(ERR.UNSUPPORTED_VERSION, `协议版本 ${msg.p} 不受支持，服务器为 ${PROTOCOL_VERSION}`) });
          return out;
        }
        let room;
        try {
          room = getRoom(msg.room, true);
        } catch (error) {
          out.push({ to: ctx.client, msg: errorMessage(error.code ?? ERR.ROOM_FULL, error.message) });
          return out;
        }
        ctx.room = room.id;
        ctx.client = msg.client;
        if (!room.peers.has(ctx.client) && room.peers.size >= limits.maxPeersPerRoom) {
          out.push({ to: ctx.client, msg: errorMessage(ERR.ROOM_FULL, '房间在线设备数已达上限') });
          return out;
        }
        room.peers.set(ctx.client, {
          name: msg.name ?? null,
          joinedAt: new Date().toISOString(),
          e2e: msg.e2e === true,
        });
        counters.joins += 1;
        const have = msg.have ?? {};
        const needsSnapshot = Boolean(room.snapshot) && !isCovered(have, room.horizon);
        out.push({
          to: ctx.client,
          msg: {
            ...welcome({
              room: room.id,
              server: serverId,
              peers: presenceOf(room),
              version: roomVersion(room),
              snapshotRequired: needsSnapshot,
              limits: { maxOpsPerRoom: limits.maxOpsPerRoom, maxPeersPerRoom: limits.maxPeersPerRoom },
            }),
            ...(needsSnapshot ? { snapshot: room.snapshot } : {}),
          },
        });
        out.push({ to: '*', except: ctx.client, room: room.id, msg: { t: MSG.PRESENCE, peers: presenceOf(room) } });
        log('join', { room: room.id, client: ctx.client, ops: room.ops.size });
        return out;
      }

      case MSG.SYNC: {
        const room = rooms.get(ctx.room);
        if (!room) {
          out.push({ to: ctx.client, msg: errorMessage(ERR.BAD_MESSAGE, '请先发送 hello') });
          return out;
        }
        const have = msg.have ?? {};
        if (!isCovered(have, room.horizon)) {
          // 客户端缺的 op 已被裁剪：只能给状态快照（如果有的话）
          if (room.snapshot) {
            out.push({ to: ctx.client, msg: { t: MSG.SNAPSHOT, snapshot: room.snapshot, reason: 'history_pruned' } });
          } else {
            out.push({
              to: ctx.client,
              msg: errorMessage(ERR.RATE_LIMITED, '房间历史已裁剪且暂无快照，需要等待在线设备上传快照'),
            });
          }
        }
        const missing = opsMissingFrom(room, have);
        for (const part of chunk(missing, 500)) {
          out.push({ to: ctx.client, msg: opsMessage(part, { done: false }) });
        }
        out.push({
          to: ctx.client,
          msg: opsMessage([], { done: true }),
        });
        if (msg.reply) {
          out.push({ to: ctx.client, msg: syncRequest({ have: roomVersion(room), reply: false }) });
        }
        log('sync', { room: room.id, client: ctx.client, sent: missing.length });
        return out;
      }

      case MSG.OPS: {
        const room = rooms.get(ctx.room);
        if (!room) {
          out.push({ to: ctx.client, msg: errorMessage(ERR.BAD_MESSAGE, '请先发送 hello') });
          return out;
        }
        const { accepted, rejected } = acceptOps(room, msg.ops ?? [], ctx.client);
        // 始终返回一个带房间标记的传播事件：HTTP 层据此只发给同房间 peer；
        // 没有其他 peer 时结果也可为空，而不是把事件发到别的房间。
        if (accepted.length > 0 && room.peers.size > 1) {
          out.push({ to: '*', except: ctx.client, room: room.id, msg: opsMessage(accepted, { done: false, enc: msg.enc }) });
        }
        if (rejected.length > 0) {
          out.push({ to: ctx.client, msg: errorMessage(ERR.BAD_MESSAGE, `有 ${rejected.length} 条 op 被拒绝：${rejected[0].reason}`) });
        }
        return out;
      }

      case MSG.SNAPSHOT: {
        const room = rooms.get(ctx.room);
        if (!room) return out;
        const size = JSON.stringify(msg.snapshot ?? null).length;
        if (size > limits.maxSnapshotBytes) {
          out.push({ to: ctx.client, msg: errorMessage(ERR.TOO_LARGE, '快照超过大小限制') });
          return out;
        }
        room.snapshot = msg.snapshot ?? null;
        room.horizon = { ...(msg.snapshot?.version ?? room.horizon) };
        counters.snapshots += 1;
        const pruned = prune(room, {}, { horizon: room.horizon });
        log('snapshot', { room: room.id, size, pruned });
        out.push({ to: ctx.client, msg: syncRequest({ have: roomVersion(room), reply: false }) });
        return out;
      }

      case MSG.PRESENCE: {
        const room = rooms.get(ctx.room);
        if (!room) return out;
        out.push({ to: '*', except: ctx.client, room: room.id, msg: { t: MSG.PRESENCE, peers: presenceOf(room) } });
        return out;
      }

      case MSG.BYE: {
        return disconnect(ctx);
      }

      default:
        out.push({ to: ctx.client, msg: errorMessage(ERR.BAD_MESSAGE, `未知消息类型 ${msg.t}`) });
        return out;
    }
  }

  function disconnect(ctx) {
    const room = rooms.get(ctx.room);
    if (!room) return [];
    const existed = room.peers.delete(ctx.client);
    if (!existed) return [];
    log('leave', { room: room.id, client: ctx.client });
    if (room.peers.size === 0 && room.ops.size === 0 && !room.snapshot && options.dropEmptyRooms !== false) {
      rooms.delete(room.id);
      return [];
    }
    return [{ to: '*', room: room.id, msg: { t: MSG.PRESENCE, peers: presenceOf(room) } }];
  }

  return {
    handle,
    disconnect,
    limits,
    get serverId() {
      return serverId;
    },
    setServerId(id) {
      serverId = id;
    },
    stats() {
      let ops = 0;
      let peers = 0;
      for (const room of rooms.values()) {
        ops += room.ops.size;
        peers += room.peers.size;
      }
      return { rooms: rooms.size, ops, peers, ...counters };
    },
    roomInfo(roomId) {
      const room = rooms.get(roomId);
      if (!room) return null;
      return {
        id: room.id,
        ops: room.ops.size,
        bytes: room.bytes,
        peers: presenceOf(room),
        version: roomVersion(room),
        horizon: { ...room.horizon },
        hasSnapshot: Boolean(room.snapshot),
        createdAt: room.createdAt,
      };
    },
    listRooms() {
      return [...rooms.keys()].map((id) => this.roomInfo(id));
    },
    /** 从磁盘恢复：ops 数组 + 可选快照。 */
    loadRoom(roomId, { ops = [], snapshot = null, horizon = null } = {}) {
      const room = getRoom(roomId, true);
      room.snapshot = snapshot ?? null;
      if (horizon) room.horizon = { ...horizon };
      acceptOps(room, ops, 'restore');
      return this.roomInfo(roomId);
    },
    exportRoom(roomId) {
      const room = rooms.get(roomId);
      if (!room) return null;
      return { room: room.id, ops: [...room.ops.values()], snapshot: room.snapshot, horizon: { ...room.horizon } };
    },
    /** 测试用：重置全部状态。 */
    reset() {
      rooms.clear();
      Object.assign(counters, { messages: 0, opsAccepted: 0, opsRejected: 0, opsPruned: 0, snapshots: 0, joins: 0 });
    },
  };
}

/**
 * 内存传输对：把两个端点接在一起，可选择延迟、丢包与乱序。
 * 「设备模拟器」和集成测试都用它来伪造一个有损网络。
 */
export function createFakeNetwork(options = {}) {
  const delay = options.delay ?? 0;
  const dropRate = options.dropRate ?? 0;
  const random = options.random ?? Math.random;
  const timer = options.timer ?? setTimeout;
  const hubs = [];
  const endpoints = new Map();
  const contexts = new Map();
  let queue = [];

  function deliver(to, text) {
    const target = endpoints.get(to);
    if (!target || target.closed) return;
    if (random() < dropRate) return;
    const run = () => {
      if (!target.closed) target.receive(text);
    };
    if (delay > 0) timer(run, delay * (0.5 + random()));
    else run();
  }

  function flushQueue() {
    const local = queue;
    queue = [];
    for (const item of local) deliver(item.to, item.text);
  }

  return {
    /** 新的「客户端」，返回可以直接喂给同步引擎的 transportFactory。 */
    client(id) {
      return ({ onOpen, onMessage, onClose }) => {
        const endpoint = {
          id,
          closed: false,
          receive(text) {
            onMessage?.(text);
          },
        };
        endpoints.set(id, endpoint);
        queueMicrotask(() => onOpen?.());
        return {
          send(text) {
            for (const hub of hubs) hub.sendFrom(id, text);
          },
          close() {
            endpoint.closed = true;
            endpoints.delete(id);
            onClose?.({ code: 1000, clean: true });
          },
        };
      };
    },
    /** 挂一个「服务器」到网络上。 */
    attach(hub) {
      hubs.push({
        sendFrom(fromClient, text) {
          let message;
          try {
            message = JSON.parse(text);
          } catch {
            return;
          }
          let ctx = contexts.get(fromClient);
          if (!ctx) {
            ctx = { client: fromClient, room: null };
            contexts.set(fromClient, ctx);
          }
          const deliveries = hub.handle(ctx, message);
          for (const delivery of deliveries) {
            if (delivery.to === '*') {
              for (const id of endpoints.keys()) {
                if (id === delivery.except) continue;
                deliver(id, JSON.stringify(delivery.msg));
              }
            } else {
              deliver(delivery.to, JSON.stringify(delivery.msg));
            }
          }
        },
        disconnect(client) {
          const ctx = contexts.get(client) ?? { client, room: null };
          const deliveries = hub.disconnect(ctx);
          contexts.delete(client);
          for (const delivery of deliveries) {
            for (const id of endpoints.keys()) deliver(id, JSON.stringify(delivery.msg));
          }
        },
      });
      return hub;
    },
    /** 模拟「网络断了」：所有端点收到 close。 */
    partition() {
      for (const [id, endpoint] of [...endpoints.entries()]) {
        endpoint.closed = true;
        endpoints.delete(id);
        void id;
      }
      for (const hub of hubs) hub.disconnect?.('*');
    },
    flush: flushQueue,
    endpoints,
  };
}
