import { BLACK, Board, BOARD_SIZE, EMPTY, Stone, WHITE } from './board';

/** 中国规则贴子(数子法) */
export const KOMI_AREA = 3.75;
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
  const b = board.clone();
  for (const i of deadStones) {
    b.clear(i);
  }

  let blackStones = 0;
  let whiteStones = 0;
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    const v = b.get(i);
    if (v === BLACK) blackStones++;
    else if (v === WHITE) whiteStones++;
  }

  // 空域染色
  let blackTerritory = 0;
  let whiteTerritory = 0;
  let neutral = 0;
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
    if (touchesBlack && !touchesWhite) blackTerritory += region.length;
    else if (!touchesBlack && touchesWhite) whiteTerritory += region.length;
    else neutral += region.length;
  }

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
