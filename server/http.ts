/**
 * 请求处理器:先分发 /api/*,未命中则回退到 dist/ 静态托管。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from './api.ts';
import type { GameStore } from './games.ts';
import type { ServerConfig } from './config.ts';
import type { EngineManager } from './engine/manager.ts';
import { serveStatic } from './static.ts';

export interface HandlerDeps {
  manager: EngineManager;
  config: ServerConfig;
  katagoVersion: string | null;
  /** dist/ 目录绝对路径 */
  distDir: string;
  /** 棋谱库存储 */
  games: GameStore;
}

export function createRequestHandler(deps: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    handleApi(req, res, url, {
      manager: deps.manager,
      katagoVersion: deps.katagoVersion,
      games: deps.games,
    })
      .then((handled) => {
        if (handled) return;
        serveStatic(deps.distDir, url.pathname, res);
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: message }));
        } else {
          res.end();
        }
      });
  };
}
