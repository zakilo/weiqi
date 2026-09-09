/**
 * AI 玩家:后端初始化 + 权重解析建网 + MCTS 思考一步。
 * 难度档位通过 MctsConfig 调节(推理次数/温度/探索系数)。
 */
import { BACKEND_LABEL, BackendKind, initBackend } from './backend';
import { KOMI_AREA } from '../core/scoring';
import { colOf, rowOf, Stone } from '../core/board';
import { EncodedMove } from './features';
import { KataGoNet } from './net';
import { MctsConfig, MctsSearch, PASS } from './mcts';
import { parseKataGoModel } from './weights';
import { Game, Move } from '../store/game';

export interface AiLevel {
  id: string;
  label: string;
  config: Partial<MctsConfig>;
}

/** 难度档位:推理次数与温度越高越弱(更随机) */
export const AI_LEVELS: AiLevel[] = [
  { id: 'easy', label: '入门', config: { playouts: 80, batchSize: 4, temperature: 1, cpuct: 1.2 } },
  { id: 'normal', label: '进阶', config: { playouts: 200, batchSize: 8, temperature: 0.6, cpuct: 1.5 } },
  { id: 'hard', label: '高手', config: { playouts: 500, batchSize: 16, temperature: 0.2, cpuct: 1.8 } },
];

export function levelOf(id: string): AiLevel {
  return AI_LEVELS.find((l) => l.id === id) ?? AI_LEVELS[1]!;
}

export type AiMove = { kind: 'play'; col: number; row: number } | { kind: 'pass' };

export class AiPlayer {
  private net: KataGoNet | null = null;
  private backend: BackendKind | null = null;

  /** 已加载的模型名(权重文件内部名) */
  modelName: string | null = null;
  /** 是否正在思考 */
  thinking = false;

  get isReady(): boolean {
    return this.net !== null;
  }

  get backendLabel(): string {
    return this.backend ? BACKEND_LABEL[this.backend] : '未初始化';
  }

  /** 初始化计算后端(webgpu → wasm → cpu 回退) */
  async initBackend(): Promise<BackendKind> {
    this.backend = await initBackend();
    return this.backend;
  }

  /** 解析权重字节并建立网络(自动初始化后端) */
  async loadModelBytes(bytes: Uint8Array): Promise<void> {
    if (this.backend === null) await this.initBackend();
    this.net?.dispose();
    const parsed = parseKataGoModel(bytes);
    this.net = new KataGoNet(parsed);
    this.modelName = parsed.modelName;
  }

  /** 释放网络权重张量 */
  dispose(): void {
    this.net?.dispose();
    this.net = null;
    this.modelName = null;
  }

  /**
   * 为当前局面思考一步。调用方需保证对局未终局且模型已就绪。
   * @param config 覆盖默认搜索配置(难度档位)
   */
  async think(game: Game, config: Partial<MctsConfig> = {}): Promise<AiMove> {
    if (!this.net) throw new Error('AI 模型未加载');
    const recentMoves = game
      .getMoves()
      .slice(-5)
      .map(moveToEncoded);

    this.thinking = true;
    try {
      const search = new MctsSearch(this.net, config);
      const result = await search.search(
        game.getBoard(),
        game.currentStone,
        recentMoves,
        KOMI_AREA,
        game.prevHashForNext,
      );
      if (result.bestMove === PASS) return { kind: 'pass' };
      return { kind: 'play', col: colOf(result.bestMove), row: rowOf(result.bestMove) };
    } finally {
      this.thinking = false;
    }
  }
}

function moveToEncoded(move: Move): EncodedMove {
  return { stone: move.stone as Stone, pos: move.kind === 'play' ? move.pos : null };
}
