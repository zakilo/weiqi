/** 已保存棋谱记录 */
export interface SavedGame {
  /** 自增主键 */
  id: number;
  /** 棋谱名称 */
  name: string;
  /** SGF 文本 */
  sgfText: string;
  /** 主线手数 */
  moveCount: number;
  /** 保存时间戳 */
  createdAt: number;
}

const DB_NAME = 'weiqi';
const DB_VERSION = 1;
const STORE_NAME = 'games';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 列出全部棋谱,按保存时间倒序 */
export async function listGames(): Promise<SavedGame[]> {
  const db = await openDb();
  try {
    const rows = await new Promise<SavedGame[]>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result as SavedGame[]);
      req.onerror = () => reject(req.error);
    });
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

/** 保存棋谱,返回自增 id */
export async function saveGame(record: Omit<SavedGame, 'id'>): Promise<number> {
  const db = await openDb();
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).add(record);
      req.onsuccess = () => resolve(req.result as number);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** 按 id 读取棋谱;不存在时返回 undefined */
export async function getGame(id: number): Promise<SavedGame | undefined> {
  const db = await openDb();
  try {
    return await new Promise<SavedGame | undefined>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result as SavedGame | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** 删除棋谱 */
export async function deleteGame(id: number): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
