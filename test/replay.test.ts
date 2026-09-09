import { describe, expect, it } from 'vitest';
import { BLACK, idx, WHITE } from '../src/core/board';
import { SgfLineMove } from '../src/core/sgf';
import { Replay } from '../src/store/replay';

describe('棋谱回放', () => {
  const line: SgfLineMove[] = [
    { stone: BLACK, col: 2, row: 0 },
    { stone: WHITE, col: 1, row: 1 },
    { stone: BLACK, col: 0, row: 0 },
    { stone: WHITE, col: 0, row: 1 },
    { stone: BLACK, col: 2, row: 1 },
    { stone: WHITE, col: 1, row: 0 }, // 提黑 (0,0)
  ];

  it('快照跳转:任意手数局面一致(含提子)', () => {
    const r = Replay.fromMoves(line);
    expect(r.moveCount).toBe(6);
    expect(r.board().get(idx(0, 0))).toBe(0); // 初始空盘

    r.goto(3);
    expect(r.board().get(idx(0, 0))).toBe(BLACK);
    expect(r.lastPlayPos()).toBe(idx(0, 0));

    r.end();
    expect(r.isAtEnd()).toBe(true);
    expect(r.board().get(idx(0, 0))).toBe(0); // 已被提
    expect(r.board().get(idx(1, 0))).toBe(WHITE);
    expect(r.lastPlayPos()).toBe(idx(1, 0));
  });

  it('goto 越界取边界,step 前进后退', () => {
    const r = Replay.fromMoves(line);
    r.goto(100);
    expect(r.pos).toBe(6);
    r.goto(-5);
    expect(r.pos).toBe(0);
    r.step(2);
    expect(r.pos).toBe(2);
    r.step(-1);
    expect(r.pos).toBe(1);
  });

  it('虚着不改变局面但推进手数', () => {
    const r = Replay.fromMoves([
      { stone: BLACK, col: 3, row: 3 },
      { stone: WHITE, col: null, row: null },
      { stone: BLACK, col: 9, row: 9 },
    ]);
    expect(r.moveCount).toBe(3);
    r.goto(2);
    expect(r.board().get(idx(3, 3))).toBe(BLACK);
    expect(r.board().get(idx(9, 9))).toBe(0);
    expect(r.lastPlayPos()).toBe(idx(3, 3));
    r.end();
    expect(r.board().get(idx(9, 9))).toBe(BLACK);
  });

  it('非法手处截断', () => {
    const r = Replay.fromMoves([
      { stone: BLACK, col: 3, row: 3 },
      { stone: WHITE, col: 3, row: 3 }, // 已占点
      { stone: BLACK, col: 9, row: 9 }, // 不应进入
    ]);
    expect(r.moveCount).toBe(1);
    expect(r.lineMoves()).toHaveLength(1);
  });

  it('打劫手视为非法并截断', () => {
    // 与 game.test 相同的提劫形状:黑 (2,0)(1,1)(0,0);白 (0,1)(2,1)(1,0) 提 (0,0)
    // 黑立即提回 (0,0) 为打劫,应被截断
    const r = Replay.fromMoves([
      { stone: BLACK, col: 2, row: 0 },
      { stone: WHITE, col: 1, row: 1 },
      { stone: BLACK, col: 0, row: 0 },
      { stone: WHITE, col: 0, row: 1 },
      { stone: BLACK, col: 2, row: 1 },
      { stone: WHITE, col: 1, row: 0 },
      { stone: BLACK, col: 0, row: 0 }, // 劫回 → 非法
    ]);
    expect(r.moveCount).toBe(6);
  });
});
