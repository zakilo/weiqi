/**
 * KataGo analysis 协议的查询构造与响应解析(纯函数,可在 Node 单测)。
 *  - buildAnalysisQuery:把内部请求转为 analysis 查询(不含 id,id 由进程分配)。
 *  - parseAnalysis:把响应解析为内部候选结构(按访问次数降序)。
 *  - pickMoveByTemperature:按访问次数做温度采样选点。
 */
import type {
  AiMoveRequest,
  AnalyzeSnapshot,
  CandidateWire,
  ThinkResult,
} from '../../src/engine/remote/protocol.ts';
import { BOARD_SIZE, PASS, kataGoToPos, posToKataGo } from './coords.ts';

/** KataGo analysis 查询(不含 id) */
export interface AnalysisQuery {
  moves: [string, string][];
  rules: string;
  komi: number;
  boardXSize: number;
  boardYSize: number;
  maxVisits?: number;
  reportDuringSearchEvery?: number;
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
  moveInfos?: KataMoveInfo[];
  rootInfo?: {
    winrate?: number;
    scoreLead?: number;
    visits?: number;
  };
}

export interface BuildQueryOptions {
  maxVisits?: number;
  reportDuringSearchEvery?: number;
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
    komi: request.komi,
    boardXSize: BOARD_SIZE,
    boardYSize: BOARD_SIZE,
  };
  if (typeof options.maxVisits === 'number' && options.maxVisits > 0) {
    query.maxVisits = Math.floor(options.maxVisits);
  }
  if (typeof options.reportDuringSearchEvery === 'number' && options.reportDuringSearchEvery > 0) {
    query.reportDuringSearchEvery = Math.floor(options.reportDuringSearchEvery);
  }
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
