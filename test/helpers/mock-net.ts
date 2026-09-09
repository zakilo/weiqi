import { idx } from '../../src/core/board';
import type { EncodedFeatures } from '../../src/engine/features';
import type { KataGoNet, NetEval } from '../../src/engine/net';

/** 构造一个策略恒定的 mock 网络(供搜索/分析单测) */
export function makeMockNet(options: {
  movePos?: number;
  moveLogit?: number;
  passLogit?: number;
  winProb?: number;
}): KataGoNet {
  const { movePos = idx(9, 9), moveLogit = 10, passLogit = -5, winProb = 0.8 } = options;
  const makeEval = (): NetEval => {
    const policyLogits = new Float32Array(361);
    policyLogits[movePos] = moveLogit;
    return {
      policyLogits,
      passLogit,
      winProb,
      scoreLead: 2,
      scoreMean: 5,
      noResultProb: 0.01,
    };
  };
  return {
    async evaluate(_input: EncodedFeatures): Promise<NetEval> {
      return makeEval();
    },
    async evaluateBatch(inputs: readonly EncodedFeatures[]): Promise<NetEval[]> {
      return inputs.map(() => makeEval());
    },
  } as unknown as KataGoNet;
}
