import { describe, expect, it } from 'vitest';
import * as tf from '@tensorflow/tfjs';
import { AiPlayer } from '../src/engine/ai-player';
import { Game } from '../src/store/game';
import { buildV8 } from './helpers/model-builder';

describe('AiPlayer', () => {
  it('加载假模型后可思考出可执行的一步(落子合法或虚着)', async () => {
    await aiPlayerInit();
    const ai = new AiPlayer();
    // 初始化后端后强制 CPU,保证推理可用
    await ai.initBackend();
    await tf.setBackend('cpu');
    await ai.loadModelBytes(new Uint8Array(buildV8()));
    expect(ai.isReady).toBe(true);
    expect(ai.modelName).toBe('testmodel');

    const game = new Game();
    const move = await ai.think(game, { playouts: 20, batchSize: 4, temperature: 0, dirichletWeight: 0 });
    expect(ai.thinking).toBe(false);

    // AI 的着法必须能成功执行(假权重全零 → 均匀策略,任意合法结果均可)
    if (move.kind === 'pass') {
      game.pass();
      expect(game.moveCount).toBe(1);
    } else {
      expect(game.play(move.col, move.row).ok).toBe(true);
    }
  });

  it('模型未就绪时思考抛错', async () => {
    const ai = new AiPlayer();
    await expect(ai.think(new Game())).rejects.toThrow(/未加载/);
  });

  it('难度档位配置合理(推理次数随档位递增)', async () => {
    const { AI_LEVELS } = await import('../src/engine/ai-player');
    const playouts = AI_LEVELS.map((l) => l.config.playouts ?? 0);
    expect(playouts[0]).toBeLessThan(playouts[1]!);
    expect(playouts[1]).toBeLessThan(playouts[2]!);
    // 每档都必须有推理次数
    for (const p of playouts) expect(p).toBeGreaterThan(0);
  });
});

/** 确保 tfjs 后端已注册(webgpu 未启用时至少 wasm/cpu 可用) */
async function aiPlayerInit(): Promise<void> {
  await tf.ready();
}
