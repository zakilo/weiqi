/**
 * RemoteAiPlayer:同 AiPlayer 的对外形状(isReady / backendLabel / thinking / think),
 * 但思考走远端服务。难度档位用 maxVisits / maxTemperature 表达(playouts 语义映射)。
 * 因不加载本地模型,30级..业余5段十档只调节访问次数与温度。
 */
import { BLACK, colOf, PASS, rowOf } from '../../core/board';
import { KOMI_AREA } from '../../core/scoring';
import type { Game } from '../../store/game';
import type { ServiceClient } from './service-client';

export interface RemoteAiLevel {
  id: string;
  label: string;
  /** 搜索访问次数上限(= 难度档位 playouts) */
  maxVisits: number;
  /** 根着法采样温度:0 取最优,越大越随机 */
  maxTemperature: number;
}

/** 难度档位:访问次数越少、温度越高越弱(更随机);30级最弱,业余5段最强 */
export const REMOTE_AI_LEVELS: RemoteAiLevel[] = [
  { id: '30k', label: '30级', maxVisits: 20, maxTemperature: 1 },
  { id: '25k', label: '25级', maxVisits: 30, maxTemperature: 0.9 },
  { id: '20k', label: '20级', maxVisits: 40, maxTemperature: 0.8 },
  { id: '15k', label: '15级', maxVisits: 60, maxTemperature: 0.7 },
  { id: '10k', label: '10级', maxVisits: 85, maxTemperature: 0.6 },
  { id: '5k', label: '5级', maxVisits: 120, maxTemperature: 0.5 },
  { id: '1k', label: '1级', maxVisits: 170, maxTemperature: 0.4 },
  { id: '1d', label: '业余1段', maxVisits: 245, maxTemperature: 0.3 },
  { id: '3d', label: '业余3段', maxVisits: 350, maxTemperature: 0.25 },
  { id: '5d', label: '业余5段', maxVisits: 500, maxTemperature: 0.2 },
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
   * @param level 难度档位(maxVisits / maxTemperature)
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

