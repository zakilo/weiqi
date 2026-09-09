import { describe, expect, it } from 'vitest';
import { BLACK, idx, WHITE } from '../src/core/board';
import { parseSgf } from '../src/core/sgf';
import { Game } from '../src/store/game';
import { exportGameSgf, gameToLineMoves, parseSgfToLine } from '../src/store/game-io';

describe('对局 ↔ SGF 导入导出', () => {
  it('手顺导出后重新解析,主线一致(含虚着与提子)', () => {
    const game = new Game();
    game.play(3, 3); // 黑 Q16 等价坐标 (3,3)
    game.play(15, 15);
    game.pass();
    game.play(9, 9);

    const text = exportGameSgf(game);
    expect(text).toContain('GM[1]');
    expect(text).toContain('PB[黑方]');
    expect(text).toContain('PW[白方]');

    const line = parseSgfToLine(text)!;
    expect(line).toHaveLength(4);
    expect(line[0]).toEqual({ stone: BLACK, col: 3, row: 3 });
    expect(line[1]).toEqual({ stone: WHITE, col: 15, row: 15 });
    expect(line[2].col).toBeNull();
    expect(line[2].row).toBeNull();
    expect(line[3]).toEqual({ stone: WHITE, col: 9, row: 9 });
  });

  it('终局对局导出含结果属性', () => {
    const game = new Game();
    game.play(0, 0);
    game.play(18, 18);
    game.pass();
    game.pass();
    expect(game.isFinished).toBe(true);
    const text = exportGameSgf(game);
    expect(parseSgf(text)!.properties['RE']![0]).toMatch(/^[BW]\+/);
  });

  it('loadMoves 重建含提子的局面', () => {
    const game = new Game();
    // 黑 (2,0)(1,1)(0,0);白 (0,1)(2,1)(1,0) 提黑 (0,0)
    const ok = game.loadMoves([
      { stone: BLACK, col: 2, row: 0 },
      { stone: WHITE, col: 1, row: 1 },
      { stone: BLACK, col: 0, row: 0 },
      { stone: WHITE, col: 0, row: 1 },
      { stone: BLACK, col: 2, row: 1 },
      { stone: WHITE, col: 1, row: 0 },
    ]);
    expect(ok).toBe(true);
    expect(game.moveCount).toBe(6);
    expect(game.getBoard().get(idx(0, 0))).toBe(0);
    expect(game.getBoard().get(idx(1, 0))).toBe(WHITE);
    // 导出往返一致
    expect(gameToLineMoves(game)).toHaveLength(6);
  });

  it('loadMoves 末尾双虚着正常终局', () => {
    const game = new Game();
    const ok = game.loadMoves([
      { stone: BLACK, col: 3, row: 3 },
      { stone: WHITE, col: 15, row: 15 },
      { stone: BLACK, col: null, row: null },
      { stone: WHITE, col: null, row: null },
    ]);
    expect(ok).toBe(true);
    expect(game.isFinished).toBe(true);
  });

  it('loadMoves 遇非法手返回 false 并保留已加载部分', () => {
    const game = new Game();
    const ok = game.loadMoves([
      { stone: BLACK, col: 3, row: 3 },
      { stone: WHITE, col: 3, row: 3 }, // 已被黑占据 → 非法
    ]);
    expect(ok).toBe(false);
    expect(game.moveCount).toBe(1);
  });

  it('parseSgfToLine 对非法文本返回 null', () => {
    expect(parseSgfToLine('随机文本')).toBeNull();
    expect(parseSgfToLine('')).toBeNull();
  });
});
