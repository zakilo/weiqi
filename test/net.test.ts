import { describe, expect, it } from 'vitest';
import * as tf from '@tensorflow/tfjs';
import { Board } from '../src/core/board';
import { parseKataGoModel } from '../src/engine/weights';
import { KataGoNet } from '../src/engine/net';
import { encodeFeatures } from '../src/engine/features';
import { buildV8 } from './helpers/model-builder';

describe('KataGoNet(CPU 后端,零权重假模型)', () => {
  it('空棋盘前向:输出形状与后处理数值正确', async () => {
    await tf.setBackend('cpu');
    await tf.ready();

    const net = new KataGoNet(parseKataGoModel(buildV8()));
    try {
      const board = new Board();
      const evalResult = await net.evaluate(encodeFeatures(board, 1, []));

      // policy logits:361 个落点,全零权重 → 全 0
      expect(evalResult.policyLogits.length).toBe(361);
      for (const v of evalResult.policyLogits) expect(v).toBe(0);
      // pass logit:全零权重 → 0
      expect(evalResult.passLogit).toBe(0);
      // value 三值 logits 全 0 → 均匀 softmax
      expect(evalResult.winProb).toBeCloseTo(1 / 3);
      expect(evalResult.noResultProb).toBeCloseTo(1 / 3);
      // score 头全 0
      expect(evalResult.scoreMean).toBeCloseTo(0);
      expect(evalResult.scoreLead).toBeCloseTo(0);
    } finally {
      net.dispose();
    }
  });

  it('批量推理返回与输入同序的结果', async () => {
    await tf.setBackend('cpu');
    await tf.ready();

    const net = new KataGoNet(parseKataGoModel(buildV8()));
    try {
      const board = new Board();
      const inputs = [encodeFeatures(board, 1, []), encodeFeatures(board, 2, [])];
      const results = await net.evaluateBatch(inputs);
      expect(results.length).toBe(2);
      for (const r of results) {
        expect(r.policyLogits.length).toBe(361);
        expect(r.winProb).toBeCloseTo(1 / 3);
      }
    } finally {
      net.dispose();
    }
  });
});
