/**
 * 棋谱库客户端:读写走服务端 /api/games(落盘 data/games.json)。
 *
 * 之所以不再用浏览器存储:IndexedDB 按来源隔离,localhost / 局域网 IP / .local /
 * 公网域名各存一份,手机和电脑看到的列表不一样,像棋谱丢了。
 * 服务端一份数据对所有设备可见。
 *
 * 旧数据由 migrateLocalGames() 一次性上传(带 dedupe,可重复执行)。
 */
import { listGames as listLocalGames } from './local-db';

/** 与服务端 StoredGame 对齐的棋谱记录 */
export interface SavedGame {
  id: number;
  name: string;
  sgfText: string;
  moveCount: number;
  /** 保存时间戳(ms) */
  createdAt: number;
}

/** 列表项不含 sgfText(打开时再单独取全文) */
export type GameSummary = Omit<SavedGame, 'sgfText'>;

/** 服务端错误文本直接展示给用户,故 Error.message 保持可读 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await resp.text();
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // 非 JSON 响应沿用状态码
    }
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function listGames(): Promise<GameSummary[]> {
  const body = await request<{ games: GameSummary[] }>('/api/games');
  return body.games;
}

/** 保存棋谱,返回服务端 id */
export async function saveGame(record: Omit<SavedGame, 'id'>): Promise<number> {
  const body = await request<{ game: SavedGame }>('/api/games', {
    method: 'POST',
    body: JSON.stringify(record),
  });
  return body.game.id;
}

/** 读取单份棋谱;服务端返回 404 时给出 undefined */
export async function getGame(id: number): Promise<SavedGame | undefined> {
  try {
    const body = await request<{ game: SavedGame }>(`/api/games/${id}`);
    return body.game;
  } catch (e) {
    if (e instanceof Error && e.message === '棋谱不存在') return undefined;
    throw e;
  }
}

export async function deleteGame(id: number): Promise<void> {
  await request('/api/games/' + id, { method: 'DELETE' });
}

export interface MigrateResult {
  /** 本次上传的旧记录条数(不含服务端已有的重复) */
  migrated: number;
  /** 服务端判定为重复而跳过的条数 */
  skipped: number;
  /** 迁移失败原因;成功为 null */
  error: string | null;
}

/**
 * 把本浏览器 IndexedDB 里的旧棋谱搬到服务端。
 * dedupe 让同一批数据可反复上传而不会重复入库,因此无需记录"是否迁移过"的标记。
 * 本地数据保留不动,失败只回报不抛异常(不阻塞对局)。
 */
export async function migrateLocalGames(): Promise<MigrateResult> {
  let local: SavedGame[] = [];
  try {
    local = await listLocalGames();
  } catch (e) {
    return { migrated: 0, skipped: 0, error: `读取本地棋谱失败:${e instanceof Error ? e.message : String(e)}` };
  }
  if (local.length === 0) return { migrated: 0, skipped: 0, error: null };

  let migrated = 0;
  let skipped = 0;
  for (const g of local) {
    try {
      const body = await request<{ game: SavedGame; duplicated: boolean }>('/api/games', {
        method: 'POST',
        body: JSON.stringify({
          name: g.name,
          sgfText: g.sgfText,
          moveCount: g.moveCount,
          createdAt: g.createdAt,
          dedupe: true,
        }),
      });
      if (body.duplicated) skipped++;
      else migrated++;
    } catch (e) {
      return {
        migrated,
        skipped,
        error: `上传旧棋谱失败(${migrated + skipped}/${local.length}):${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return { migrated, skipped, error: null };
}
