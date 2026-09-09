import { describe, expect, it } from 'vitest';
import { BLACK, idx, WHITE } from '../src/core/board';
import { Game } from '../src/store/game';

describe('对局状态机', () => {
  it('黑先白后交替,非法落子不改变状态', () => {
    const game = new Game();
    expect(game.currentStone).toBe(BLACK);
    expect(game.play(3, 3).ok).toBe(true);
    expect(game.currentStone).toBe(WHITE);
    // 已占点非法
    expect(game.play(3, 3)).toEqual({ ok: false, reason: 'occupied' });
    expect(game.currentStone).toBe(WHITE);
    expect(game.moveCount).toBe(1);
  });

  it('单次虚着不结束,连续两次终局并结算', () => {
    const game = new Game();
    game.play(0, 0);
    game.play(18, 18);
    game.pass();
    expect(game.isFinished).toBe(false);
    game.pass();
    expect(game.isFinished).toBe(true);
    expect(game.result).not.toBeNull();
    // 黑 1 子,白 1 子 + 贴 3.75 → 白胜
    expect(game.result!.winner).toBe(WHITE);
    // 终局后不可再落子
    expect(game.play(9, 9)).toEqual({ ok: false, reason: 'game-over' });
  });

  it('悔棋正确回退并重放提子局面', () => {
    const game = new Game();
    // 黑 (2,0)(1,1)(0,0);白 (0,1)(2,1)(1,0) 提黑 (0,0)
    game.play(2, 0);
    game.play(1, 1);
    game.play(0, 0);
    game.play(0, 1);
    game.play(2, 1);
    expect(game.play(1, 0).ok).toBe(true);
    expect(game.getBoard().get(idx(0, 0))).toBe(0);
    // 悔一步:白 (1,0) 撤销,黑 (0,0) 恢复
    game.undo(1);
    expect(game.moveCount).toBe(5);
    expect(game.getBoard().get(idx(0, 0))).toBe(BLACK);
    expect(game.currentStone).toBe(WHITE);
    // 白可再次提劫
    expect(game.play(1, 0).ok).toBe(true);
    expect(game.getBoard().get(idx(0, 0))).toBe(0);
  });

  it('终局后悔棋可继续对局', () => {
    const game = new Game();
    game.play(0, 0);
    game.pass();
    game.pass();
    expect(game.isFinished).toBe(true);
    game.undo(1);
    expect(game.isFinished).toBe(false);
    expect(game.result).toBeNull();
    expect(game.play(18, 18).ok).toBe(true);
  });

  it('新对局清空全部状态', () => {
    const game = new Game();
    game.play(0, 0);
    game.play(18, 18);
    game.restart();
    expect(game.moveCount).toBe(0);
    expect(game.currentStone).toBe(BLACK);
    for (let i = 0; i < 361; i++) {
      expect(game.getBoard().get(i)).toBe(0);
    }
  });
});
