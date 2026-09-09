import { describe, expect, it } from 'vitest';
import {
  BLACK,
  Board,
  BOARD_SIZE,
  EMPTY,
  idx,
  opponent,
  WHITE,
} from '../src/core/board';

describe('棋盘基础', () => {
  it('初始为空盘', () => {
    const board = new Board();
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      expect(board.get(i)).toBe(EMPTY);
    }
  });

  it('坐标索引往返一致', () => {
    expect(idx(0, 0)).toBe(0);
    expect(idx(18, 18)).toBe(360);
    expect(idx(9, 9)).toBe(180);
  });

  it('对手色互换', () => {
    expect(opponent(BLACK)).toBe(WHITE);
    expect(opponent(WHITE)).toBe(BLACK);
  });
});

describe('求气', () => {
  it('盘中单子四气', () => {
    const board = new Board();
    board.play(BLACK, idx(9, 9));
    expect(board.countLiberties(board.groupOf(idx(9, 9)))).toBe(4);
  });

  it('边上一子三气,角上二气', () => {
    const edge = new Board();
    edge.play(BLACK, idx(0, 9));
    expect(edge.countLiberties(edge.groupOf(idx(0, 9)))).toBe(3);

    const corner = new Board();
    corner.play(BLACK, idx(0, 0));
    expect(corner.countLiberties(corner.groupOf(idx(0, 0)))).toBe(2);
  });

  it('相邻同色共享气', () => {
    const board = new Board();
    board.play(BLACK, idx(9, 9));
    board.play(BLACK, idx(10, 9));
    expect(board.countLiberties(board.groupOf(idx(9, 9)))).toBe(6);
  });
});

describe('提子', () => {
  it('四面包围提掉单子', () => {
    const board = new Board();
    const center = idx(9, 9);
    board.play(BLACK, center);
    // 白棋包围四气
    board.play(WHITE, idx(8, 9));
    board.play(WHITE, idx(10, 9));
    board.play(WHITE, idx(9, 8));
    expect(board.get(center)).toBe(BLACK);
    const captured = board.play(WHITE, idx(9, 10));
    expect(captured).toEqual([center]);
    expect(board.get(center)).toBe(EMPTY);
  });

  it('落子吃掉一块(多子)', () => {
    const board = new Board();
    // 白棋两子连块,气为 6 个点
    board.play(WHITE, idx(9, 9));
    board.play(WHITE, idx(10, 9));
    // 黑棋逐手填满所有气,填完最后一气时白块即被提
    for (const [col, row] of [
      [8, 9],
      [11, 9],
      [9, 8],
      [10, 8],
      [9, 10],
      [10, 10],
    ] as const) {
      board.play(BLACK, idx(col, row));
    }
    expect(board.get(idx(9, 9))).toBe(EMPTY);
    expect(board.get(idx(10, 9))).toBe(EMPTY);
  });

  it('提子后气的释放:可立即落回原处邻点', () => {
    const board = new Board();
    board.play(BLACK, idx(9, 9));
    board.play(WHITE, idx(8, 9));
    board.play(WHITE, idx(10, 9));
    board.play(WHITE, idx(9, 8));
    board.play(WHITE, idx(9, 10));
    expect(board.get(idx(9, 9))).toBe(EMPTY);
    // 提子后该点及其邻点为空,可再落子
    board.play(WHITE, idx(9, 9));
    expect(board.get(idx(9, 9))).toBe(WHITE);
  });
});

describe('克隆', () => {
  it('克隆互不影响', () => {
    const board = new Board();
    board.play(BLACK, idx(3, 3));
    const copy = board.clone();
    copy.play(WHITE, idx(15, 15));
    expect(board.get(idx(3, 3))).toBe(BLACK);
    expect(board.get(idx(15, 15))).toBe(EMPTY);
    expect(copy.get(idx(15, 15))).toBe(WHITE);
  });
});
