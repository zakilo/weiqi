import { Board, idx } from '../core/board';
import { checkLegality, NO_PREV_HASH } from '../core/rules';
import { SgfLineMove } from '../core/sgf';
import { Zobrist } from '../core/zobrist';

/**
 * 棋谱回放:加载时逐手重放并预计算每步局面快照,
 * 之后可在任意手数间 O(1) 跳转;非法手处截断
 */
export class Replay {
  private readonly _moveCount: number;
  /** boards[i] = 第 i 手后的局面(i ∈ [0, moveCount]);虚着共享前一快照 */
  private readonly boards: Board[];
  /** lastPlays[i] = 第 i 手后最近一次落子点 */
  private readonly lastPlays: (number | null)[];
  private readonly moves: SgfLineMove[];
  private _pos = 0;

  private constructor(
    moveCount: number,
    boards: Board[],
    lastPlays: (number | null)[],
    moves: SgfLineMove[],
  ) {
    this._moveCount = moveCount;
    this.boards = boards;
    this.lastPlays = lastPlays;
    this.moves = moves;
  }

  /** 从主线手顺构建回放(含打劫校验);非法手处截断 */
  static fromMoves(moves: readonly SgfLineMove[]): Replay {
    const boards: Board[] = [new Board()];
    const lastPlays: (number | null)[] = [null];
    const valid: SgfLineMove[] = [];
    let board = new Board();
    let prevHash = NO_PREV_HASH;

    for (const m of moves) {
      if (m.col === null || m.row === null) {
        // 虚着:局面不变
        boards.push(board);
        lastPlays.push(lastPlays[lastPlays.length - 1]!);
        prevHash = Zobrist.fromBoard(board).value;
        valid.push(m);
        continue;
      }
      const pos = idx(m.col, m.row);
      if (checkLegality(board, m.stone, pos, prevHash) !== 'ok') break;
      prevHash = Zobrist.fromBoard(board).value;
      board = board.clone();
      board.play(m.stone, pos);
      boards.push(board);
      lastPlays.push(pos);
      valid.push(m);
    }
    return new Replay(valid.length, boards, lastPlays, valid);
  }

  /** 当前视角手数(0 = 初始空盘) */
  get pos(): number {
    return this._pos;
  }

  /** 有效手数 */
  get moveCount(): number {
    return this._moveCount;
  }

  /** 有效主线手顺(供继续对弈/导出) */
  lineMoves(): readonly SgfLineMove[] {
    return this.moves;
  }

  /** 当前视角局面 */
  board(): Board {
    return this.boards[this._pos]!;
  }

  /** 当前视角最近落子点(无落子时 null) */
  lastPlayPos(): number | null {
    return this.lastPlays[this._pos]!;
  }

  isAtStart(): boolean {
    return this._pos === 0;
  }

  isAtEnd(): boolean {
    return this._pos === this._moveCount;
  }

  /** 跳到指定手数(越界取边界) */
  goto(pos: number): void {
    this._pos = Math.max(0, Math.min(this._moveCount, pos));
  }

  /** 前进/后退 delta 手 */
  step(delta: number): void {
    this.goto(this._pos + delta);
  }

  start(): void {
    this._pos = 0;
  }

  end(): void {
    this._pos = this._moveCount;
  }
}
