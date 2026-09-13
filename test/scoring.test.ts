import { describe, expect, it } from 'vitest';
import { BLACK, Board, idx, WHITE } from '../src/core/board';
import { KOMI_AREA, scoreGame } from '../src/core/scoring';

describe('数子结算', () => {
  it('空棋盘:黑 0 对白贴子 3.5,白胜', () => {
    const r = scoreGame(new Board());
    expect(r.blackStones).toBe(0);
    expect(r.whiteStones).toBe(0);
    expect(r.neutral).toBe(361);
    expect(r.blackScore).toBe(0);
    expect(r.whiteScore).toBe(KOMI_AREA);
    expect(r.margin).toBeCloseTo(-KOMI_AREA);
    expect(r.winner).toBe(WHITE);
  });

  it('黑白各三子无围空:白胜 3.5 子', () => {
    const board = new Board();
    for (const [c, r] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      board.play(BLACK, idx(c, r));
    }
    for (const [c, r] of [
      [18, 18],
      [17, 18],
      [18, 17],
    ] as const) {
      board.play(WHITE, idx(c, r));
    }
    const r = scoreGame(board);
    expect(r.blackStones).toBe(3);
    expect(r.whiteStones).toBe(3);
    expect(r.blackTerritory).toBe(0);
    expect(r.whiteTerritory).toBe(0);
    expect(r.margin).toBeCloseTo(3 - (3 + KOMI_AREA));
    expect(r.winner).toBe(WHITE);
  });

  it('黑围一目:黑 5 对白 4.5,黑胜', () => {
    const board = new Board();
    // 黑四子围住中心点 (10,10)
    for (const [c, r] of [
      [9, 10],
      [11, 10],
      [10, 9],
      [10, 11],
    ] as const) {
      board.play(BLACK, idx(c, r));
    }
    // 白一子远处接壤大空域,使其余空点归中立
    board.play(WHITE, idx(18, 18));
    const r = scoreGame(board);
    expect(r.blackStones).toBe(4);
    expect(r.whiteStones).toBe(1);
    expect(r.blackTerritory).toBe(1);
    expect(r.neutral).toBe(355);
    expect(r.blackScore).toBe(5);
    expect(r.whiteScore).toBeCloseTo(1 + KOMI_AREA);
    expect(r.margin).toBeCloseTo(5 - 1 - KOMI_AREA);
    expect(r.winner).toBe(BLACK);
  });

  it('死子移除:被围死的黑块移走后空归白', () => {
    const board = new Board();
    // 黑三子横排,被白八子完全围死(仅测试结算,正常行棋不会出现零气死子)
    const dead = [idx(9, 9), idx(10, 9), idx(11, 9)];
    for (const i of dead) board.play(BLACK, i);
    for (const [c, r] of [
      [8, 9],
      [9, 8],
      [9, 10],
      [10, 8],
      [10, 10],
      [11, 8],
      [11, 10],
      [12, 9],
    ] as const) {
      board.play(WHITE, idx(c, r));
    }
    // 盘上另有活黑,使大空域归中立
    board.play(BLACK, idx(15, 15));
    const r = scoreGame(board, dead);
    expect(r.blackStones).toBe(1);
    expect(r.whiteStones).toBe(8);
    expect(r.whiteTerritory).toBe(3);
    expect(r.neutral).toBe(349);
    // 总分守恒:盘面 361 = 黑子 + 白子 + 黑空 + 白空 + 中立
    expect(r.blackStones + r.whiteStones + r.blackTerritory + r.whiteTerritory + r.neutral).toBe(361);
  });

  it('可配置贴子:贴 0 时无子局面平局判定归黑(黑先行补偿无)', () => {
    const r = scoreGame(new Board(), [], 0);
    expect(r.margin).toBe(0);
    expect(r.winner).toBe(BLACK);
  });
});
