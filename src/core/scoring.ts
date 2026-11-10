import { BLACK, Board, BOARD_SIZE, EMPTY, Stone, WHITE } from './board';

/** 中国规则贴子(数子法);取 KataGo 合法的半整数,使最终结算与 AI 评估严格一致 */
export const KOMI_AREA = 3.5;
/** 日本规则贴目(数目法,备用) */
export const KOMI_TERRITORY = 7.5;

export interface ScoreResult {
  blackStones: number;
  whiteStones: number;
  /** 黑方围出的空 */
  blackTerritory: number;
  /** 白方围出的空 */
  whiteTerritory: number;
  /** 双方交界的中立空 */
  neutral: number;
  /** 黑得分(子 + 空) */
  blackScore: number;
  /** 白得分(子 + 空 + 贴子) */
  whiteScore: number;
  /** 黑得分 - 白得分,正数为黑胜 */
  margin: number;
  winner: Stone;
}

/** 空域归属:按点索引给出黑空 / 白空 / 中立(用于盘面标记,与结算同源) */
export interface TerritoryMap {
  black: number[];
  white: number[];
  neutral: number[];
}

/** 移除死子后的盘面(不改动原盘) */
function clearedBoard(board: Board, deadStones: readonly number[]): Board {
  const b = board.clone();
  for (const i of deadStones) {
    b.clear(i);
  }
  return b;
}

/** 空点染色:仅邻黑为黑空,仅邻白为白空,混合为中立 */
function classifyTerritory(b: Board): TerritoryMap {
  const map: TerritoryMap = { black: [], white: [], neutral: [] };
  const seen = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    if (b.get(i) !== EMPTY || seen[i]) continue;
    // BFS 收集区域与邻接色
    const region: number[] = [];
    const stack = [i];
    seen[i] = 1;
    let touchesBlack = false;
    let touchesWhite = false;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      region.push(cur);
      const col = cur % BOARD_SIZE;
      const row = Math.floor(cur / BOARD_SIZE);
      const neighbors = [
        col > 0 ? cur - 1 : -1,
        col < BOARD_SIZE - 1 ? cur + 1 : -1,
        row > 0 ? cur - BOARD_SIZE : -1,
        row < BOARD_SIZE - 1 ? cur + BOARD_SIZE : -1,
      ];
      for (const nb of neighbors) {
        if (nb < 0) continue;
        const v = b.get(nb);
        if (v === BLACK) touchesBlack = true;
        else if (v === WHITE) touchesWhite = true;
        else if (!seen[nb]) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    if (touchesBlack && !touchesWhite) map.black.push(...region);
    else if (!touchesBlack && touchesWhite) map.white.push(...region);
    else map.neutral.push(...region);
  }
  return map;
}

/** 盘面上的空域归属(点索引),供点目时标记黑白围空;与 scoreGame 同源 */
export function territoryMap(board: Board, deadStones: readonly number[] = []): TerritoryMap {
  return classifyTerritory(clearedBoard(board, deadStones));
}

/**
 * 中国规则数子结算:
 * 1. 移除标记的死子
 * 2. 统计双方棋子数
 * 3. 空点染色:仅邻黑为黑空,仅邻白为白空,混合为中立
 * 4. 黑 = 子 + 黑空;白 = 子 + 白空 + 贴子
 */
export function scoreGame(
  board: Board,
  deadStones: readonly number[] = [],
  komi: number = KOMI_AREA,
): ScoreResult {
  const b = clearedBoard(board, deadStones);

  let blackStones = 0;
  let whiteStones = 0;
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    const v = b.get(i);
    if (v === BLACK) blackStones++;
    else if (v === WHITE) whiteStones++;
  }

  // 空域染色(与盘面标记共用同一实现,保证数字与标记一致)
  const territory = classifyTerritory(b);
  const blackTerritory = territory.black.length;
  const whiteTerritory = territory.white.length;
  const neutral = territory.neutral.length;

  const blackScore = blackStones + blackTerritory;
  const whiteScore = whiteStones + whiteTerritory + komi;
  const margin = blackScore - whiteScore;
  return {
    blackStones,
    whiteStones,
    blackTerritory,
    whiteTerritory,
    neutral,
    blackScore,
    whiteScore,
    margin,
    winner: margin >= 0 ? BLACK : WHITE,
  };
}
