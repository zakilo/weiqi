/**
 * KataGo analysis 协议的查询构造与响应解析(纯函数,可在 Node 单测)。
 *  - buildAnalysisQuery:把内部请求转为 analysis 查询(不含 id,id 由进程分配)。
 *  - parseAnalysis:把响应解析为内部候选结构(按访问次数降序)。
 *  - pickMoveByTemperature:按访问次数做温度采样选点。
 *  - pickMoveByPolicy / parseHumanThink:humanSL 官方配方的策略采样选点。
 */
import type {
  AiMoveRequest,
  AnalyzeSnapshot,
  CandidateWire,
  ThinkResult,
} from '../../src/engine/remote/protocol.ts';
import { BOARD_AREA, BOARD_SIZE, PASS, kataGoToPos, posToKataGo } from './coords.ts';

/** KataGo analysis 查询(不含 id) */
export interface AnalysisQuery {
  moves: [string, string][];
  rules: string;
  komi: number;
  boardXSize: number;
  boardYSize: number;
  maxVisits?: number;
  reportDuringSearchEvery?: number;
  /** 返回神经网络原始策略(policy/humanPolicy,humanSL 采样必需) */
  includePolicy?: boolean;
  /** 覆盖单条查询的配置(如 humanSLProfile / ignorePreRootHistory) */
  overrideSettings?: Record<string, unknown>;
}

/** KataGo 响应中的单个候选 */
interface KataMoveInfo {
  move: string;
  visits?: number;
  winrate?: number;
  scoreLead?: number;
  prior?: number;
  pv?: string[];
  order?: number;
}

/** KataGo analysis 响应(仅取所需字段) */
export interface AnalysisResponse {
  id?: string | number;
  isDuringSearch?: boolean;
  turnNumber?: number;
  /** KataGo 拒绝查询时返回的错误信息(如 komi 非法) */
  error?: string;
  moveInfos?: KataMoveInfo[];
  rootInfo?: {
    winrate?: number;
    scoreLead?: number;
    visits?: number;
  };
  /** includePolicy 时的根级策略:下标即棋盘索引(末位为虚着),-1 表示非法 */
  policy?: number[];
  /** humanSLProfile 下的根级人类策略(格式同 policy) */
  humanPolicy?: number[];
}

export interface BuildQueryOptions {
  maxVisits?: number;
  reportDuringSearchEvery?: number;
  includePolicy?: boolean;
  overrideSettings?: Record<string, unknown>;
}

/**
 * KataGo 仅接受整数或半整数 komi(范围 [-400,400]),否则拒绝查询。
 * 本项目内部贴子已取合法半整数(KOMI_AREA = 3.5),正常透传即可;
 * 此函数作为兜底,防御外部请求传入非法 komi(如 3.75)时就近取半并夹到合法区间。
 */
export function sanitizeKomi(komi: number): number {
  if (!Number.isFinite(komi)) return 0;
  const stepped = Math.round(komi * 2) / 2;
  return Math.max(-400, Math.min(400, stepped));
}

/** 构造一条 analysis 查询(不含 id) */
export function buildAnalysisQuery(
  request: AiMoveRequest,
  options: BuildQueryOptions = {},
): AnalysisQuery {
  const moves: [string, string][] = request.moves.map((m) => [m.stone, posToKataGo(m.pos ?? PASS)]);
  const query: AnalysisQuery = {
    moves,
    rules: request.rules,
    komi: sanitizeKomi(request.komi),
    boardXSize: BOARD_SIZE,
    boardYSize: BOARD_SIZE,
  };
  if (typeof options.maxVisits === 'number' && options.maxVisits > 0) {
    query.maxVisits = Math.floor(options.maxVisits);
  }
  if (typeof options.reportDuringSearchEvery === 'number' && options.reportDuringSearchEvery > 0) {
    query.reportDuringSearchEvery = Math.floor(options.reportDuringSearchEvery);
  }
  if (options.includePolicy) query.includePolicy = true;
  if (options.overrideSettings) query.overrideSettings = options.overrideSettings;
  return query;
}

function toPv(pv: string[] | undefined): number[] {
  if (!Array.isArray(pv)) return [];
  const out: number[] = [];
  for (const s of pv) {
    const pos = kataGoToPos(s);
    if (pos === null) continue;
    out.push(pos);
  }
  return out;
}

export interface ParsedAnalysis {
  candidates: CandidateWire[];
  rootWinrate: number;
  rootScoreLead: number;
  /** 根节点已完成的访问次数 */
  visits: number;
  /** 当前最佳着法(0..360 或 PASS) */
  bestMove: number;
}

/** 解析响应为内部候选结构(按访问次数降序,非法着法被忽略) */
export function parseAnalysis(response: AnalysisResponse): ParsedAnalysis {
  const candidates: CandidateWire[] = [];
  for (const info of response.moveInfos ?? []) {
    const pos = kataGoToPos(info.move);
    if (pos === null) continue;
    candidates.push({
      pos,
      visits: Number.isFinite(info.visits) ? (info.visits as number) : 0,
      winRate: Number.isFinite(info.winrate) ? (info.winrate as number) : 0,
      scoreLead: Number.isFinite(info.scoreLead) ? (info.scoreLead as number) : 0,
      prior: Number.isFinite(info.prior) ? (info.prior as number) : 0,
      pv: toPv(info.pv),
    });
  }
  candidates.sort((a, b) => b.visits - a.visits);

  const rootInfo = response.rootInfo ?? {};
  const visits = Number.isFinite(rootInfo.visits)
    ? (rootInfo.visits as number)
    : candidates.reduce((sum, c) => sum + c.visits, 0);

  return {
    candidates,
    rootWinrate: Number.isFinite(rootInfo.winrate) ? (rootInfo.winrate as number) : 0,
    rootScoreLead: Number.isFinite(rootInfo.scoreLead) ? (rootInfo.scoreLead as number) : 0,
    visits,
    bestMove: candidates.length > 0 ? candidates[0]!.pos : PASS,
  };
}

/**
 * 按访问次数温度采样选点:权重 = visits^(1/T)。
 * T <= 0 时退化为取访问次数最多者(最优)。
 */
export function pickMoveByTemperature(
  candidates: readonly CandidateWire[],
  temperature: number,
  rng: () => number = Math.random,
): number {
  if (candidates.length === 0) return PASS;
  if (!(temperature > 0)) return candidates[0]!.pos;

  const invT = 1 / temperature;
  const weights = candidates.map((c) => Math.pow(Math.max(c.visits, 0), invT));
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 0)) return candidates[0]!.pos;

  let r = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return candidates[i]!.pos;
  }
  return candidates[candidates.length - 1]!.pos;
}

/** 解析 think 结果并在候选上做温度采样选点 */
export function parseThink(
  response: AnalysisResponse,
  temperature = 0,
  rng: () => number = Math.random,
): ThinkResult {
  const parsed = parseAnalysis(response);
  const move = pickMoveByTemperature(parsed.candidates, temperature, rng);
  const chosen = parsed.candidates.find((c) => c.pos === move);
  return {
    move,
    winRate: chosen ? chosen.winRate : parsed.rootWinrate,
    scoreLead: chosen ? chosen.scoreLead : parsed.rootScoreLead,
    visits: parsed.visits,
  };
}

/**
 * 从根级策略数组按比例采样着法(humanSL 官方配方)。
 * 下标即棋盘索引,末位为虚着位(不参与采样,虚着与否由搜索最佳着法决定);
 * -1 表示非法点,<=0 不参与。无有效权重返回 null。
 */
export function pickMoveByPolicy(
  policy: readonly number[] | undefined,
  rng: () => number = Math.random,
): number | null {
  if (!Array.isArray(policy) || policy.length === 0) return null;
  const area = Math.min(policy.length - 1, BOARD_AREA);
  let total = 0;
  for (let i = 0; i < area; i++) {
    const w = policy[i]!;
    if (w > 0) total += w;
  }
  if (!(total > 0)) return null;
  let r = rng() * total;
  let last: number | null = null;
  for (let i = 0; i < area; i++) {
    const w = policy[i]!;
    if (w <= 0) continue;
    last = i;
    r -= w;
    if (r <= 0) return i;
  }
  return last;
}

/** moveInfos 中 order 最小的着法(搜索认定最佳);无有效项返回 null */
function orderZeroMove(response: AnalysisResponse): number | null {
  let bestOrder = Number.POSITIVE_INFINITY;
  let best: number | null = null;
  for (const info of response.moveInfos ?? []) {
    const pos = kataGoToPos(info.move);
    if (pos === null) continue;
    const order = Number.isFinite(info.order) ? (info.order as number) : Number.POSITIVE_INFINITY;
    if (order < bestOrder) {
      bestOrder = order;
      best = pos;
    }
  }
  return best;
}

/**
 * 解析 humanSL 思考结果(官方配方):
 *  - 搜索最佳着法(order=0)为虚着 → 虚着;
 *  - 否则在 humanPolicy 上按比例采样(策略缺失时回退搜索最佳)。
 */
export function parseHumanThink(
  response: AnalysisResponse,
  rng: () => number = Math.random,
): ThinkResult {
  const parsed = parseAnalysis(response);
  const searchBest = orderZeroMove(response) ?? parsed.bestMove;
  const move =
    searchBest === PASS ? PASS : (pickMoveByPolicy(response.humanPolicy, rng) ?? searchBest);
  const chosen = parsed.candidates.find((c) => c.pos === move);
  return {
    move,
    winRate: chosen ? chosen.winRate : parsed.rootWinrate,
    scoreLead: chosen ? chosen.scoreLead : parsed.rootScoreLead,
    visits: parsed.visits,
  };
}

/** 解析响应为分析快照(analyze 流的每行) */
export function toSnapshot(response: AnalysisResponse): AnalyzeSnapshot {
  const parsed = parseAnalysis(response);
  return {
    playouts: parsed.visits,
    rootValue: parsed.rootWinrate,
    bestMove: parsed.bestMove,
    candidates: parsed.candidates,
  };
}
