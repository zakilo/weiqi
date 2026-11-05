/**
 * /api/games 路由单测:列表 / 写入 / 读取 / 删除 + 同源校验。
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleApi } from '../server/api.ts';
import { GameStore } from '../server/games.ts';
import type { EngineManager } from '../server/engine/manager.ts';

const SGF = '(;GM[1]SZ[19]AP[weiqi];B[pd];W[dp];B[fq])';

const manager = {
  health: () => ({ ok: true, katagoPath: 'katago', katagoVersion: null, activeModel: null }),
  status: () => ({ engines: [], active: null, queue: { active: 0, queued: 0, rejected: 0 }, config: {} }),
  listModels: () => [],
  activeModel: null,
} as unknown as EngineManager;

function makeReq(opts: {
  method: string;
  pathname: string;
  host?: string;
  origin?: string;
  body?: unknown;
}): IncomingMessage {
  const headers: Record<string, string> = { host: opts.host ?? 'localhost:8080' };
  if (opts.origin) headers.origin = opts.origin;
  // data 事件按真实 IncomingMessage 的约定给 Buffer
  const stream = Readable.from(
    opts.body === undefined
      ? []
      : [Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body), 'utf8')],
  );
  const req = Object.assign(stream, {
    method: opts.method,
    headers,
    url: opts.pathname,
    socket: { remoteAddress: '127.0.0.1' },
  });
  return req as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; sent(): { status: number; body: Record<string, unknown> } } {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(body?: string) {
      text = body ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  return { res, sent: () => ({ status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }) };
}

let dir = '';
let store: GameStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weiqi-api-games-'));
  store = new GameStore(join(dir, 'games.json'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function call(req: IncomingMessage, pathname: string) {
  const { res, sent } = fakeRes();
  const url = new URL(pathname, `http://${req.headers.host}`);
  const handled = await handleApi(req, res, url, { manager, katagoVersion: null, games: store });
  return { handled, ...sent() };
}

describe('GET /api/games', () => {
  it('空库返回空列表', async () => {
    const r = await call(makeReq({ method: 'GET', pathname: '/api/games' }), '/api/games');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ games: [] });
  });

  it('列出摘要,不含棋谱正文', async () => {
    store.add({ name: 'A', sgfText: SGF, createdAt: 123 });
    const r = await call(makeReq({ method: 'GET', pathname: '/api/games' }), '/api/games');
    const games = r.body.games as Record<string, unknown>[];
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ name: 'A', moveCount: 3, createdAt: 123 });
    expect(games[0]).not.toHaveProperty('sgfText');
  });
});

describe('POST /api/games', () => {
  it('写入成功并返回记录', async () => {
    const r = await call(
      makeReq({ method: 'POST', pathname: '/api/games', body: { name: '对局', sgfText: SGF, moveCount: 3 } }),
      '/api/games',
    );
    expect(r.status).toBe(200);
    const game = r.body.game as Record<string, unknown>;
    expect(game).toMatchObject({ name: '对局', moveCount: 3, sgfText: SGF });
    expect(typeof game.id).toBe('number');
    expect(r.body.duplicated).toBe(false);
    expect(store.size).toBe(1);
  });

  it('dedupe=true 时同谱跳过(迁移幂等)', async () => {
    await call(makeReq({ method: 'POST', pathname: '/api/games', body: { name: '原', sgfText: SGF, dedupe: true } }), '/api/games');
    const r = await call(
      makeReq({ method: 'POST', pathname: '/api/games', body: { name: '副本', sgfText: SGF, dedupe: true } }),
      '/api/games',
    );
    expect(r.body.duplicated).toBe(true);
    expect((r.body.game as Record<string, unknown>).name).toBe('原');
    expect(store.size).toBe(1);
  });

  it('缺名称或缺正文返回 400', async () => {
    const missingName = await call(makeReq({ method: 'POST', pathname: '/api/games', body: { sgfText: SGF } }), '/api/games');
    expect(missingName.status).toBe(400);
    const missingSgf = await call(makeReq({ method: 'POST', pathname: '/api/games', body: { name: 'A' } }), '/api/games');
    expect(missingSgf.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it('请求体不是 JSON 返回 400', async () => {
    const r = await call(makeReq({ method: 'POST', pathname: '/api/games', body: 'not json' }), '/api/games');
    expect(r.status).toBe(400);
  });

  it('跨站写请求被拒(403)', async () => {
    const r = await call(
      makeReq({ method: 'POST', pathname: '/api/games', origin: 'http://evil.example', body: { name: 'A', sgfText: SGF } }),
      '/api/games',
    );
    expect(r.status).toBe(403);
    expect(store.size).toBe(0);
  });

  it('局域网来源(经 Vite 代理保留原始 Host)同源通过', async () => {
    // changeOrigin:false 时后端看到的 Host 与浏览器 Origin 一致,手机写请求不再 403
    const r = await call(
      makeReq({
        method: 'POST',
        pathname: '/api/games',
        host: '192.0.2.60:5173',
        origin: 'http://192.0.2.60:5173',
        body: { name: '手机对局', sgfText: SGF },
      }),
      '/api/games',
    );
    expect(r.status).toBe(200);
    expect(store.size).toBe(1);
  });
});

describe('GET / DELETE /api/games/:id', () => {
  it('按 id 取回全文,不存在时 404', async () => {
    const { game } = store.add({ name: 'A', sgfText: SGF });
    const found = await call(makeReq({ method: 'GET', pathname: `/api/games/${game.id}` }), `/api/games/${game.id}`);
    expect(found.status).toBe(200);
    expect((found.body.game as Record<string, unknown>).sgfText).toBe(SGF);
    const gone = await call(makeReq({ method: 'GET', pathname: '/api/games/4242' }), '/api/games/4242');
    expect(gone.status).toBe(404);
  });

  it('删除成功,重复删除 404', async () => {
    const { game } = store.add({ name: 'A', sgfText: SGF });
    const del = await call(
      makeReq({ method: 'DELETE', pathname: `/api/games/${game.id}`, origin: 'http://localhost:8080' }),
      `/api/games/${game.id}`,
    );
    expect(del.status).toBe(200);
    expect(store.size).toBe(0);
    const again = await call(
      makeReq({ method: 'DELETE', pathname: `/api/games/${game.id}`, origin: 'http://localhost:8080' }),
      `/api/games/${game.id}`,
    );
    expect(again.status).toBe(404);
  });

  it('非数字 id 不匹配棋谱路由,落到 404 接口未找到', async () => {
    const r = await call(makeReq({ method: 'GET', pathname: '/api/games/abc' }), '/api/games/abc');
    expect(r.status).toBe(404);
  });
});
