import { describe, expect, it } from 'vitest';
import { BLACK, Board, EMPTY, idx, WHITE } from '../src/core/board';

describe('边界局面', () => {
  it('边上一线提子', () => {
    const board = new Board();
    // 黑一子贴边
    board.play(BLACK, idx(0, 9));
    board.play(WHITE, idx(1, 9));
    board.play(WHITE, idx(0, 8));
    expect(board.get(idx(0, 9))).toBe(BLACK);
    board.play(WHITE, idx(0, 10));
    expect(board.get(idx(0, 9))).toBe(EMPTY);
  });

  it('19 子大龙整体被提', () => {
    const board = new Board();
    // 黑 19 子占满第 0 行
    for (let col = 0; col < 19; col++) board.play(BLACK, idx(col, 0));
    // 白逐手填满第 1 行(黑大龙唯一的气)
    for (let col = 0; col < 19; col++) {
      const captured = board.play(WHITE, idx(col, 1));
      if (col < 18) {
        expect(captured).toEqual([]);
      } else {
        expect(captured).toHaveLength(19);
      }
    }
    for (let col = 0; col < 19; col++) {
      expect(board.get(idx(col, 0))).toBe(EMPTY);
    }
  });

  it('提子只提相邻无气块,不波及有气块', () => {
    const board = new Board();
    // 黑两块:单子 (0,0) 与二连块 (5,5)(6,5),相距甚远
    board.play(BLACK, idx(0, 0));
    board.play(BLACK, idx(5, 5));
    board.play(BLACK, idx(6, 5));
    // 白围杀 (0,0)
    board.play(WHITE, idx(1, 0));
    board.play(WHITE, idx(0, 1));
    // 远处黑块不受影响
    expect(board.get(idx(5, 5))).toBe(BLACK);
    expect(board.get(idx(6, 5))).toBe(BLACK);
  });
});
