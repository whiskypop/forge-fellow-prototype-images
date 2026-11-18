const TASK_KEY = 'prd-mandatory-prototype:tasks:v1';
const DB_NAME = 'forge-delivery-frontend';
const STORE_NAME = 'attachments';

export function loadTasks() {
  try {
    const raw = localStorage.getItem(TASK_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveTasks(tasks) {
  localStorage.setItem(TASK_KEY, JSON.stringify(tasks));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('当前浏览器不支持本地素材存储'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开素材存储'));
  });
}

function withStore(mode, operation) {
  return openDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let request;
    try { request = operation(store); }
    catch (error) { database.close(); reject(error); return; }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('素材存储失败'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error('素材存储失败')); };
  }));
}

export async function putAttachment(file) {
  const id = globalThis.crypto?.randomUUID?.() || `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await withStore('readwrite', store => store.put(file, id));
  return { id, name: file.name, type: file.type || 'application/octet-stream', size: file.size };
}

export async function getAttachment(id) {
  return withStore('readonly', store => store.get(id));
}

export async function deleteAttachment(id) {
  return withStore('readwrite', store => store.delete(id));
}
