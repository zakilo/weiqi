/**
 * GameStore:棋谱库的服务端落盘存储(单个 JSON 文件)。
 *
 * 为什么放在服务端:浏览器 IndexedDB 按「协议+主机+端口」隔离,
 * localhost / 局域网 IP / .local / 域名各存一份,换地址就像棋谱丢了。
 * 服务端一份数据对所有人可见,手机与电脑共用同一列表。
 *
 * 写入策略:整文件原子替换(临时文件 + rename),棋谱量级小(百级),
 * 不做增量写;读在构造时一次性完成。文件损坏时改名备份后重建,不静默丢弃。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface StoredGame {
  /** 自增 id(从 1 起) */
  id: number;
  name: string;
  /** 完整 SGF 文本 */
  sgfText: string;
  /** 主线手数 */
  moveCount: number;
  /** 保存时间戳(ms) */
  createdAt: number;
}

/** 列表项:不含 sgfText,避免整库拉取时把文本全带上 */
export type GameSummary = Omit<StoredGame, 'sgfText'>;

export interface NewGame {
  name: string;
  sgfText: string;
  /** 缺省时按 SGF 里的 B/W 手顺推算 */
  moveCount?: number;
  /** 迁移旧数据时保留原时间;缺省取当前 */
  createdAt?: number;
}

export interface AddResult {
  game: StoredGame;
  /** 已存在同谱(内容哈希相同)时为 true,未新增记录 */
  duplicated: boolean;
}

const MAX_NAME = 120;
const MAX_SGF_BYTES = 2 * 1024 * 1024;

/** 非法输入统一抛 Error,message 直接作为 400 响应文案 */
export class GameInputError extends Error {}

function hash(text: string): string {
  return createHash('sha1').update(text.trim()).digest('hex');
}

/** 从 SGF 文本粗估主线手数(顶层 B/W 落子或虚着手数) */
function countMoves(sgfText: string): number {
  let n = 0;
  let depth = 0;
  for (let i = 0; i < sgfText.length; i++) {
    const ch = sgfText[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 1 && ch === ';' && (sgfText[i + 1] === 'B' || sgfText[i + 1] === 'W')) n++;
  }
  return n;
}

function normalizeName(name: unknown): string {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text === '') throw new GameInputError('棋谱名称不能为空');
  return text.slice(0, MAX_NAME);
}

function normalizeSgf(sgfText: unknown): string {
  if (typeof sgfText !== 'string' || sgfText.trim() === '') throw new GameInputError('棋谱内容为空');
  if (Buffer.byteLength(sgfText, 'utf8') > MAX_SGF_BYTES) throw new GameInputError('棋谱内容过大');
  return sgfText;
}

export class GameStore {
  private readonly filePath: string;
  private games: StoredGame[] = [];
  /** 内容哈希 → id,用于「同一份棋谱不重复入库」(迁移幂等靠它) */
  private readonly hashes = new Map<string, number>();
  private nextId = 1;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    this.load();
  }

  /** 按保存时间倒序返回摘要 */
  list(): GameSummary[] {
    return [...this.games]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ sgfText: _sgfText, ...summary }) => summary);
  }

  get(id: number): StoredGame | undefined {
    return this.games.find((g) => g.id === id);
  }

  /** 新增棋谱(同名同谱允许重复保存,与旧 IndexedDB 行为一致) */
  add(input: NewGame): AddResult {
    const name = normalizeName(input.name);
    const sgfText = normalizeSgf(input.sgfText);
    const digest = hash(sgfText);
    const moveCount =
      typeof input.moveCount === 'number' && Number.isFinite(input.moveCount) && input.moveCount >= 0
        ? Math.floor(input.moveCount)
        : countMoves(sgfText);
    const createdAt =
      typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
    const game: StoredGame = { id: this.nextId++, name, sgfText, moveCount, createdAt };
    this.games.push(game);
    // 哈希指向最新一条同谱记录
    this.hashes.set(digest, game.id);
    this.persist();
    return { game, duplicated: false };
  }

  /**
   * 同谱去重写入(迁移用):内容已存在则原样返回既有记录,
   * 因此同一段旧数据可以反复上传而不产生副本。
   */
  addUnique(input: NewGame): AddResult {
    const sgfText = normalizeSgf(input.sgfText);
    const existingId = this.hashes.get(hash(sgfText));
    if (existingId !== undefined) {
      const existing = this.get(existingId);
      if (existing) return { game: existing, duplicated: true };
    }
    return this.add(input);
  }

  remove(id: number): boolean {
    const index = this.games.findIndex((g) => g.id === id);
    if (index < 0) return false;
    const [removed] = this.games.splice(index, 1);
    if (removed) {
      for (const [digest, mapped] of this.hashes) {
        if (mapped === removed.id) this.hashes.delete(digest);
      }
    }
    this.persist();
    return true;
  }

  /** 供测试与诊断:当前记录条数 */
  get size(): number {
    return this.games.length;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let raw = '';
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      // 顶层是对象:{ nextId, games };旧的裸数组格式仍可读
      if (Array.isArray(parsed)) {
        for (const item of parsed) this.accept(item);
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as { nextId?: unknown; games?: unknown };
        if (!Array.isArray(obj.games)) throw new Error('games 字段不是数组');
        for (const item of obj.games) this.accept(item);
        if (typeof obj.nextId === 'number' && Number.isFinite(obj.nextId)) {
          this.nextId = Math.max(this.nextId, Math.floor(obj.nextId));
        }
      } else {
        throw new Error('顶层结构无法识别');
      }
    } catch (e) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        renameSync(this.filePath, backup);
        console.warn(`[weiqi] 棋谱库文件损坏,已备份到 ${backup} 并重建:${e instanceof Error ? e.message : ''}`);
      } catch {
        console.warn('[weiqi] 棋谱库文件损坏且无法备份,本次以空库启动(磁盘内容保持不变)');
      }
      this.games = [];
      this.hashes.clear();
      this.nextId = 1;
    }
  }

  /** 逐条校验,坏记录跳过而不是整库作废 */
  private accept(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    const g = item as Record<string, unknown>;
    const id = typeof g.id === 'number' ? g.id : NaN;
    const name = typeof g.name === 'string' ? g.name : '';
    const sgfText = typeof g.sgfText === 'string' ? g.sgfText : '';
    if (!Number.isInteger(id) || id <= 0 || name === '' || sgfText === '') return;
    const moveCount = typeof g.moveCount === 'number' && Number.isFinite(g.moveCount) ? g.moveCount : 0;
    const createdAt = typeof g.createdAt === 'number' && Number.isFinite(g.createdAt) ? g.createdAt : 0;
    this.games.push({ id, name, sgfText, moveCount, createdAt });
    this.hashes.set(hash(sgfText), id);
    this.nextId = Math.max(this.nextId, id + 1);
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    // nextId 一并落盘:删除末尾记录后也不能复用旧 id(避免误开/误删他局)
    writeFileSync(tmp, JSON.stringify({ nextId: this.nextId, games: this.games }, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
