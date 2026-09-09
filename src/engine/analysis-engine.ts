/**
 * 分析引擎(纯逻辑,不依赖 Worker/DOM,可在 Node 中单测):
 *  - AnalysisTask:持续分析一个局面,增量迭代产出候选快照
 *  - searchVariation:从候选着法出发,双方按最优着法互搏展开变化线
 *  - WireRequest/WorkerIn/WorkerOut:主线程与 Worker 的消息协议
 */
import { Board, opponent, Stone } from '../core/board';
import { Zobrist } from '../core/zobrist';
import type { EncodedMove } from './features';
import type { KataGoNet } from './net';
import { CandidateInfo, MctsConfig, MctsSession, PASS } from './mcts';

/** 落地后的分析局面(内部使用) */
export interface AnalysisState {
  board: Board;
  stone: Stone;
  recentMoves: readonly EncodedMove[];
  komi: number;
  prevHash: bigint;
}

/** 跨线程传输形式(board 快照,哈希序列化) */
export interface WireRequest {
  board: Int8Array;
  stone: Stone;
  recentMoves: EncodedMove[];
  komi: number;
  prevHash: string;
}

export function requestToWire(s: AnalysisState): WireRequest {
  return {
    board: s.board.cellsCopy(),
    stone: s.stone,
    recentMoves: s.recentMoves.slice(),
    komi: s.komi,
    prevHash: s.prevHash.toString(),
  };
}

export function requestFromWire(w: WireRequest): AnalysisState {
  return {
    board: Board.fromCells(w.board),
    stone: w.stone,
    recentMoves: w.recentMoves,
    komi: w.komi,
    prevHash: BigInt(w.prevHash),
  };
}

export interface AnalysisSnapshot {
  playouts: number;
  /** 行棋方视角根价值 */
  rootValue: number;
  bestMove: number;
  candidates: CandidateInfo[];
}

/** 每步变化展开的默认推理次数 */
export const VARIATION_PLAYOUTS = 120;
/** 变化线长度(含候选首手) */
export const VARIATION_DEPTH = 15;
/** 候选展示数量 */
export const ANALYSIS_TOP_K = 5;
/** 持续分析每次快照间隔(推理次数) */
export const ANALYSIS_PROGRESS_EVERY = 40;

/** 分析用搜索配置(温度 0:展示最优;轻噪声保持探索) */
export const ANALYSIS_CONFIG: MctsConfig = {
  playouts: 200,
  batchSize: 8,
  cpuct: 1.5,
  temperature: 0,
  dirichletWeight: 0.1,
  dirichletAlpha: 0,
  maxDepth: 512,
};

/** 持续分析任务:start 建会话,iterate 增量迭代产出快照 */
export class AnalysisTask {
  private session: MctsSession | null = null;
  private _cancelled = false;

  constructor(
    private readonly net: KataGoNet,
    private readonly config: MctsConfig = ANALYSIS_CONFIG,
  ) {}

  get cancelled(): boolean {
    return this._cancelled;
  }

  async start(state: AnalysisState): Promise<void> {
    this._cancelled = false;
    this.session = await MctsSession.create(
      this.net,
      state.board,
      state.stone,
      state.recentMoves,
      state.komi,
      state.prevHash,
      this.config,
    );
  }

  cancel(): void {
    this._cancelled = true;
  }

  /** 每 progressEvery 次推理产出一次快照;取消后迭代立即结束 */
  async *iterate(progressEvery: number): AsyncGenerator<AnalysisSnapshot> {
    const session = this.session;
    if (!session) return;
    while (!this._cancelled) {
      const p = await session.run(progressEvery);
      if (this._cancelled) return;
      yield {
        playouts: p.playoutsDone,
        rootValue: p.rootValue,
        bestMove: p.bestMove,
        candidates: session.topMoves(ANALYSIS_TOP_K),
      };
    }
  }
}

export interface VariationOptions {
  /** 每步搜索推理次数 */
  perMovePlayouts: number;
  /** 变化线长度(含首手) */
  depth: number;
  /** 每展开一步回调(move=落点或 PASS,index 从 0 起) */
  onStep?: (move: number, index: number) => void;
  /** 外部取消检查 */
  isCancelled?: () => boolean;
}

/**
 * 变化线展开:先落下 firstMove(候选着法),之后双方各步取短搜索
 * 最优着法,直到 depth 步、被取消或双虚着终局。返回含首手的着法序列。
 */
export async function searchVariation(
  net: KataGoNet,
  state: AnalysisState,
  firstMove: number,
  options: VariationOptions,
): Promise<number[]> {
  const board = state.board.clone();
  let stone = state.stone;
  let recentMoves = [...state.recentMoves];
  let prevHash = state.prevHash;

  const applyMove = (pos: number): void => {
    // 打劫检测参照:上一手落子前局面(虚着时即当前局面)
    prevHash = Zobrist.fromBoard(board).value;
    if (pos !== PASS) board.play(stone, pos);
    recentMoves = [...recentMoves.slice(-4), { stone, pos: pos === PASS ? null : pos }];
    stone = opponent(stone);
  };

  const config: MctsConfig = {
    ...ANALYSIS_CONFIG,
    playouts: options.perMovePlayouts,
    dirichletWeight: 0,
  };

  const line: number[] = [];
  applyMove(firstMove);
  line.push(firstMove);
  options.onStep?.(firstMove, 0);

  for (let d = 1; d < options.depth; d++) {
    if (options.isCancelled?.()) break;
    // 双方虚着 → 数子终局,变化线结束
    if (line.length >= 2 && line[line.length - 1] === PASS && line[line.length - 2] === PASS) break;

    const session = await MctsSession.create(net, board, stone, recentMoves, state.komi, prevHash, config);
    await session.run(options.perMovePlayouts);
    const best = session.result().bestMove;
    applyMove(best);
    line.push(best);
    options.onStep?.(best, d);
  }
  return line;
}

/** 主线程 → Worker 消息 */
export type WorkerIn =
  | { type: 'init'; modelBytes: ArrayBuffer }
  | { type: 'analyze'; id: number; request: WireRequest }
  | { type: 'stop' }
  | { type: 'variation'; id: number; request: WireRequest; startMove: number; depth: number; perMovePlayouts: number };

/** Worker → 主线程消息 */
export type WorkerOut =
  | { type: 'ready'; backend: string }
  | { type: 'error'; id: number | null; message: string }
  | { type: 'snapshot'; id: number; snapshot: AnalysisSnapshot }
  | { type: 'variation-step'; id: number; move: number; index: number }
  | { type: 'variation-done'; id: number; line: number[] };
