/**
 * MCTS 搜索(PUCT):与 KataGoNet 协作完成一步棋的搜索。
 *  - 选择:Q + cpuct * P * sqrt(N_parent) / (1 + N_child)
 *  - 扩展:叶子网络评估后按合法着法建子节点(含虚着)
 *  - 回传:胜率从各节点行棋方视角交替累计
 *  - 批量:每批收集 batchSize 个叶子(虚拟损失防重复),一次 evaluateBatch
 *  - 根节点 Dirichlet 噪声增强多样性;双虚着/超深度按中国规则数子终局
 */
import { Board, BOARD_SIZE, EMPTY, opponent, Stone } from '../core/board';
import { checkLegality, NO_PREV_HASH } from '../core/rules';
import { KOMI_AREA, scoreGame } from '../core/scoring';
import { Zobrist } from '../core/zobrist';
import { encodeFeatures, EncodedMove } from './features';
import type { KataGoNet, NetEval } from './net';

/** 虚着在着法列表中的索引(0..360 为落点) */
export const PASS = BOARD_SIZE * BOARD_SIZE;

export interface MctsConfig {
  /** 每次搜索的推理总次数 */
  playouts: number;
  /** 每批叶子评估数(越大推理越高效) */
  batchSize: number;
  /** PUCT 探索系数 */
  cpuct: number;
  /** 根节点着法采样温度:0 取最大访问数,1 按访问数概率采样 */
  temperature: number;
  /** Dirichlet 噪声权重(0 关闭) */
  dirichletWeight: number;
  /** Dirichlet 噪声 alpha(0 时按 0.03*361/合法着法数 自适应) */
  dirichletAlpha: number;
  /** 树深上限,超过即按数子终局 */
  maxDepth: number;
}

export const DEFAULT_MCTS_CONFIG: MctsConfig = {
  playouts: 200,
  batchSize: 1,
  cpuct: 1.5,
  temperature: 1,
  dirichletWeight: 0.25,
  dirichletAlpha: 0,
  maxDepth: 512,
};

export interface MctsSearchResult {
  /** 每个着法(0..360 落点,361=虚着)的访问次数 */
  visitCounts: Float32Array;
  /** 根局面行棋方视角的搜索价值 */
  rootValue: number;
  /** 温度采样后的最佳着法(0..360 或 361=虚着) */
  bestMove: number;
  /** 实际完成的推理次数 */
  playoutsDone: number;
}

export interface MctsProgress {
  /** 已完成的推理次数 */
  playoutsDone: number;
  /** 根局面行棋方视角的搜索价值 */
  rootValue: number;
  /** 当前最佳着法(0..360 或 361=虚着) */
  bestMove: number;
}

interface MctsNode {
  parent: MctsNode | null;
  /** 到达本节点的着法:-1=根,0..360=落点,361=虚着 */
  pos: number;
  stone: Stone;
  depth: number;
  visits: number;
  winSum: number;
  prior: number;
  children: Map<number, MctsNode> | null;
  /** 评估中标记(虚拟损失) */
  isExpanding: boolean;
  /** 终局价值(双虚着/超深度) */
  terminalValue?: number;
  /** 惰性:仅路径上的节点持有棋盘与哈希 */
  board?: Board;
  hash?: bigint;
  /** 打劫检测参照:上一手落子前局面 */
  koHash: bigint;
  /** 最近 5 手(含到达本节点的一手,时间升序) */
  lastMoves: EncodedMove[];
}

const gaussianRandom = (): number => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** Gamma 采样(Marsaglia-Tsang 法),供 Dirichlet 噪声使用 */
const gammaSample = (alpha: number): number => {
  if (alpha < 1) {
    const u = Math.random();
    return gammaSample(alpha + 1) * Math.pow(u, 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussianRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
};

export class MctsSearch {
  private readonly config: MctsConfig;
  private readonly net: KataGoNet;

  constructor(net: KataGoNet, config: Partial<MctsConfig> = {}) {
    this.net = net;
    this.config = { ...DEFAULT_MCTS_CONFIG, ...config };
  }

  /**
   * 搜索一步。
   * @param prevHash 打劫检测参照(Game.prevHashForNext 语义,无上一手传 NO_PREV_HASH)
   */
  async search(
    board: Board,
    currentPlayer: Stone,
    recentMoves: readonly EncodedMove[],
    komi: number = KOMI_AREA,
    prevHash: bigint = NO_PREV_HASH,
  ): Promise<MctsSearchResult> {
    const session = await MctsSession.create(this.net, board, currentPlayer, recentMoves, komi, prevHash, this.config);
    await session.run(this.config.playouts);
    return session.result();
  }
}

/**
 * 一次搜索会话:建根并完成根评估后,可反复增量运行
 * (供持续分析/变化线使用)。每次 run 返回进度快照,result 汇总最终统计。
 */
export class MctsSession {
  private readonly config: MctsConfig;
  private readonly net: KataGoNet;
  private readonly komi: number;
  private readonly root: MctsNode;
  private readonly rootEvalWinProb: number;
  private playoutsTotal = 0;

  private constructor(
    net: KataGoNet,
    config: MctsConfig,
    komi: number,
    root: MctsNode,
    rootEvalWinProb: number,
  ) {
    this.net = net;
    this.config = config;
    this.komi = komi;
    this.root = root;
    this.rootEvalWinProb = rootEvalWinProb;
  }

  /** 建根、完成根评估与扩展(含 Dirichlet 噪声) */
  static async create(
    net: KataGoNet,
    board: Board,
    currentPlayer: Stone,
    recentMoves: readonly EncodedMove[],
    komi: number,
    prevHash: bigint,
    config: MctsConfig,
  ): Promise<MctsSession> {
    const root: MctsNode = {
      parent: null,
      pos: -1,
      stone: currentPlayer,
      depth: 0,
      visits: 0,
      winSum: 0,
      prior: 1,
      children: null,
      isExpanding: false,
      board: board.clone(),
      hash: Zobrist.fromBoard(board).value,
      koHash: prevHash,
      lastMoves: recentMoves.slice(-5),
    };

    // 根节点先行评估与扩展
    const rootEval = await net.evaluate(encodeFeatures(root.board!, root.stone, root.lastMoves, { komi }));
    const session = new MctsSession(net, config, komi, root, rootEval.winProb);
    session.root.children = session.buildChildren(session.root, rootEval, true);
    return session;
  }

  /** 增量运行 playouts 次推理,返回进度快照 */
  async run(playouts: number): Promise<MctsProgress> {
    const numBatches = Math.ceil(playouts / this.config.batchSize);
    let done = 0;
    for (let b = 0; b < numBatches && done < playouts; b++) {
      const count = Math.min(this.config.batchSize, playouts - done);
      const leaves: MctsNode[] = [];
      for (let i = 0; i < count; i++) {
        const leaf = this.select(this.root);
        this.ensureState(leaf);
        if (leaf.terminalValue !== undefined) {
          this.backup(leaf, leaf.terminalValue);
          done++;
          continue;
        }
        if (leaf.depth >= this.config.maxDepth) {
          // 超深度:按数子终局,不再展开
          leaf.terminalValue = this.terminalScoreValue(leaf.board!, leaf.stone);
          this.backup(leaf, leaf.terminalValue);
          done++;
          continue;
        }
        leaf.isExpanding = true;
        leaves.push(leaf);
      }

      if (leaves.length > 0) {
        const inputs = leaves.map((l) => encodeFeatures(l.board!, l.stone, l.lastMoves, { komi: this.komi }));
        const results = await this.net.evaluateBatch(inputs);
        for (let i = 0; i < leaves.length; i++) {
          const leaf = leaves[i]!;
          leaf.isExpanding = false;
          leaf.children = this.buildChildren(leaf, results[i]!, false);
          this.backup(leaf, results[i]!.winProb);
          done++;
        }
      }
    }
    this.playoutsTotal += done;
    return this.progress();
  }

  /** 当前统计快照(不终止搜索) */
  progress(): MctsProgress {
    const visitCounts = this.visitCounts();
    return {
      playoutsDone: this.playoutsTotal,
      rootValue: this.rootValue(),
      bestMove: this.pickMove(visitCounts),
    };
  }

  /** 汇总最终结果 */
  result(): MctsSearchResult {
    const visitCounts = this.visitCounts();
    return {
      visitCounts,
      rootValue: this.rootValue(),
      bestMove: this.pickMove(visitCounts),
      playoutsDone: this.playoutsTotal,
    };
  }

  /** 每个着法(0..360 落点,361=虚着)的访问次数 */
  private visitCounts(): Float32Array {
    const visitCounts = new Float32Array(PASS + 1);
    for (const child of this.root.children?.values() ?? []) {
      visitCounts[child.pos] = child.visits;
    }
    return visitCounts;
  }

  /** 根局面行棋方视角的当前价值(无访问时回退根评估) */
  private rootValue(): number {
    return this.root.visits > 0 ? this.root.winSum / this.root.visits : this.rootEvalWinProb;
  }

  /** 沿树下降到叶子(未扩展或终局节点) */
  private select(root: MctsNode): MctsNode {
    let node = root;
    while (node.children !== null && node.children.size > 0) {
      node = this.selectChild(node);
    }
    return node;
  }

  /** 惰性重建节点棋盘与哈希(沿父链克隆落子) */
  private ensureState(node: MctsNode): void {
    if (node.board !== undefined) return;
    const parent = node.parent!;
    this.ensureState(parent);
    const board = parent.board!.clone();
    if (node.pos === PASS) {
      node.hash = parent.hash;
    } else {
      board.play(node.stone, node.pos);
      node.hash = Zobrist.fromBoard(board).value;
    }
    node.board = board;
    node.koHash = parent.hash!;
  }

  /** PUCT 选择最优子节点 */
  private selectChild(node: MctsNode): MctsNode {
    const sqrtN = Math.sqrt(node.visits + 1);
    const cpuct = this.config.cpuct;
    let best: MctsNode | null = null;
    let bestScore = -Infinity;
    for (const child of node.children!.values()) {
      const q = child.visits > 0 ? child.winSum / child.visits : 0;
      // 虚拟损失:评估中的节点视为多访问一次且无收益
      const n = child.visits + (child.isExpanding ? 1 : 0);
      const score = q + (cpuct * child.prior * sqrtN) / (1 + n);
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best!;
  }

  /** 为叶子节点建立子节点(合法落点 + 虚着),prior 在合法集上归一化 */
  private buildChildren(leaf: MctsNode, evalResult: NetEval, addNoise: boolean): Map<number, MctsNode> {
    const board = leaf.board!;
    const stone = leaf.stone;
    const legalMoves: number[] = [];
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      if (board.get(i) !== EMPTY) continue;
      if (checkLegality(board, stone, i, leaf.koHash) === 'ok') legalMoves.push(i);
    }

    // 虚着若导致终局(上一手已是虚着)则标记终局价值
    const passEndsGame = leaf.lastMoves.length > 0 && leaf.lastMoves[leaf.lastMoves.length - 1]!.pos === null;

    // 合法集(含虚着)上重归一化 policy
    const logits: number[] = legalMoves.map((m) => evalResult.policyLogits[m]!);
    logits.push(evalResult.passLogit);
    const maxL = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - maxL));
    const sum = exps.reduce((a, e) => a + e, 0);

    const children = new Map<number, MctsNode>();
    for (let i = 0; i < legalMoves.length; i++) {
      children.set(legalMoves[i]!, this.makeChild(leaf, legalMoves[i]!, exps[i]! / sum));
    }
    const passNode = this.makeChild(leaf, PASS, exps[exps.length - 1]! / sum);
    if (passEndsGame) {
      // 终局价值从虚着后的应手方(对手)视角计算
      passNode.terminalValue = this.terminalScoreValue(leaf.board!, passNode.stone);
    }
    children.set(PASS, passNode);

    // 根节点 Dirichlet 噪声
    if (addNoise && this.config.dirichletWeight > 0) {
      const n = children.size;
      const alpha = this.config.dirichletAlpha > 0 ? this.config.dirichletAlpha : (0.03 * 361) / n;
      const samples: number[] = [];
      let gammaSum = 0;
      for (let i = 0; i < n; i++) {
        const g = gammaSample(alpha);
        samples.push(g);
        gammaSum += g;
      }
      let idx = 0;
      for (const child of children.values()) {
        const noise = this.config.dirichletWeight * (samples[idx]! / gammaSum);
        child.prior = (1 - this.config.dirichletWeight) * child.prior + noise;
        idx++;
      }
    }
    return children;
  }

  private makeChild(parent: MctsNode, pos: number, prior: number): MctsNode {
    return {
      parent,
      pos,
      stone: opponent(parent.stone),
      depth: parent.depth + 1,
      visits: 0,
      winSum: 0,
      prior,
      children: null,
      isExpanding: false,
      koHash: parent.hash!,
      lastMoves: [...parent.lastMoves.slice(-4), { stone: parent.stone, pos: pos === PASS ? null : pos }],
    };
  }

  /** 回传:value 从 node 行棋方视角,沿树交替取反 */
  private backup(node: MctsNode, value: number): void {
    let cur: MctsNode | null = node;
    let v = value;
    while (cur !== null) {
      cur.visits += 1;
      cur.winSum += v;
      v = 1 - v;
      cur = cur.parent;
    }
  }

  /** 中国规则数子终局:从指定行棋方视角的胜负(胜 1 负 0) */
  private terminalScoreValue(board: Board, stone: Stone): number {
    const result = scoreGame(board, [], KOMI_AREA);
    return result.winner === stone ? 1 : 0;
  }

  /** 温度采样最佳着法 */
  private pickMove(visitCounts: Float32Array): number {
    const temp = this.config.temperature;
    if (temp <= 0) {
      let best = PASS;
      let bestV = -1;
      for (let i = 0; i <= PASS; i++) {
        if (visitCounts[i]! > bestV) {
          bestV = visitCounts[i]!;
          best = i;
        }
      }
      return best;
    }
    const probs = new Float64Array(PASS + 1);
    let sum = 0;
    for (let i = 0; i <= PASS; i++) {
      const c = visitCounts[i]!;
      if (c <= 0) continue;
      const p = Math.pow(c, 1 / temp);
      probs[i] = p;
      sum += p;
    }
    if (sum <= 0) return PASS;
    let r = Math.random() * sum;
    for (let i = 0; i <= PASS; i++) {
      const p = probs[i]!;
      if (p <= 0) continue;
      r -= p;
      if (r <= 0) return i;
    }
    return PASS;
  }
}
