/**
 * 持久化适配层。
 *
 * 统一接口：{ name, load(), save(payload), clear() }
 * payload 一定是可 JSON 序列化的：
 *   { doc: <Doc.toJSON()>, remoteVersion, clientId, room, savedAt }
 *
 * 优先 IndexedDB（手机端容量大、异步不卡 UI）；失败时退回 localStorage；
 * 再失败（隐私模式 / Node 测试）就用内存 —— 保证功能可用，只是不持久。
 */

export function memoryStorage(initial = null) {
  let data = initial;
  return {
    name: 'memory',
    async load() {
      return data;
    },
    async save(payload) {
      data = payload;
    },
    async clear() {
      data = null;
    },
    get _raw() {
      return data;
    },
  };
}

export function localStorageStorage(namespace = 'ripple:v1', storage = globalThis.localStorage) {
  if (!storage) return memoryStorage();
  return {
    name: 'localStorage',
    async load() {
      const text = storage.getItem(namespace);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    async save(payload) {
      storage.setItem(namespace, JSON.stringify(payload));
    },
    async clear() {
      storage.removeItem(namespace);
    },
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function indexedDBStorage(dbName = 'ripple', storeName = 'state', factory = globalThis.indexedDB) {
  if (!factory) return null;
  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = factory.open(dbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }
  async function withStore(mode, run) {
    const db = await open();
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = await run(store);
    return result;
  }
  return {
    name: 'indexedDB',
    async load() {
      return withStore('readonly', (store) => requestToPromise(store.get('snapshot')));
    },
    async save(payload) {
      await withStore('readwrite', (store) => requestToPromise(store.put(payload, 'snapshot')));
    },
    async clear() {
      await withStore('readwrite', (store) => requestToPromise(store.delete('snapshot')));
    },
  };
}

/** 依可用性挑一个存储后端。 */
export function pickStorage(options = {}) {
  if (options.storage) return options.storage;
  if (options.indexedDB === false) return localStorageStorage(options.namespace);
  const idb = indexedDBStorage(options.dbName ?? 'ripple', options.storeName ?? 'state', options.indexedDB);
  if (idb) return idb;
  if (globalThis.localStorage) return localStorageStorage(options.namespace);
  return memoryStorage();
}

/** 节流保存：手机端频繁写入会耗电，这里合并成一次。 */
export function createSaver(storage, { delayMs = 400, onError = null, timer = globalThis.setTimeout } = {}) {
  let timerId = null;
  let pending = null;
  let inflight = Promise.resolve();
  async function flush() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (!pending) return;
    const payload = pending;
    pending = null;
    inflight = inflight.then(() => storage.save(payload)).catch((error) => {
      if (onError) onError(error);
    });
    await inflight;
  }
  return {
    schedule(payload) {
      pending = payload;
      if (timerId !== null) clearTimeout(timerId);
      timerId = timer(() => {
        timerId = null;
        void flush();
      }, delayMs);
    },
    flush,
    get hasPending() {
      return pending !== null;
    },
  };
}
