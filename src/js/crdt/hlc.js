/**
 * Hybrid Logical Clock.
 *
 * HLC 把物理时钟和逻辑计数器组合起来：既接近真实时间（便于 UI 展示和调试），
 * 又保证「若 A 因果先于 B，则 A 的时间戳严格小于 B」，并且是单调递增的。
 *
 * 时间戳统一表示为 [wall, counter] 二元组，比较规则见 compareHlc()。
 */

export const MAX_DRIFT_MS = 5 * 60 * 1000;

/** @param {[number, number]} a @param {[number, number]} b @returns {number} */
export function compareHlc(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

export function hlcToString(hlc) {
  return `${hlc[0]}:${hlc[1]}`;
}

export function hlcFromString(s) {
  const i = String(s).indexOf(':');
  return [Number(s.slice(0, i)), Number(s.slice(i + 1))];
}

export function maxHlc(list) {
  let best = null;
  for (const h of list) if (best === null || compareHlc(h, best) > 0) best = h;
  return best;
}

/**
 * 创建一个节点时钟。
 * @param {string} node 节点（设备／副本）标识
 * @param {{now?: () => number, maxDriftMs?: number, initial?: [number, number]}} [options]
 */
export function createClock(node, options = {}) {
  const now = options.now ?? (() => Date.now());
  const maxDriftMs = options.maxDriftMs ?? MAX_DRIFT_MS;
  let wall = 0;
  let counter = 0;
  let driftWarnings = 0;

  if (options.initial) {
    wall = options.initial[0];
    counter = options.initial[1];
  }

  /** 本地事件：返回新的时间戳。 */
  function tick() {
    const physical = now();
    if (physical > wall) {
      wall = physical;
      counter = 0;
    } else {
      counter += 1;
    }
    return [wall, counter];
  }

  /** 收到远端时间戳后推进本地时钟，保证后续 tick() 一定大于远端。 */
  function observe(remote) {
    const [remoteWall, remoteCounter] = remote;
    const physical = now();
    if (remoteWall - physical > maxDriftMs) {
      // 对端时钟明显走得太快：仍然接受（否则会破坏因果），但记录下来。
      driftWarnings += 1;
    }
    const nextWall = Math.max(physical, wall, remoteWall);
    if (nextWall === wall && nextWall === remoteWall) {
      counter = Math.max(counter, remoteCounter) + 1;
    } else if (nextWall === wall) {
      counter += 1;
    } else if (nextWall === remoteWall) {
      counter = remoteCounter + 1;
    } else {
      counter = 0;
    }
    wall = nextWall;
    return [wall, counter];
  }

  /** 只推进，不消费本地事件（用于合并快照的时钟水位）。 */
  function advance(remote) {
    if (compareHlc(remote, [wall, counter]) > 0) {
      wall = remote[0];
      counter = remote[1];
    }
    return [wall, counter];
  }

  return {
    node,
    tick,
    observe,
    advance,
    get state() {
      return [wall, counter];
    },
    get driftWarnings() {
      return driftWarnings;
    },
    toJSON() {
      return { node, state: [wall, counter] };
    },
    /** 测试／持久化用：注入物理时间源。 */
    setNow(fn) {
      options.now = fn;
      return this;
    },
  };
}
