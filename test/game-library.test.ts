/**
 * 棋谱库客户端单测:请求形状、错误映射、旧数据迁移幂等。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteGame, getGame, listGames, migrateLocalGames, saveGame } from '../src/store/game-library';
import { saveGame as saveLocal } from '../src/store/local-db';

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

let calls: Call[] = [];
let respond: (call: Call) => { status: number; body: unknown };

function stubFetch(): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const r = respond(call);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as unknown as typeof fetch;
}

const ok = (body: unknown) => ({ status: 200, body });

beforeEach(async () => {
  indexedDB = new IDBFactory();
  respond = () => ok({});
  stubFetch();
});

describe('game-library 请求', () => {
  it('listGames 读取摘要列表', async () => {
    respond = () => ok({ games: [{ id: 2, name: 'B', moveCount: 4, createdAt: 20 }, { id: 1, name: 'A', moveCount: 3, createdAt: 10 }] });
    const rows = await listGames();
    expect(rows.map((r) => r.name)).toEqual(['B', 'A']);
    expect(calls[0]).toEqual({ url: '/api/games', method: 'GET', body: undefined });
  });

  it('saveGame 提交完整记录并返回 id', async () => {
    respond = () => ok({ game: { id: 7, name: '对局', sgfText: '(;B[pd])', moveCount: 1, createdAt: 5 }, duplicated: false });
    const id = await saveGame({ name: '对局', sgfText: '(;B[pd])', moveCount: 1, createdAt: 5 });
    expect(id).toBe(7);
    expect(calls[0]).toMatchObject({ url: '/api/games', method: 'POST' });
    expect(calls[0]!.body).toMatchObject({ name: '对局', sgfText: '(;B[pd])' });
  });

  it('getGame 按 id 取回全文,404 时返回 undefined', async () => {
    respond = (call) =>
      call.url === '/api/games/3' ? ok({ game: { id: 3, name: 'A', sgfText: '(;B[pd])', moveCount: 1, createdAt: 1 } }) : { status: 404, body: { error: '棋谱不存在' } };
    const found = await getGame(3);
    expect(found?.sgfText).toBe('(;B[pd])');
    const missing = await getGame(99);
    expect(missing).toBeUndefined();
  });

  it('deleteGame 使用 DELETE', async () => {
    respond = () => ok({ ok: true });
    await deleteGame(4);
    expect(calls[0]).toMatchObject({ url: '/api/games/4', method: 'DELETE' });
  });

  it('服务端错误文案原样抛出', async () => {
    respond = () => ({ status: 400, body: { error: '棋谱名称不能为空' } });
    await expect(saveGame({ name: '', sgfText: 'x', moveCount: 0, createdAt: 0 })).rejects.toThrow('棋谱名称不能为空');
  });

  it('非 JSON 响应退化为状态码错误', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    })) as unknown as typeof fetch;
    await expect(listGames()).rejects.toThrow('HTTP 502');
  });

  it('getGame 对非 404 错误继续抛出', async () => {
    respond = () => ({ status: 500, body: { error: '服务端异常' } });
    await expect(getGame(1)).rejects.toThrow('服务端异常');
  });
});

describe('migrateLocalGames 迁移旧 IndexedDB 棋谱', () => {
  it('本地为空时不发任何请求', async () => {
    const result = await migrateLocalGames();
    expect(result).toEqual({ migrated: 0, skipped: 0, error: null });
    expect(calls).toEqual([]);
  });

  it('逐条上传并带上 dedupe 与原始时间', async () => {
    await saveLocal({ name: '旧A', sgfText: '(;B[pd])', moveCount: 1, createdAt: 111 });
    await saveLocal({ name: '旧B', sgfText: '(;B[qe])', moveCount: 1, createdAt: 222 });
    respond = (call) => ok({ game: { id: 1, name: call.body?.name ?? '', duplicated: false }, duplicated: false });

    const result = await migrateLocalGames();
    expect(result.migrated).toBe(2);
    expect(result.error).toBeNull();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    // 本地列表按时间倒序返回,迁移沿用该顺序并保留原始 createdAt
    expect(posts.map((c) => c.body?.name)).toEqual(['旧B', '旧A']);
    expect(posts[0]!.body).toMatchObject({ name: '旧B', dedupe: true, createdAt: 222 });
    expect(posts[1]!.body).toMatchObject({ name: '旧A', dedupe: true, createdAt: 111 });
  });

  it('服务端判定重复时计入 skipped,不算迁移', async () => {
    await saveLocal({ name: '旧A', sgfText: '(;B[pd])', moveCount: 1, createdAt: 111 });
    respond = () => ok({ game: { id: 1, name: '旧A' }, duplicated: true });
    const result = await migrateLocalGames();
    expect(result).toEqual({ migrated: 0, skipped: 1, error: null });
  });

  it('上传失败时带上进度并返回错误,不抛异常', async () => {
    await saveLocal({ name: '旧A', sgfText: '(;B[pd])', moveCount: 1, createdAt: 111 });
    await saveLocal({ name: '旧B', sgfText: '(;B[qe])', moveCount: 1, createdAt: 222 });
    let n = 0;
    respond = () => {
      n++;
      return n === 1 ? ok({ game: { id: 1 }, duplicated: false }) : { status: 403, body: { error: '拒绝跨站请求' } };
    };
    const result = await migrateLocalGames();
    expect(result.migrated).toBe(1);
    expect(result.error).toContain('拒绝跨站请求');
    expect(result.error).toContain('1/2');
  });
});
