/**
 * HTTP API 层:响应助手 + /api/* 路由分发。
 *  - GET  /api/health | /api/models | /api/status
 *  - POST /api/models/:id/load | /unload | /activate
 *  - POST /api/ai/think   → 单次 JSON
 *  - POST /api/ai/analyze → NDJSON 流(客户端断开即取消)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AnalyzeRequest,
  ModelActionResponse,
  ModelsResponse,
  ServiceStatus,
  ThinkRequest,
} from '../src/engine/remote/protocol.ts';
import type { EngineManager, EngineLike } from './engine/manager.ts';
import type { GameStore } from './games.ts';
import { GameInputError } from './games.ts';
import type { NewGame } from './games.ts';
import { isLoopback, isSameOrigin } from './security.ts';

export interface ApiDeps {
  manager: EngineManager;
  katagoVersion: string | null;
  /** 棋谱库(服务端落盘,替代按来源隔离的 IndexedDB) */
  games: GameStore;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

/** 抹掉状态里的本机绝对路径(外部请求只看运行状况) */
function redactPaths(status: ServiceStatus): ServiceStatus {
  return {
    ...status,
    config: {
      ...status.config,
      katagoPath: undefined,
      modelDir: undefined,
      humanModelPath: undefined,
    },
  };
}

/** 客户端请求本身有问题(体积超限、JSON 非法等),统一映射为 400 */
export class BadRequestError extends Error {}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** 读取 JSON 请求体(带大小上限) */
export function readJsonBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BadRequestError('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BadRequestError('请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

/**
 * 处理 /api/* 请求;命中返回 true,否则返回 false(交给静态托管)。
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApiDeps,
): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith('/api/')) return false;
  const method = req.method ?? 'GET';
  const local = isLoopback(req);

  // 浏览器带 Origin/Referer 的写请求必须同源,拦截第三方网站伪造请求
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !isSameOrigin(req)) {
    sendError(res, 403, '拒绝跨站请求');
    return true;
  }

  try {
    if (method === 'GET' && pathname === '/api/health') {
      const health = deps.manager.health(deps.katagoVersion);
      // 可执行文件绝对路径仅本机可见
      sendJson(res, 200, local ? health : { ...health, katagoPath: undefined });
      return true;
    }
    if (method === 'GET' && pathname === '/api/models') {
      const body: ModelsResponse = {
        models: deps.manager.listModels(),
        active: deps.manager.activeModel,
      };
      sendJson(res, 200, body);
      return true;
    }
    if (method === 'GET' && pathname === '/api/games') {
      sendJson(res, 200, { games: deps.games.list() });
      return true;
    }
    if (method === 'GET') {
      const gameMatch = /^\/api\/games\/(\d+)$/.exec(pathname);
      if (gameMatch) {
        const game = deps.games.get(Number(gameMatch[1]));
        if (!game) {
          sendError(res, 404, '棋谱不存在');
          return true;
        }
        sendJson(res, 200, { game });
        return true;
      }
    }
    if (method === 'DELETE') {
      const gameMatch = /^\/api\/games\/(\d+)$/.exec(pathname);
      if (gameMatch) {
        const removed = deps.games.remove(Number(gameMatch[1]));
        if (!removed) {
          sendError(res, 404, '棋谱不存在');
          return true;
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
    }
    if (method === 'GET' && pathname === '/api/status') {
      const status = deps.manager.status();
      sendJson(res, 200, local ? status : redactPaths(status));
      return true;
    }
    if (method === 'POST') {
      const modelMatch = /^\/api\/models\/([^/]+)\/(load|unload|activate)$/.exec(pathname);
      if (modelMatch) {
        const id = decodeURIComponent(modelMatch[1]!);
        const action = modelMatch[2] as 'load' | 'unload' | 'activate';
        await handleModelAction(res, deps.manager, id, action);
        return true;
      }
      if (pathname === '/api/ai/think') {
        await handleThink(req, res, deps.manager);
        return true;
      }
      if (pathname === '/api/ai/analyze') {
        await handleAnalyze(req, res, deps.manager);
        return true;
      }
      if (pathname === '/api/games') {
        await handleGameCreate(req, res, deps.games);
        return true;
      }
    }
    sendError(res, 404, `未找到接口 ${method} ${pathname}`);
    return true;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (error instanceof BadRequestError) {
      sendError(res, 400, error.message);
      return true;
    }
    if (error instanceof GameInputError) {
      sendError(res, 400, error.message);
      return true;
    }
    if (error.name === 'QueueFullError') {
      sendError(res, 429, error.message);
      return true;
    }
    if (error.message.startsWith('未知模型')) {
      sendError(res, 404, error.message);
      return true;
    }
    sendError(res, 500, error.message);
    return true;
  }
}

/**
 * 写入棋谱。body.dedupe=true(旧 IndexedDB 迁移)时同谱已存在则跳过,
 * 保证迁移可反复执行而不产生副本。
 */
async function handleGameCreate(req: IncomingMessage, res: ServerResponse, store: GameStore): Promise<void> {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    sendError(res, 400, '请求体缺失或非法');
    return;
  }
  const input = body as Record<string, unknown>;
  const game: NewGame = {
    name: typeof input.name === 'string' ? input.name : '',
    sgfText: typeof input.sgfText === 'string' ? input.sgfText : '',
    moveCount: typeof input.moveCount === 'number' ? input.moveCount : undefined,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : undefined,
  };
  const result = input.dedupe === true ? store.addUnique(game) : store.add(game);
  sendJson(res, 200, { game: result.game, duplicated: result.duplicated });
}

async function handleModelAction(
  res: ServerResponse,
  manager: EngineManager,
  id: string,
  action: 'load' | 'unload' | 'activate',
): Promise<void> {
  let engine: EngineLike | null = null;
  if (action === 'unload') {
    await manager.unload(id);
  } else if (action === 'load') {
    engine = await manager.load(id);
  } else {
    engine = await manager.activate(id);
  }
  const body: ModelActionResponse = {
    ok: engine ? engine.isRunning : true,
    active: manager.activeModel,
  };
  if (engine) body.engine = engine.status();
  sendJson(res, 200, body);
}

async function handleThink(
  req: IncomingMessage,
  res: ServerResponse,
  manager: EngineManager,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    sendError(res, 400, '请求体缺失或非法');
    return;
  }
  const result = await manager.think(body as ThinkRequest);
  sendJson(res, 200, result);
}

async function handleAnalyze(
  req: IncomingMessage,
  res: ServerResponse,
  manager: EngineManager,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    sendError(res, 400, '请求体缺失或非法');
    return;
  }
  const request = body as AnalyzeRequest;

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
  });

  const controller = new AbortController();
  let closed = false;
  res.on('close', () => {
    closed = true;
    controller.abort();
  });

  try {
    await manager.analyze(request, {
      signal: controller.signal,
      onSnapshot: (snapshot) => {
        if (!closed) res.write(`${JSON.stringify(snapshot)}\n`);
      },
    });
  } catch (e) {
    if (!closed) {
      const message = e instanceof Error ? e.message : String(e);
      res.write(`${JSON.stringify({ error: message })}\n`);
    }
  } finally {
    if (!closed) res.end();
  }
}
