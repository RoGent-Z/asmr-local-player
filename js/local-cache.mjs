const DATABASE_NAME = 'asmr-player-local-library-v1';
let tokenSequence = 0;

function cancelled(reason = '缓存已取消，保留上次完整作品库') {
  return new DOMException(reason, 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw cancelled();
}

function relativePath(value) {
  const path = String(value ?? '').replaceAll('\\', '/');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new TypeError('缓存文件缺少有效相对路径');
  }
  return path;
}

function fileAtPath(blob, path, FileConstructor = globalThis.File, metadata = blob) {
  const file = new FileConstructor([blob], metadata.name || path.split('/').at(-1), {
    type: metadata.type || '', lastModified: metadata.lastModified ?? 0,
  });
  Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
  return file;
}

/** Read a user-selected directory. Files keep their root-relative paths for the scanner. */
export async function readDirectoryFiles(handle, { signal, onProgress = () => {} } = {}) {
  checkAbort(signal);
  if (!handle || handle.kind !== 'directory') throw new TypeError('请选择曲库文件夹');
  const files = [];
  async function visit(directory, prefix) {
    for await (const entry of directory.values()) {
      checkAbort(signal);
      const path = relativePath(`${prefix}/${entry.name}`);
      if (entry.kind === 'directory') await visit(entry, path);
      else if (entry.kind === 'file') {
        const file = await entry.getFile();
        checkAbort(signal);
        files.push(fileAtPath(file, path));
        onProgress({ phase: 'read', completed: files.length, path });
      }
    }
  }
  await visit(handle, relativePath(handle.name));
  checkAbort(signal);
  return files;
}

function failure(error, estimate = null) {
  const code = error?.name || 'Error';
  if (code === 'AbortError') return { status: 'cancelled', reason: error.message || '缓存已取消' };
  if (code === 'SecurityError' || code === 'NotSupportedError' || code === 'InvalidStateError') {
    return { status: 'unavailable', code, reason: '此浏览器当前无法使用设备内缓存，当前页面仍可播放' };
  }
  return {
    status: 'error', code, estimate,
    reason: code === 'QuotaExceededError'
      ? '浏览器设备内存储空间或配额不足；当前页面仍可播放，上次完整缓存已保留'
      : code === 'NotFoundError'
        ? '原曲库文件或文件夹已移动或删除，请重新选择曲库'
        : code === 'NotAllowedError'
          ? '浏览器未允许读取原曲库，请点击恢复作品库并重新授权'
          : '设备内缓存未完成；当前页面仍可播放，可重新选择曲库后重试',
  };
}

function transact(db, stores, mode, operation, signal) {
  return new Promise((resolve, reject) => {
    let transaction, result, cause;
    const abort = () => {
      cause = cancelled();
      try { transaction?.abort(); } catch { /* An already committed transaction cannot be aborted. */ }
    };
    try {
      checkAbort(signal);
      transaction = db.transaction(stores, mode);
      transaction.oncomplete = () => { signal?.removeEventListener('abort', abort); resolve(result); };
      transaction.onabort = () => {
        signal?.removeEventListener('abort', abort);
        reject(cause || transaction.error || cancelled());
      };
      transaction.onerror = event => { cause ||= event.target.error || transaction.error; };
      signal?.addEventListener('abort', abort, { once: true });
      const guard = callback => event => {
        try { callback(event); } catch (error) { cause = error; transaction.abort(); }
      };
      operation(transaction, value => { result = value; }, guard);
    } catch (error) {
      cause = error;
      if (transaction) {
        try { transaction.abort(); } catch { signal?.removeEventListener('abort', abort); reject(error); }
      } else reject(error);
    }
  });
}

/** Device-only cache. No fetch, upload, media decoding or whole-file buffering is used. */
export function createLocalCache({
  indexedDB = globalThis.indexedDB,
  storage = globalThis.navigator?.storage,
  databaseName = DATABASE_NAME,
  File: FileConstructor = globalThis.File,
} = {}) {
  let generation = 0;
  const unavailable = () => ({ status: 'unavailable', reason: '此浏览器不支持设备内缓存，当前页面仍可播放' });
  const open = () => new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(databaseName, 1); } catch (error) { reject(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('files')) {
        const files = db.createObjectStore('files', { keyPath: ['snapshot', 'path'] });
        files.createIndex('snapshot', 'snapshot');
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new DOMException('设备缓存被其他页面占用', 'InvalidStateError'));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
  async function removeSnapshot(db, snapshot) {
    if (!snapshot || !db) return;
    await transact(db, ['files'], 'readwrite', (tx, _, guard) => {
      const cursor = tx.objectStore('files').index('snapshot').openKeyCursor(snapshot);
      cursor.onsuccess = guard(() => {
        if (!cursor.result) return;
        tx.objectStore('files').delete(cursor.result.primaryKey);
        cursor.result.continue();
      });
    });
  }
  const readSnapshot = db => transact(db, ['meta', 'files'], 'readonly', (tx, done, guard) => {
    const request = tx.objectStore('meta').get('active');
    request.onsuccess = guard(() => {
      const active = request.result || null;
      const files = [];
      if (!active || active.mode === 'handle') { done({ active, files }); return; }
      let index = 0;
      const readNext = () => {
        if (index === active.paths.length) { done({ active, files }); return; }
        const path = active.paths[index++];
        const record = tx.objectStore('files').get([active.snapshot, path]);
        record.onsuccess = guard(() => {
          if (!record.result?.blob) throw new DOMException('作品库缓存不完整', 'NotReadableError');
          files.push(fileAtPath(record.result.blob, record.result.path, FileConstructor, record.result));
          // Queue the next request synchronously so one readonly transaction protects the
          // entire snapshot against concurrent replacement/cleanup in another tab.
          readNext();
        });
      };
      readNext();
    });
  });

  async function save({ files = [], directoryHandle = null, summary = null } = {}, { signal, onProgress = () => {} } = {}) {
    const ownGeneration = ++generation;
    if (!indexedDB?.open) return unavailable();
    const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${++tokenSequence}-${Math.random()}`;
    let db, estimate = null, committed = false;
    const current = () => {
      checkAbort(signal);
      if (generation !== ownGeneration) throw cancelled('已改用新作品库，旧缓存任务已取消');
    };
    const report = progress => { try { onProgress(progress); } catch { /* UI callbacks do not invalidate stored data. */ } };
    try {
      current();
      const entries = [...new Map(Array.from(files, entry => {
        const path = relativePath(entry.path);
        if (!entry.file || !Number.isFinite(entry.file.size)) throw new TypeError('缓存文件无效');
        return [path, { file: entry.file, path }];
      })).values()];
      const mode = directoryHandle?.kind === 'directory' ? 'handle' : 'files';
      const bytes = entries.reduce((sum, entry) => sum + entry.file.size, 0);
      // Estimates are advisory: only the browser's actual transaction determines quota failure.
      try { estimate = await storage?.estimate?.() || null; } catch { /* Storage estimates are optional. */ }
      current();
      db = await open();
      current();
      await transact(db, ['meta'], 'readwrite', tx => {
        tx.objectStore('meta').put({ key: 'pending', token });
      }, signal);
      report({ phase: 'save', mode, completed: 0, total: entries.length, bytes: 0, totalBytes: bytes, estimate });
      let completedBytes = 0;
      if (mode === 'files') {
        for (const [index, entry] of entries.entries()) {
          current();
          await transact(db, ['meta', 'files'], 'readwrite', (tx, _, guard) => {
            const pending = tx.objectStore('meta').get('pending');
            pending.onsuccess = guard(() => {
              current();
              if (pending.result?.token !== token) throw cancelled('已改用新作品库，旧缓存任务已取消');
              tx.objectStore('files').put({ snapshot: token, path: entry.path, blob: entry.file,
                name: entry.file.name, type: entry.file.type, lastModified: entry.file.lastModified });
            });
          }, signal);
          completedBytes += entry.file.size;
          report({ phase: 'save', mode, completed: index + 1, total: entries.length, bytes: completedBytes, totalBytes: bytes });
        }
      }
      current();
      const previous = await transact(db, ['meta'], 'readwrite', (tx, done, guard) => {
        const store = tx.objectStore('meta');
        const active = store.get('active');
        const pending = store.get('pending');
        pending.onsuccess = guard(() => {
          current();
          if (pending.result?.token !== token) throw cancelled('已改用新作品库，旧缓存任务已取消');
          store.put({ key: 'active', snapshot: token, mode, paths: mode === 'files' ? entries.map(entry => entry.path) : [],
            count: entries.length, bytes, summary, handle: mode === 'handle' ? directoryHandle : null });
          done(active.result?.snapshot);
        });
      }, signal);
      committed = true;
      // Cleanup is independent of the active pointer; a cleanup failure never changes a valid snapshot.
      await removeSnapshot(db, previous).catch(() => {});
      report({ phase: 'complete', mode, completed: entries.length, total: entries.length, bytes, totalBytes: bytes });
      return { status: 'saved', mode, count: entries.length, bytes, estimate };
    } catch (error) {
      if (!committed) await removeSnapshot(db, token).catch(() => {});
      return failure(error, estimate);
    } finally { db?.close(); }
  }

  async function restore({ requestPermission = false } = {}) {
    if (!indexedDB?.open) return unavailable();
    let db;
    try {
      db = await open();
      const { active, files } = await readSnapshot(db);
      if (!active) return { status: 'empty', reason: '尚未保存本机作品库' };
      if (active.mode === 'handle') {
        const handle = active.handle;
        const permissionRequired = () => ({
          status: 'permission-required', summary: active.summary, handle,
          reason: '作品库已记住；点击恢复作品库以允许浏览器读取原文件夹',
        });
        try {
          let permission = typeof handle?.queryPermission === 'function'
            ? await handle.queryPermission({ mode: 'read' }) : 'prompt';
          if (permission !== 'granted' && requestPermission && typeof handle?.requestPermission === 'function') {
            permission = await handle.requestPermission({ mode: 'read' });
          }
          if (permission !== 'granted') return permissionRequired();
          const files = await readDirectoryFiles(handle);
          return { status: 'ready', files, mode: 'handle', summary: active.summary };
        } catch (error) {
          if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return permissionRequired();
          throw error;
        }
      }
      return { status: 'ready', files, mode: 'files', summary: active.summary };
    } catch (error) { return failure(error); }
    finally { db?.close(); }
  }

  async function clear() {
    generation += 1;
    if (!indexedDB?.open) return unavailable();
    let db;
    try {
      db = await open();
      await transact(db, ['meta', 'files'], 'readwrite', tx => {
        tx.objectStore('meta').clear();
        tx.objectStore('files').clear();
      });
      return { status: 'cleared' };
    } catch (error) { return failure(error); }
    finally { db?.close(); }
  }
  return { save, restore, clear };
}
