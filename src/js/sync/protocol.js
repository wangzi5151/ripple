/**
 * 同步协议：客户端 ↔ 服务器之间的小型消息协议。
 *
 * 设计目标：
 *  - 状态无关：服务器只保管 op 日志与版本向量，不需要理解 op 的语义；
 *  - 终止性：握手期的双向 delta 交换用 reply 标志保证不会无限来回；
 *  - 可降级：客户端落后太多（日志已压缩）时改走「快照状态合并」；
 *  - 可加密：每个 op 的载荷可以单独加密，服务器仍能按 op id 去重与排版本。
 */

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 512 * 1024;
export const MAX_OPS_PER_MESSAGE = 500;

export const MSG = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  SYNC: 'sync',
  OPS: 'ops',
  SNAPSHOT: 'snapshot',
  PRESENCE: 'presence',
  ERROR: 'error',
  BYE: 'bye',
};

export const ERR = {
  BAD_MESSAGE: 'bad_message',
  UNSUPPORTED_VERSION: 'unsupported_version',
  ROOM_FULL: 'room_full',
  TOO_LARGE: 'too_large',
  DECRYPT_FAILED: 'decrypt_failed',
  RATE_LIMITED: 'rate_limited',
};

/** 只校验信封（服务器需要的那部分），语义交给客户端。 */
export function validateEnvelope(op) {
  if (!op || typeof op !== 'object') throw new Error('op must be an object');
  for (const field of ['i', 'n', 'q', 'h']) {
    if (op[field] === undefined) throw new Error(`op missing field "${field}"`);
  }
  if (typeof op.n !== 'string' || op.n.length === 0 || op.n.length > 64) throw new Error('bad op.n');
  if (!Number.isInteger(op.q) || op.q < 1) throw new Error('bad op.q');
  if (!Array.isArray(op.h) || op.h.length !== 2 || !Number.isFinite(op.h[0]) || !Number.isFinite(op.h[1])) {
    throw new Error('bad op.h');
  }
  if (op.z === 1) {
    if (typeof op.d !== 'string' || typeof op.iv !== 'string') throw new Error('encrypted op needs d and iv');
  } else if (typeof op.t !== 'string' || op.t.length === 0 || op.t.length > 8) {
    throw new Error('bad op.t');
  }
  return true;
}

export function encodeMessage(msg) {
  const text = JSON.stringify(msg);
  if (text.length > MAX_MESSAGE_BYTES) throw new Error(`message too large: ${text.length} bytes`);
  return text;
}

export function decodeMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    const error = new Error('invalid JSON');
    error.code = ERR.BAD_MESSAGE;
    throw error;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
    const error = new Error('message must be an object with "t"');
    error.code = ERR.BAD_MESSAGE;
    throw error;
  }
  return msg;
}

export function hello({ room, client, name = null, caps = [], e2e = false, have = null }) {
  return { t: MSG.HELLO, p: PROTOCOL_VERSION, room, client, name, caps, e2e, have };
}

export function welcome({ room, server, peers, version, snapshotRequired = false, limits = {} }) {
  return { t: MSG.WELCOME, p: PROTOCOL_VERSION, room, server, peers, version, snapshotRequired, limits };
}

export function syncRequest({ have, reply = true }) {
  return { t: MSG.SYNC, have, reply };
}

export function opsMessage(ops, { done = true, encrypted = false } = {}) {
  return { t: MSG.OPS, ops, done, enc: encrypted || undefined };
}

export function errorMessage(code, message) {
  return { t: MSG.ERROR, code, msg: message };
}

/**
 * 把 op 分批，避免单条消息超过上限。
 * @param {object[]} ops
 * @param {{encrypt?: (ops: object[]) => Promise<object[]>, max?: number}} [options]
 */
export async function packOps(ops, options = {}) {
  const max = options.max ?? MAX_OPS_PER_MESSAGE;
  const out = [];
  for (let i = 0; i < ops.length; i += max) {
    const chunk = ops.slice(i, i + max);
    const wire = options.encrypt ? await options.encrypt(chunk) : chunk;
    out.push(wire);
  }
  return out;
}

/** 一批消息里所有 op 的 id（服务器去重用）。 */
export function opIdsOf(ops) {
  return ops.map((op) => op.i).filter((id) => typeof id === 'string');
}

/**
 * 客户端缺的 op 是否都还在日志里：等价于「have 覆盖了地平线」。
 * 客户端领先（have 大于 horizon）是正常情况，不算缺失。
 */
export function coveredBy(have, horizon) {
  for (const [node, seq] of Object.entries(horizon ?? {})) {
    if ((have?.[node] ?? 0) < seq) return false;
  }
  return true;
}

/** 人类可读的一行同步摘要（调试面板用）。 */
export function describeMessage(msg) {
  switch (msg.t) {
    case MSG.HELLO:
      return `hello room=${msg.room} client=${msg.client} caps=[${msg.caps?.join(',') ?? ''}]`;
    case MSG.WELCOME:
      return `welcome peers=${msg.peers?.length ?? 0} snapshot=${Boolean(msg.snapshotRequired)}`;
    case MSG.SYNC:
      return `sync reply=${msg.reply} have=${Object.keys(msg.have ?? {}).length} node(s)`;
    case MSG.OPS:
      return `ops n=${msg.ops?.length ?? 0}${msg.enc ? ' (encrypted)' : ''} done=${msg.done !== false}`;
    case MSG.SNAPSHOT:
      return `snapshot entities=${msg.snapshot?.entities?.length ?? 0}`;
    case MSG.PRESENCE:
      return `presence peers=${msg.peers?.length ?? 0}`;
    case MSG.ERROR:
      return `error ${msg.code}: ${msg.msg}`;
    default:
      return `${msg.t}`;
  }
}
