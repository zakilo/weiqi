import { BLACK, Board, idx, Stone, WHITE } from '../core/board';
import { checkLegality, Legality, NO_PREV_HASH } from '../core/rules';
import { KOMI_AREA, ScoreResult, scoreGame } from '../core/scoring';
import { Zobrist } from '../core/zobrist';

/** 一手:落子或虚着 */
export type Move =
  | { kind: 'play'; stone: Stone; pos: number; captured: number[] }
  | { kind: 'pass'; stone: Stone };

export interface PlayOutcome {
  ok: boolean;
  /** 非法原因(ok=false 时) */
  reason?: Legality | 'game-over';
}

/** 对局状态机:手顺、交替、双虚着终局、悔棋重放 */
export class Game {
  private board = new Board();
  private moves: Move[] = [];
  /** 每手(含虚着)落子前的局面哈希,供打劫检测 */
  private beforeHashes: bigint[] = [];
  private consecutivePasses = 0;
  private finished = false;
  private _result: ScoreResult | null = null;

  /** 当前应手方(黑先) */
  get currentStone(): Stone {
    return this.moves.length % 2 === 0 ? BLACK : WHITE;
  }

  get moveCount(): number {
    return this.moves.length;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get result(): ScoreResult | null {
    return this._result;
  }

  get consecutivePassCount(): number {
    return this.consecutivePasses;
  }

  getBoard(): Board {
    return this.board;
  }

  getMoves(): readonly Move[] {
    return this.moves;
  }

  /** 最后一手落子点(虚着或尚无落子时返回 null) */
  getLastPlayPos(): number | null {
    for (let i = this.moves.length - 1; i >= 0; i--) {
      const m = this.moves[i];
      if (m.kind === 'play') return m.pos;
    }
    return null;
  }

  /** 尝试落子;非法时返回原因,不改变状态 */
  play(col: number, row: number): PlayOutcome {
    if (this.finished) return { ok: false, reason: 'game-over' };
    const stone = this.currentStone;
    const pos = idx(col, row);
    const prevHash = this.prevHashForNext;
    const legality = checkLegality(this.board, stone, pos, prevHash);
    if (legality !== 'ok') return { ok: false, reason: legality };

    this.beforeHashes.push(Zobrist.fromBoard(this.board).value);
    const captured = this.board.play(stone, pos);
    this.moves.push({ kind: 'play', stone, pos, captured });
    this.consecutivePasses = 0;
    return { ok: true };
  }

  /** 虚着(pass);连续两次虚着终局 */
  pass(): void {
    if (this.finished) return;
    this.beforeHashes.push(Zobrist.fromBoard(this.board).value);
    this.moves.push({ kind: 'pass', stone: this.currentStone });
    this.consecutivePasses++;
    if (this.consecutivePasses >= 2) {
      this.finish();
    }
  }

  /**
   * 人机悔棋:撤销指定方(人类)的最后一手,以及其后对手的应手
   * 对手尚未应棋时退 1 手,已应棋时退 2 手;无该方手顺时返回 0
   */
  undoSince(stone: Stone): number {
    let i = this.moves.length - 1;
    while (i >= 0 && this.moves[i].stone !== stone) i--;
    if (i < 0) return 0;
    const steps = this.moves.length - i;
    this.undo(steps);
    return steps;
  }

  /** 悔棋:重放前 N 手(默认撤销一手) */
  undo(steps = 1): void {
    const target = Math.max(0, this.moves.length - steps);
    if (target === this.moves.length) return;
    this.board = new Board();
    for (let i = 0; i < target; i++) {
      const m = this.moves[i];
      if (m.kind === 'play') {
        this.board.play(m.stone, m.pos);
      }
    }
    this.moves = this.moves.slice(0, target);
    this.beforeHashes = this.beforeHashes.slice(0, target);
    this.finished = false;
    this._result = null;
    // 重算连续虚着
    this.consecutivePasses = 0;
    for (let i = this.moves.length - 1; i >= 0 && this.moves[i].kind === 'pass'; i--) {
      this.consecutivePasses++;
    }
  }

  /** 重新开始 */
  restart(): void {
    this.board = new Board();
    this.moves = [];
    this.beforeHashes = [];
    this.consecutivePasses = 0;
    this.finished = false;
    this._result = null;
  }

  /**
   * 从手顺重建对局(导入棋谱用):逐手走合法性校验;
   * 中途非法手返回 false(已加载部分保留),末尾双虚着正常终局
   */
  loadMoves(moves: readonly { stone: Stone; col: number | null; row: number | null }[]): boolean {
    this.restart();
    for (const m of moves) {
      if (this.isFinished) break;
      if (m.col === null || m.row === null) {
        this.pass();
      } else {
        const out = this.play(m.col, m.row);
        if (!out.ok) return false;
      }
    }
    return true;
  }

  /** 强制终局结算(双方认输/手动数子时使用) */
  finishWithScore(deadStones: readonly number[] = []): ScoreResult {
    if (!this.finished) {
      this.finished = true;
      this._result = scoreGame(this.board, deadStones, KOMI_AREA);
    }
    return this._result!;
  }

  /** 认输:当前行棋方认输,对方获胜 */
  resign(): { winner: Stone; loser: Stone } {
    const loser = this.currentStone;
    const winner = loser === BLACK ? WHITE : BLACK;
    this.finished = true;
    // 认输时不计分,仅记录胜负
    this._result = {
      blackStones: 0,
      whiteStones: 0,
      blackTerritory: 0,
      whiteTerritory: 0,
      neutral: 0,
      blackScore: loser === BLACK ? 0 : 1,
      whiteScore: loser === WHITE ? 0 : 1,
      margin: winner === BLACK ? 1 : -1,
      winner,
    };
    return { winner, loser };
  }

  /** 下一手打劫检测参照:上一手落子前的局面哈希 */
  get prevHashForNext(): bigint {
    return this.beforeHashes.length > 0
      ? this.beforeHashes[this.beforeHashes.length - 1]
      : NO_PREV_HASH;
  }

  private finish(): void {
    this.finished = true;
    this._result = scoreGame(this.board, [], KOMI_AREA);
  }
}
