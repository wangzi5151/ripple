/**
 * 服务器端日志持久化：每个房间一个 JSONL 追加文件。
 *
 * 只用 node 标准库：追加写 + 定期 fsync 语义由操作系统保证；
 * 崩溃后最多丢最后一条未落盘的记录，客户端下次握手会自动补上（op 幂等）。
 * 房间 id 只保留十六进制字符，避免路径穿越。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function safeRoomId(roomId) {
  const cleaned = String(roomId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'room';
}

export function createRoomStore(dir, options = {}) {
  const log = options.log ?? (() => {});
  const queue = new Map();
  let flushing = false;
  let closed = false;

  async function ensureDir() {
    await fsp.mkdir(dir, { recursive: true });
  }

  function filePath(roomId) {
    return path.join(dir, `${safeRoomId(roomId)}.jsonl`);
  }

  function enqueue(roomId, record) {
    if (closed) return;
    const id = safeRoomId(roomId);
    const list = queue.get(id) ?? [];
    list.push(JSON.stringify(record));
    queue.set(id, list);
    void flush();
  }

  async function flush() {
    if (flushing || closed) return;
    const batch = [...queue.entries()].filter(([, lines]) => lines.length > 0);
    if (batch.length === 0) return;
    flushing = true;
    try {
      await ensureDir();
      for (const [roomId, lines] of batch) {
        queue.set(roomId, []);
        await fsp.appendFile(filePath(roomId), `${lines.join('\n')}\n`, 'utf8');
      }
    } catch (error) {
      log('persist-error', { error: String(error) });
    } finally {
      flushing = false;
      if ([...queue.values()].some((lines) => lines.length > 0)) void flush();
    }
  }

  return {
    filePath,
    appendOp(roomId, op) {
      enqueue(roomId, { t: 'op', op });
    },
    appendSnapshot(roomId, snapshot) {
      enqueue(roomId, { t: 'snapshot', snapshot });
    },
    appendHorizon(roomId, horizon) {
      enqueue(roomId, { t: 'horizon', horizon });
    },
    async flushAll() {
      while ([...queue.values()].some((lines) => lines.length > 0)) {
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
      await flush();
    },
    async close() {
      await this.flushAll();
      closed = true;
    },
    /** 启动时把磁盘内容读回来，喂给 hub.loadRoom()。 */
    async load() {
      await ensureDir();
      const rooms = new Map();
      let files = [];
      try {
        files = await fsp.readdir(dir);
      } catch {
        return rooms;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const roomId = file.replace(/\.jsonl$/, '');
        const state = { room: roomId, ops: [], snapshot: null, horizon: null };
        const text = await fsp.readFile(path.join(dir, file), 'utf8');
        for (const line of text.split('\n')) {
          if (line.trim().length === 0) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue; // 半行写入：忽略
          }
          if (record.t === 'op') state.ops.push(record.op);
          else if (record.t === 'snapshot') state.snapshot = record.snapshot;
          else if (record.t === 'horizon') state.horizon = record.horizon;
        }
        rooms.set(roomId, state);
      }
      return rooms;
    },
    /** 手动触发一次 GC/压缩（把 op 日志重写成快照 + 尾巴），由运维调用。 */
    async compactFile(roomId, { ops = [], snapshot = null, horizon = null } = {}) {
      await ensureDir();
      const target = filePath(roomId);
      const tmp = `${target}.tmp`;
      const lines = [];
      if (snapshot) lines.push(JSON.stringify({ t: 'snapshot', snapshot }));
      if (horizon) lines.push(JSON.stringify({ t: 'horizon', horizon }));
      for (const op of ops) lines.push(JSON.stringify({ t: 'op', op }));
      await fsp.writeFile(tmp, `${lines.join('\n')}\n`, 'utf8');
      await fsp.rename(tmp, target);
      log('compact', { room: roomId, ops: ops.length, hasSnapshot: Boolean(snapshot) });
    },
    exists(roomId) {
      return fs.existsSync(filePath(roomId));
    },
  };
}
