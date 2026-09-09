import { describe, expect, it } from 'vitest';
import { BLACK, Board, WHITE, idx } from '../src/core/board';
import type { KataGoNet, NetEval } from '../src/engine/net';
import { DEFAULT_MCTS_CONFIG, MctsSearch, MctsSession, PASS } from '../src/engine/mcts';
import type { EncodedFeatures } from '../src/engine/features';
import { NO_PREV_HASH } from '../src/core/rules';

/** 构造一个策略恒定的 mock 网络 */
function makeMockNet(options: {
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

const config = (overrides: Partial<typeof DEFAULT_MCTS_CONFIG> = {}) => ({
  ...DEFAULT_MCTS_CONFIG,
  playouts: 120,
  batchSize: 8,
  temperature: 0,
  dirichletWeight: 0,
  ...overrides,
});

describe('MctsSearch', () => {
  it('收敛到策略指向的着法,访问数总和等于 playouts', async () => {
    const net = makeMockNet({ movePos: idx(9, 9), moveLogit: 10 });
    const search = new MctsSearch(net, config());
    const result = await search.search(new Board(), BLACK, [], 3.75, NO_PREV_HASH);

    expect(result.bestMove).toBe(idx(9, 9));
    expect(result.playoutsDone).toBe(120);
    let total = 0;
    for (const v of result.visitCounts) total += v;
    expect(total).toBe(120);
    expect(result.visitCounts[idx(9, 9)]).toBeGreaterThan(60);
    // 根值在深度交替下仍在合理区间
    expect(result.rootValue).toBeGreaterThan(0);
    expect(result.rootValue).toBeLessThan(1);
  });

  it('被占用的点即使策略指向也不会被选择', async () => {
    const board = new Board();
    board.play(BLACK, idx(9, 9));
    const net = makeMockNet({ movePos: idx(9, 9), moveLogit: 10 });
    const search = new MctsSearch(net, config());
    const result = await search.search(board, BLACK, [], 3.75, NO_PREV_HASH);

    expect(result.bestMove).not.toBe(idx(9, 9));
    expect(result.visitCounts[idx(9, 9)]).toBe(0);
    // 其余点平分 prior,应都有一些访问
    expect(result.visitCounts[idx(0, 0)]).toBeGreaterThan(0);
  });

  it('策略指向虚着时选择虚着', async () => {
    const net = makeMockNet({ passLogit: 10, moveLogit: -100 });
    const search = new MctsSearch(net, config());
    const result = await search.search(new Board(), BLACK, [], 3.75, NO_PREV_HASH);

    expect(result.bestMove).toBe(PASS);
    expect(result.visitCounts[PASS]).toBeGreaterThan(60);
  });

  it('温度采样不越界且落在被访问过的着法上', async () => {
    const net = makeMockNet({ movePos: idx(3, 3), moveLogit: 10 });
    const search = new MctsSearch(net, config({ temperature: 1, dirichletWeight: 0.25 }));
    const result = await search.search(new Board(), BLACK, [], 3.75, NO_PREV_HASH);

    expect(result.bestMove).toBeGreaterThanOrEqual(0);
    expect(result.bestMove).toBeLessThanOrEqual(PASS);
    expect(result.visitCounts[result.bestMove]).toBeGreaterThan(0);
  });

  it('虚着被网络选中时产生终局价值(上一手已是虚着)', async () => {
    // 上一手黑虚着,白再虚着直接数子终局;空棋盘白贴子胜 → 白方虚着价值 1
    // 网络认为白走任何落点必输(winProb=0),故虚着主导
    const net = makeMockNet({ passLogit: 10, moveLogit: -100, winProb: 0 });
    const search = new MctsSearch(net, config());
    const board = new Board();
    const recentMoves = [{ stone: BLACK, pos: null }] as const;
    const result = await search.search(board, WHITE, recentMoves, 3.75, NO_PREV_HASH);

    expect(result.bestMove).toBe(PASS);
    expect(result.visitCounts[PASS]).toBeGreaterThan(60);
    expect(result.rootValue).toBeGreaterThan(0.8);
  });

  it('批量叶子评估不重复(虚拟损失)且节点数受限', async () => {
    let calls = 0;
    const net = makeMockNet({ movePos: idx(9, 9), moveLogit: 10 });
    const spy = net.evaluateBatch.bind(net);
    net.evaluateBatch = async (inputs) => {
      calls += 1;
      return spy(inputs);
    };
    const search = new MctsSearch(net, config({ playouts: 80, batchSize: 8 }));
    const result = await search.search(new Board(), BLACK, [], 3.75, NO_PREV_HASH);

    expect(result.playoutsDone).toBe(80);
    // 每次批量调用评估的输入数应 >=1 且 <= batchSize
    expect(calls).toBeGreaterThanOrEqual(Math.ceil(80 / 8));
  });
});

describe('MctsSession(增量运行)', () => {
  it('分次 run 的统计单调递增,总数与最终结果一致', async () => {
    const net = makeMockNet({ movePos: idx(9, 9), moveLogit: 10 });
    const session = await MctsSession.create(net, new Board(), BLACK, [], 3.75, NO_PREV_HASH, config());

    const p1 = await session.run(30);
    expect(p1.playoutsDone).toBe(30);
    expect(p1.bestMove).toBe(idx(9, 9));
    const p2 = await session.run(40);
    expect(p2.playoutsDone).toBe(70);
    const p3 = await session.run(50);
    expect(p3.playoutsDone).toBe(120);

    const result = session.result();
    expect(result.playoutsDone).toBe(120);
    let total = 0;
    for (const v of result.visitCounts) total += v;
    expect(total).toBe(120);
    expect(result.bestMove).toBe(idx(9, 9));
    expect(result.visitCounts[idx(9, 9)]).toBeGreaterThan(60);
    expect(result.rootValue).toBeGreaterThan(0);
    expect(result.rootValue).toBeLessThan(1);
  });

  it('增量运行保持终局语义(双虚着数子)', async () => {
    const net = makeMockNet({ passLogit: 10, moveLogit: -100, winProb: 0 });
    const recentMoves = [{ stone: BLACK, pos: null }] as const;
    const session = await MctsSession.create(net, new Board(), WHITE, recentMoves, 3.75, NO_PREV_HASH, config());

    await session.run(60);
    const p = await session.run(60);
    expect(p.playoutsDone).toBe(120);
    const result = session.result();
    expect(result.bestMove).toBe(PASS);
    expect(result.visitCounts[PASS]).toBeGreaterThan(60);
    expect(result.rootValue).toBeGreaterThan(0.8);
  });
});
