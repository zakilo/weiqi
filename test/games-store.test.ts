/**
 * GameStore 单测:落盘往返、同谱去重、坏数据容错。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameInputError, GameStore } from '../server/games.ts';

const SGF_1 = '(;GM[1]SZ[19]AP[weiqi];B[pd];W[dp];B[fq])';
const SGF_2 = '(;GM[1]SZ[19]AP[weiqi];B[pd];W[dp];B[cc];W[ck])';

let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weiqi-games-'));
  file = join(dir, 'games.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GameStore 读写', () => {
  it('文件不存在时为空库,新增后落盘并可被新实例读回', () => {
    const store = new GameStore(file);
    expect(store.size).toBe(0);
    store.add({ name: '对局 1', sgfText: SGF_1, createdAt: 1000 });
    store.add({ name: '对局 2', sgfText: SGF_2, createdAt: 2000 });

    const reopened = new GameStore(file);
    expect(reopened.size).toBe(2);
    const rows = reopened.list();
    // 列表按时间倒序,且不含 sgfText
    expect(rows.map((r) => r.name)).toEqual(['对局 2', '对局 1']);
    expect(rows[0]).not.toHaveProperty('sgfText');
    expect(reopened.get(rows[1]!.id)?.sgfText).toBe(SGF_1);
  });

  it('moveCount 缺省时按 SGF 手顺推算', () => {
    const store = new GameStore(file);
    const { game } = store.add({ name: '自动手数', sgfText: SGF_2 });
    expect(game.moveCount).toBe(4);
    expect(store.add({ name: '指定手数', sgfText: SGF_2, moveCount: 99 }).game.moveCount).toBe(99);
  });

  it('id 自增且重启后继续递增,不与旧记录冲突', () => {
    const first = new GameStore(file);
    const a = first.add({ name: 'A', sgfText: SGF_1 }).game;
    first.remove(a.id);
    const second = new GameStore(file);
    const b = second.add({ name: 'B', sgfText: SGF_2 }).game;
    expect(b.id).toBeGreaterThan(a.id);
  });

  it('删除后列表与取回同步消失,重复删除返回 false', () => {
    const store = new GameStore(file);
    const { game } = store.add({ name: 'A', sgfText: SGF_1 });
    expect(store.remove(game.id)).toBe(true);
    expect(store.get(game.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(store.remove(game.id)).toBe(false);
    expect(new GameStore(file).size).toBe(0);
  });

  it('非法输入抛 GameInputError,不落盘', () => {
    const store = new GameStore(file);
    expect(() => store.add({ name: '  ', sgfText: SGF_1 })).toThrow(GameInputError);
    expect(() => store.add({ name: 'A', sgfText: '   ' })).toThrow(GameInputError);
    expect(() => store.add({ name: 'A', sgfText: 42 as unknown as string })).toThrow(GameInputError);
    expect(store.size).toBe(0);
  });

  it('名称超长被截断', () => {
    const store = new GameStore(file);
    const { game } = store.add({ name: 'x'.repeat(200), sgfText: SGF_1 });
    expect(game.name).toHaveLength(120);
  });
});

describe('GameStore 去重(迁移幂等)', () => {
  it('addUnique 对同谱不重复入库,并返回既有记录', () => {
    const store = new GameStore(file);
    const first = store.addUnique({ name: '原', sgfText: SGF_1, createdAt: 500 });
    const again = store.addUnique({ name: '副本', sgfText: SGF_1, createdAt: 900 });
    expect(again.duplicated).toBe(true);
    expect(again.game.id).toBe(first.game.id);
    expect(again.game.name).toBe('原');
    expect(again.game.createdAt).toBe(500);
    expect(store.size).toBe(1);
  });

  it('首尾空白视为同一份棋谱', () => {
    const store = new GameStore(file);
    store.addUnique({ name: 'A', sgfText: SGF_1 });
    expect(store.addUnique({ name: 'A2', sgfText: `  ${SGF_1}\n` }).duplicated).toBe(true);
  });

  it('普通 add 允许同谱重复保存(保持旧 IndexedDB 行为)', () => {
    const store = new GameStore(file);
    store.add({ name: '存两次', sgfText: SGF_1 });
    const second = store.add({ name: '存两次', sgfText: SGF_1 });
    expect(second.duplicated).toBe(false);
    expect(store.size).toBe(2);
  });

  it('迁移后可反复执行,重启仍幂等', () => {
    const store = new GameStore(file);
    store.addUnique({ name: 'A', sgfText: SGF_1 });
    store.addUnique({ name: 'B', sgfText: SGF_2 });
    const reopened = new GameStore(file);
    expect(reopened.addUnique({ name: 'A 重复', sgfText: SGF_1 }).duplicated).toBe(true);
    expect(reopened.addUnique({ name: 'B 重复', sgfText: SGF_2 }).duplicated).toBe(true);
    expect(reopened.size).toBe(2);
  });
});

describe('GameStore 容错', () => {
  it('损坏文件改名备份并以空库启动', () => {
    writeFileSync(file, '{ this is not json', 'utf8');
    const store = new GameStore(file);
    expect(store.size).toBe(0);
    const backups = entries(dir);
    expect(backups.some((n) => n.startsWith('games.json.corrupt-'))).toBe(true);
  });

  it('单条坏记录跳过,其余照常载入', () => {
    writeFileSync(
      file,
      JSON.stringify([
        { id: 1, name: '好', sgfText: SGF_1, moveCount: 3, createdAt: 10 },
        { id: 2, name: '', sgfText: SGF_2 },
        null,
        { id: 'x', name: '坏', sgfText: SGF_2 },
      ]),
      'utf8',
    );
    const store = new GameStore(file);
    expect(store.size).toBe(1);
    expect(store.list()[0]?.name).toBe('好');
    expect(store.add({ name: '新', sgfText: SGF_2 }).game.id).toBeGreaterThan(1);
  });

  it('写入是整文件原子替换,不留临时文件', () => {
    const store = new GameStore(file);
    store.add({ name: 'A', sgfText: SGF_1 });
    expect(readFileSync(file, 'utf8')).toContain('A');
    expect(entries(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

const entries = (d: string): string[] => readdirSync(d);
