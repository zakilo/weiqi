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
    // 黑 1 子,白 1 子 + 贴 3.5 → 白胜
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

  it('人机悔棋:AI 已应则退两手,未应则退一手', () => {
    const game = new Game();
    game.play(3, 3); // 黑(人)
    game.play(15, 15); // 白(AI)
    game.play(3, 15); // 黑(人)
    game.play(15, 3); // 白(AI)
    expect(game.undoSince(BLACK)).toBe(2);
    expect(game.moveCount).toBe(2);
    expect(game.currentStone).toBe(BLACK);
    expect(game.getBoard().get(idx(15, 3))).toBe(0);
    expect(game.getBoard().get(idx(3, 15))).toBe(0);
    // 黑落子后白未应,仅退黑这一手
    expect(game.play(9, 9).ok).toBe(true);
    expect(game.undoSince(BLACK)).toBe(1);
    expect(game.moveCount).toBe(2);
    expect(game.currentStone).toBe(BLACK);
    // 尚无人类手顺时不作废
    game.restart();
    game.play(3, 3); // 仅有黑手顺,人类(白)未落子
    expect(game.undoSince(WHITE)).toBe(0);
    expect(game.moveCount).toBe(1);
  });

  it('人机悔棋:AI 虚着应手与终局一并撤销', () => {
    const game = new Game();
    game.play(3, 3); // 黑(人)
    game.play(15, 15); // 白(AI)
    game.pass(); // 黑(人)
    game.pass(); // 白(AI) 终局
    expect(game.isFinished).toBe(true);
    expect(game.undoSince(BLACK)).toBe(2);
    expect(game.moveCount).toBe(2);
    expect(game.isFinished).toBe(false);
    expect(game.result).toBeNull();
    expect(game.consecutivePassCount).toBe(0);
    expect(game.currentStone).toBe(BLACK);
    // 退后回到人类落子,可正常继续
    expect(game.play(9, 9).ok).toBe(true);
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
