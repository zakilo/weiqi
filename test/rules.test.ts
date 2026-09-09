import { describe, expect, it } from 'vitest';
import { BLACK, Board, EMPTY, idx, WHITE } from '../src/core/board';
import { isLegal, NO_PREV_HASH } from '../src/core/rules';
import { Zobrist } from '../src/core/zobrist';

/** 合法落子并返回落子**前**局面的哈希(作为下一手的打劫参照) */
function playLegal(board: Board, stone: 1 | 2, col: number, row: number, prevHash: bigint): bigint {
  const before = Zobrist.fromBoard(board).value;
  const i = idx(col, row);
  expect(isLegal(board, stone, i, prevHash)).toBe(true);
  board.play(stone, i);
  return before;
}

describe('落子合法性', () => {
  it('空点可落子,已占点不可落', () => {
    const board = new Board();
    board.play(BLACK, idx(9, 9));
    expect(isLegal(board, WHITE, idx(9, 9), NO_PREV_HASH)).toBe(false);
    expect(isLegal(board, WHITE, idx(9, 10), NO_PREV_HASH)).toBe(true);
  });

  it('自杀非法:落子后自身无气且不提对方', () => {
    const board = new Board();
    // 白三子堵住角点 (0,0) 的两个邻点
    board.play(WHITE, idx(0, 1));
    board.play(WHITE, idx(1, 0));
    board.play(WHITE, idx(1, 1));
    expect(isLegal(board, BLACK, idx(0, 0), NO_PREV_HASH)).toBe(false);
  });

  it('似自杀但可提子则合法', () => {
    const board = new Board();
    // 构造角部:黑 (1,0)(0,1) 被白包紧至各余一气
    board.play(BLACK, idx(1, 0));
    board.play(BLACK, idx(0, 1));
    board.play(WHITE, idx(1, 1));
    board.play(WHITE, idx(0, 2));
    board.play(WHITE, idx(2, 0));
    // 白落 (0,0):自身无气,但提掉两黑子获得气 → 合法
    expect(isLegal(board, WHITE, idx(0, 0), NO_PREV_HASH)).toBe(true);
    board.play(WHITE, idx(0, 0));
    expect(board.get(idx(1, 0))).toBe(EMPTY);
    expect(board.get(idx(0, 1))).toBe(EMPTY);
    expect(board.get(idx(0, 0))).toBe(WHITE);
  });
});

describe('打劫', () => {
  it('标准劫:提劫合法,立即回提非法', () => {
    const board = new Board();
    // 构造劫形(角部)
    let hash = NO_PREV_HASH;
    hash = playLegal(board, BLACK, 2, 0, hash);
    hash = playLegal(board, BLACK, 1, 1, hash);
    hash = playLegal(board, BLACK, 0, 0, hash);
    hash = playLegal(board, WHITE, 0, 1, hash);
    hash = playLegal(board, WHITE, 2, 1, hash);
    // 白 (1,0) 提黑 (0,0),形成劫
    hash = playLegal(board, WHITE, 1, 0, hash);
    expect(board.get(idx(0, 0))).toBe(EMPTY);
    // 黑立即回提 (0,0) 会恢复劫前局面 → 非法
    expect(isLegal(board, BLACK, idx(0, 0), hash)).toBe(false);
  });

  it('劫材交换后可以回提', () => {
    const board = new Board();
    let hash = NO_PREV_HASH;
    hash = playLegal(board, BLACK, 2, 0, hash);
    hash = playLegal(board, BLACK, 1, 1, hash);
    hash = playLegal(board, BLACK, 0, 0, hash);
    hash = playLegal(board, WHITE, 0, 1, hash);
    hash = playLegal(board, WHITE, 2, 1, hash);
    hash = playLegal(board, WHITE, 1, 0, hash);
    // 黑走别处(找劫材)
    hash = playLegal(board, BLACK, 9, 9, hash);
    // 白应劫材
    hash = playLegal(board, WHITE, 9, 10, hash);
    // 黑现在可以回提 (0,0)
    expect(isLegal(board, BLACK, idx(0, 0), hash)).toBe(true);
  });
});

describe('Zobrist 哈希', () => {
  it('相同局面哈希一致,不同局面哈希不同', () => {
    const a = new Board();
    a.play(BLACK, idx(3, 3));
    a.play(WHITE, idx(15, 15));
    const b = new Board();
    b.play(BLACK, idx(3, 3));
    b.play(WHITE, idx(15, 15));
    const c = new Board();
    c.play(BLACK, idx(3, 3));
    c.play(WHITE, idx(15, 16));
    expect(Zobrist.fromBoard(a).value).toBe(Zobrist.fromBoard(b).value);
    expect(Zobrist.fromBoard(a).value).not.toBe(Zobrist.fromBoard(c).value);
  });

  it('增量更新与全量扫描一致(含提子)', () => {
    const board = new Board();
    board.play(BLACK, idx(9, 9));
    const z = Zobrist.fromBoard(board);
    // 白逐手占去黑 (9,9) 的三口气,增量同步
    board.play(WHITE, idx(9, 8));
    z.update(idx(9, 8), EMPTY, WHITE);
    expect(z.value).toBe(Zobrist.fromBoard(board).value);
    board.play(WHITE, idx(9, 10));
    z.update(idx(9, 10), EMPTY, WHITE);
    board.play(WHITE, idx(8, 9));
    z.update(idx(8, 9), EMPTY, WHITE);
    // 白落 (10,9) 堵住最后一气,提掉黑 (9,9)
    board.play(WHITE, idx(10, 9));
    z.update(idx(10, 9), EMPTY, WHITE);
    z.update(idx(9, 9), BLACK, EMPTY);
    expect(z.value).toBe(Zobrist.fromBoard(board).value);
    expect(board.get(idx(9, 9))).toBe(EMPTY);
  });
});
