/**
 * RemoteAiPlayer:同 AiPlayer 的对外形状(isReady / backendLabel / thinking / think),
 * 但思考走远端服务。难度档位对应 KataGo Human-SL 档位(profile,20级~业余1段):
 * 服务端加载 human 模型时按人类策略采样;模型缺失时回退 maxVisits / maxTemperature。
 */
import { BLACK, colOf, PASS, rowOf } from '../../core/board';
import { KOMI_AREA } from '../../core/scoring';
import type { Game } from '../../store/game';
import type { ServiceClient } from './service-client';

export interface RemoteAiLevel {
  id: string;
  label: string;
  /** KataGo Human-SL 档位(rank_20k..rank_1d),服务端加载 human 模型时生效 */
  profile: string;
  /** 回退搜索访问次数上限(human 模型缺失时使用) */
  maxVisits: number;
  /** 回退根着法采样温度:0 取最优,越大越随机 */
  maxTemperature: number;
}

/** 难度档位:20级~业余1段 共 21 档,与 Human-SL profile 一一对应 */
export const REMOTE_AI_LEVELS: RemoteAiLevel[] = [
  { id: '20k', label: '20级', profile: 'rank_20k', maxVisits: 20, maxTemperature: 1 },
  { id: '19k', label: '19级', profile: 'rank_19k', maxVisits: 23, maxTemperature: 0.96 },
  { id: '18k', label: '18级', profile: 'rank_18k', maxVisits: 28, maxTemperature: 0.92 },
  { id: '17k', label: '17级', profile: 'rank_17k', maxVisits: 32, maxTemperature: 0.88 },
  { id: '16k', label: '16级', profile: 'rank_16k', maxVisits: 38, maxTemperature: 0.84 },
  { id: '15k', label: '15级', profile: 'rank_15k', maxVisits: 45, maxTemperature: 0.8 },
  { id: '14k', label: '14级', profile: 'rank_14k', maxVisits: 53, maxTemperature: 0.76 },
  { id: '13k', label: '13级', profile: 'rank_13k', maxVisits: 62, maxTemperature: 0.72 },
  { id: '12k', label: '12级', profile: 'rank_12k', maxVisits: 72, maxTemperature: 0.68 },
  { id: '11k', label: '11级', profile: 'rank_11k', maxVisits: 85, maxTemperature: 0.64 },
  { id: '10k', label: '10级', profile: 'rank_10k', maxVisits: 100, maxTemperature: 0.6 },
  { id: '9k', label: '9级', profile: 'rank_9k', maxVisits: 117, maxTemperature: 0.56 },
  { id: '8k', label: '8级', profile: 'rank_8k', maxVisits: 138, maxTemperature: 0.52 },
  { id: '7k', label: '7级', profile: 'rank_7k', maxVisits: 162, maxTemperature: 0.48 },
  { id: '6k', label: '6级', profile: 'rank_6k', maxVisits: 190, maxTemperature: 0.44 },
  { id: '5k', label: '5级', profile: 'rank_5k', maxVisits: 224, maxTemperature: 0.4 },
  { id: '4k', label: '4级', profile: 'rank_4k', maxVisits: 263, maxTemperature: 0.36 },
  { id: '3k', label: '3级', profile: 'rank_3k', maxVisits: 308, maxTemperature: 0.32 },
  { id: '2k', label: '2级', profile: 'rank_2k', maxVisits: 362, maxTemperature: 0.28 },
  { id: '1k', label: '1级', profile: 'rank_1k', maxVisits: 426, maxTemperature: 0.24 },
  { id: '1d', label: '业余1段', profile: 'rank_1d', maxVisits: 500, maxTemperature: 0.2 },
];

/** 默认档位:UI 初始选中,也是未知 id 的回退目标 */
export const REMOTE_AI_DEFAULT_LEVEL_ID = '5k';

export function remoteLevelOf(id: string): RemoteAiLevel {
  return (
    REMOTE_AI_LEVELS.find((l) => l.id === id) ??
    REMOTE_AI_LEVELS.find((l) => l.id === REMOTE_AI_DEFAULT_LEVEL_ID)!
  );
}

export type AiMove = { kind: 'play'; col: number; row: number } | { kind: 'pass' };

export class RemoteAiPlayer {
  private ready = false;

  /** 是否正在思考 */
  thinking = false;

  constructor(private readonly client: ServiceClient) {}

  get isReady(): boolean {
    return this.ready;
  }

  get backendLabel(): string {
    return '远端服务';
  }

  /** 主动探测服务可用性并更新就绪状态 */
  async refresh(): Promise<boolean> {
    try {
      const health = await this.client.health();
      this.ready = health.ok;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  setReady(ready: boolean): void {
    this.ready = ready;
  }

  /**
   * 为当前局面思考一步(远端)。调用方需保证对局未终局。
   * @param level 难度档位(humanSL profile;服务端无 human 模型时回退 visits/温度)
   */
  async think(game: Game, level: RemoteAiLevel): Promise<AiMove> {
    const moves = game.getMoves().map((m) => ({
      stone: m.stone === BLACK ? ('B' as const) : ('W' as const),
      pos: m.kind === 'play' ? m.pos : null,
    }));

    this.thinking = true;
    try {
      const result = await this.client.think({
        moves,
        komi: KOMI_AREA,
        rules: 'chinese',
        humanSLProfile: level.profile,
        maxVisits: level.maxVisits,
        maxTemperature: level.maxTemperature,
      });
      if (result.move === PASS) return { kind: 'pass' };
      return { kind: 'play', col: colOf(result.move), row: rowOf(result.move) };
    } finally {
      this.thinking = false;
    }
  }
}

