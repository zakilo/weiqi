/**
 * 服务入口:载入配置 → 启动 EngineManager → 托管 /api 与 dist/。
 * 直接用 Node 运行:`node server/index.ts`(Node 原生 TS 类型剥离)。
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ROOT_DIR, loadConfig } from './config.ts';
import { EngineManager } from './engine/manager.ts';
import { GameStore } from './games.ts';
import { createRequestHandler } from './http.ts';

const execFileAsync = promisify(execFile);

/** best-effort 探测 KataGo 版本;失败返回 null */
async function probeKatagoVersion(katagoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(katagoPath, ['version'], { timeout: 10_000 });
    const first = stdout.split('\n')[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const manager = new EngineManager(config);
  const katagoVersion = await probeKatagoVersion(config.katagoPath);
  const distDir = resolve(ROOT_DIR, 'dist');

  const games = new GameStore(config.gamesFile);
  const handler = createRequestHandler({ manager, config, katagoVersion, distDir, games });
  const server = createServer(handler);

  await new Promise<void>((resolveListen) => {
    server.listen(config.port, config.host, () => {
      console.log(`[weiqi] AI 服务已启动: http://${config.host}:${config.port}`);
      console.log(`[weiqi] KataGo: ${config.katagoPath}${katagoVersion ? ` (${katagoVersion})` : ' [未检测到]'}`);
      console.log(`[weiqi] 模型目录: ${config.modelDir}`);
      console.log(`[weiqi] 棋谱库: ${config.gamesFile}(${games.size} 局)`);
      if (config.models.length === 0) {
        console.warn('[weiqi] 未配置任何模型,请在 ai.config.json 中填写 models');
      }
      resolveListen();
    });
  });

  // best-effort 预加载激活模型;失败仅告警,不阻塞服务
  manager.ensureActive().catch((e: unknown) => {
    console.warn(`[weiqi] 预加载激活模型失败: ${e instanceof Error ? e.message : String(e)}`);
  });

  const shutdown = (): void => {
    console.log('\n[weiqi] 正在关闭…');
    manager.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  console.error('[weiqi] 启动失败:', e);
  process.exit(1);
});
