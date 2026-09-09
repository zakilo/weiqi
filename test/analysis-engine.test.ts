import { describe, expect, it } from 'vitest';
import { BLACK, Board, Stone, WHITE, idx } from '../src/core/board';
import { NO_PREV_HASH } from '../src/core/rules';
import {
  ANALYSIS_CONFIG,
  AnalysisTask,
  requestFromWire,
  requestToWire,
  searchVariation,
} from '../src/engine/analysis-engine';
import { PASS } from '../src/engine/mcts';
import { makeMockNet } from './helpers/mock-net';

const state = {
  board: new Board(),
  stone: BLACK as Stone,
  recentMoves: [] as const,
  komi: 3.75,
  prevHash: NO_PREV_HASH,
};

describe('AnalysisTask', () => {
  it('持续迭代产出递增快照,candidates 按访问数降序', async () => {
    const net = makeMockNet({ movePos: idx(9, 9), moveLogit: 10 });
    const task = new AnalysisTask(net, { ...ANALYSIS_CONFIG, dirichletWeight: 0 });
    await task.start(state);

    const it = task.iterate(20);
    const s1 = (await it.next()).value!;
    expect(s1.playouts).toBe(20);
    expect(s1.bestMove).toBe(idx(9, 9));
    expect(s1.candidates.length).toBeGreaterThan(0);
    const s2 = (await it.next()).value!;
    expect(s2.playouts).toBe(40);
    expect(s2.candidates[0]!.visits).toBeGreaterThanOrEqual(s2.candidates[1]!.visits);
    // 胜率与价值均在合理区间
    for (const c of s2.candidates) {
      expect(c.winRate).toBeGreaterThanOrEqual(0);
      expect(c.winRate).toBeLessThanOrEqual(1);
    }
    expect(s2.rootValue).toBeGreaterThan(0);
    expect(s2.rootValue).toBeLessThan(1);
  });

  it('cancel 后迭代立即结束', async () => {
    const net = makeMockNet({});
    const task = new AnalysisTask(net, { ...ANALYSIS_CONFIG, dirichletWeight: 0 });
    await task.start(state);
    const it = task.iterate(10);
    await it.next();
    task.cancel();
    expect((await it.next()).done).toBe(true);
  });
});

describe('searchVariation', () => {
  it('从候选着法展开固定深度,每步可实际执行', async () => {
    const net = makeMockNet({ movePos: idx(9, 9), moveLogit: 10 });
    const first = idx(3, 3);
    const steps: number[] = [];
    const line = await searchVariation(net, state, first, {
      perMovePlayouts: 20,
      depth: 6,
      onStep: (m, i) => {
        steps[i] = m;
      },
    });

    expect(line.length).toBe(6);
    expect(line[0]).toBe(first);
    // 第二步:网络指向 (9,9)(此时为空),应被选中
    expect(line[1]).toBe(idx(9, 9));
    // 之后 (9,9) 被占,均匀策略下不断言具体点,只验证回调与可执行性
    expect(steps).toEqual(line);

    // 重放验证合法性(黑白交替落子)
    const board = new Board();
    let stone: Stone = BLACK;
    for (const pos of line) {
      expect(pos).not.toBe(PASS);
      board.play(stone, pos);
      stone = stone === BLACK ? WHITE : BLACK;
    }
  });

  it('双方虚着终局时变化线提前结束', async () => {
    const net = makeMockNet({ passLogit: 10, moveLogit: -100, winProb: 0 });
    const line = await searchVariation(net, state, PASS, { perMovePlayouts: 20, depth: 8 });
    expect(line.length).toBe(2);
    expect(line[0]).toBe(PASS);
    expect(line[1]).toBe(PASS);
  });

  it('isCancelled 提前终止变化线', async () => {
    const net = makeMockNet({ movePos: idx(9, 9), moveLogit: 10 });
    let count = 0;
    const line = await searchVariation(net, state, idx(3, 3), {
      perMovePlayouts: 20,
      depth: 10,
      onStep: () => {
        count++;
      },
      isCancelled: () => count >= 3,
    });
    expect(line.length).toBe(3);
  });
});

describe('wire 转换', () => {
  it('requestToWire/requestFromWire 往返一致', () => {
    const board = new Board();
    board.play(BLACK, idx(4, 4));
    const s = {
      board,
      stone: WHITE as Stone,
      recentMoves: [{ stone: BLACK as Stone, pos: idx(4, 4) }] as const,
      komi: 3.75,
      prevHash: 123456789n,
    };
    const back = requestFromWire(requestToWire(s));
    expect(back.board.get(idx(4, 4))).toBe(BLACK);
    expect(back.stone).toBe(WHITE);
    expect(back.recentMoves).toEqual(s.recentMoves);
    expect(back.komi).toBe(3.75);
    expect(back.prevHash).toBe(123456789n);
  });
});
