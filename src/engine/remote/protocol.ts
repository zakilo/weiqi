/**
 * 客户端 ↔ 后端 AI 服务共享协议(仅类型,不产生运行时代码)。
 * 坐标统一使用棋盘索引 pos = row*19 + col(0..360),pos = 361 表示虚着;
 * 后端独占与 KataGo 文本坐标的互转,客户端不感知 KataGo 坐标。
 */

/** 行棋方:黑 / 白 */
export type WireStone = 'B' | 'W';

/** 一手:pos 为棋盘索引,虚着为 null */
export interface WireMove {
  stone: WireStone;
  pos: number | null;
}

/** 一次对弈/分析请求的公共部分 */
export interface AiMoveRequest {
  /** 从空盘起的完整手顺 */
  moves: WireMove[];
  komi: number;
  rules: 'chinese';
  /** 目标模型 id;缺省用当前激活模型 */
  model?: string;
}

/** 让 AI 思考一步 */
export interface ThinkRequest extends AiMoveRequest {
  /** 搜索访问次数上限(= 难度档位 playouts;humanSL 模式下由服务端固定) */
  maxVisits?: number;
  /** 根着法采样温度:0 取最优,越大越随机;humanSL 模式下不使用 */
  maxTemperature?: number;
  /** Human-SL 人类风格档位(如 "rank_5k");服务端加载 human 模型时按人类策略采样 */
  humanSLProfile?: string;
}

/** 持续分析一个局面 */
export interface AnalyzeRequest extends AiMoveRequest {
  /** 搜索访问次数上限 */
  maxVisits?: number;
  /** 返回每点归属 ownership(正=黑、负=白),用于自动判定死子 */
  includeOwnership?: boolean;
}

/** 候选着法(取自 KataGo moveInfos) */
export interface CandidateWire {
  /** 着法索引(0..360 落点,361=虚着) */
  pos: number;
  visits: number;
  /** 落此着后的胜率(行棋方视角) */
  winRate: number;
  /** 落此着后的目差(行棋方视角) */
  scoreLead: number;
  /** 先验概率 */
  prior: number;
  /** 主要变化线(棋盘索引) */
  pv: number[];
}

/** 一次分析快照(analyze 流的每行) */
export interface AnalyzeSnapshot {
  /** 已完成访问次数 */
  playouts: number;
  /** 行棋方视角根胜率 */
  rootValue: number;
  /** 行棋方视角根目差(与 rootValue 同视角,单位:子) */
  rootScoreLead: number;
  /** 当前最佳着法 */
  bestMove: number;
  candidates: CandidateWire[];
  /** 每点归属(正=黑、负=白,范围 [-1,1]);includeOwnership 时存在,用于自动判定死子 */
  ownership?: number[];
}

/** think 结果 */
export interface ThinkResult {
  move: number;
  winRate: number;
  scoreLead: number;
  visits: number;
}

/** 引擎实例运行状态 */
export type EngineState = 'starting' | 'ready' | 'busy' | 'error' | 'stopped';

/** 单个模型引擎的运行状态 */
export interface EngineStatus {
  modelId: string;
  modelName: string;
  state: EngineState;
  pid: number | null;
  inFlight: number;
  queued: number;
  rejected: number;
  totalRequests: number;
  startedAt: number | null;
  lastError: string | null;
}

/** 模型清单项 */
export interface ModelInfo {
  id: string;
  name: string;
  /** 模型文件绝对路径 */
  path: string;
  /** 文件大小(字节),未知为 null */
  sizeBytes: number | null;
}

export interface ModelsResponse {
  models: ModelInfo[];
  active: string | null;
}

export interface HealthResponse {
  ok: boolean;
  katagoPath: string;
  katagoVersion: string | null;
  activeModel: string | null;
}

/** 全局队列统计 */
export interface QueueStatus {
  active: number;
  queued: number;
  rejected: number;
}

/** 服务整体状态 */
export interface ServiceStatus {
  engines: EngineStatus[];
  active: string | null;
  queue: QueueStatus;
  config: {
    katagoPath: string;
    modelDir: string;
    /** Human-SL 人类风格模型绝对路径(null 表示未配置) */
    humanModelPath: string | null;
    /** Human-SL 模型文件是否存在 */
    humanModelExists: boolean;
  };
}

/** 加载/卸载/切换模型的响应 */
export interface ModelActionResponse {
  ok: boolean;
  active?: string | null;
  engine?: EngineStatus;
}
