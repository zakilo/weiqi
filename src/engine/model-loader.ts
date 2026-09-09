import { MODEL_STORE, openDb } from '../store/db';

/** 加载阶段:下载 / 解压 */
export type LoadPhase = 'download' | 'decompress';

/** 进度回调:阶段、已处理字节、总字节(未知时 null) */
export type LoadProgress = (phase: LoadPhase, loadedBytes: number, totalBytes: number | null) => void;

/** 模型规格 */
export interface ModelSpec {
  /** 唯一 id(缓存键) */
  id: string;
  /** 显示名称 */
  name: string;
  /** 候选下载地址,依次尝试(第一个成功即止) */
  urls: string[];
  /** 近似大小(字节),响应无 content-length 时用于进度估算 */
  approxBytes: number;
}

/** 默认模型:KataGo b18c384nbt(浏览器友好的小网络) */
export const MODEL_B18: ModelSpec = {
  id: 'b18c384nbt',
  name: 'KataGo b18c384nbt',
  urls: [
    'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz',
    'https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-uec.bin.gz',
  ],
  approxBytes: 93_000_000,
};

interface ModelBlobRecord {
  id: string;
  bytes: ArrayBuffer;
  size: number;
  fetchedAt: number;
}

/** 读取缓存的模型字节;未缓存返回 null */
export async function getCachedModelBytes(id: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  try {
    return await new Promise<ArrayBuffer | null>((resolve, reject) => {
      const req = db.transaction(MODEL_STORE, 'readonly').objectStore(MODEL_STORE).get(id);
      req.onsuccess = () => resolve(req.result ? (req.result as ModelBlobRecord).bytes : null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** 缓存模型字节(覆盖同 id 旧记录) */
export async function cacheModelBytes(id: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const record: ModelBlobRecord = {
        id,
        bytes,
        size: bytes.byteLength,
        fetchedAt: Date.now(),
      };
      const req = db.transaction(MODEL_STORE, 'readwrite').objectStore(MODEL_STORE).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * 加载模型字节:缓存命中直接返回;否则依次尝试下载地址,
 * gzip 内容自动解压,成功后写入缓存
 */
export async function loadModelBytes(
  spec: ModelSpec,
  onProgress?: LoadProgress,
): Promise<ArrayBuffer> {
  const cached = await getCachedModelBytes(spec.id);
  if (cached) return cached;

  let lastError: unknown = null;
  for (const url of spec.urls) {
    try {
      const compressed = await downloadBytes(url, spec.approxBytes, (l, t) =>
        onProgress?.('download', l, t),
      );
      const bytes = await maybeGunzip(compressed, (l) => onProgress?.('decompress', l, null));
      await cacheModelBytes(spec.id, bytes);
      return bytes;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`模型下载失败(已尝试 ${spec.urls.length} 个地址):${String(lastError)}`);
}

/** 从本地文件导入模型(自动识别 gzip)并写入缓存 */
export async function importModelFromFile(
  spec: ModelSpec,
  file: Blob,
  onProgress?: LoadProgress,
): Promise<ArrayBuffer> {
  const raw = await file.arrayBuffer();
  const bytes = await maybeGunzip(raw, (l) => onProgress?.('decompress', l, null));
  await cacheModelBytes(spec.id, bytes);
  return bytes;
}

/** 流式下载并聚合字节;进度按 content-length(缺省用 approxBytes) */
async function downloadBytes(
  url: string,
  approxBytes: number,
  onChunk: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} (${url})`);
  const total = Number(resp.headers.get('content-length')) || approxBytes;
  if (!resp.body) {
    const buf = await resp.arrayBuffer();
    onChunk(buf.byteLength, total);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onChunk(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

/** gzip 魔数(1f 8b)检测,命中则流式解压 */
async function maybeGunzip(
  bytes: ArrayBuffer,
  onChunk: (loaded: number) => void,
): Promise<ArrayBuffer> {
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (head[0] !== 0x1f || head[1] !== 0x8b) return bytes;

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onChunk(loaded);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
