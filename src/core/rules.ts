import { Board, EMPTY, Stone } from './board';
import { Zobrist } from './zobrist';

/** 无前序局面(首手) */
export const NO_PREV_HASH = -1n;

export type Legality = 'ok' | 'occupied' | 'suicide' | 'ko';

/**
 * 落子合法性检查(中国规则):
 * 1. 落点必须为空(occupied)
 * 2. 非自杀(落子后己方块无气,且未提对方)(suicide)
 * 3. 非简单打劫(落子后局面不得与上一手落子前的局面相同)(ko)
 *
 * prevHash 为上一手落子**前**的局面的 Zobrist 哈希(即当前局面的前一局面);
 * 首手传 NO_PREV_HASH。
 */
export function checkLegality(
  board: Board,
  stone: Stone,
  i: number,
  prevHash: bigint = NO_PREV_HASH,
): Legality {
  if (board.get(i) !== EMPTY) return 'occupied';

  // 模拟落子后检查
  const copy = board.clone();
  copy.play(stone, i);

  // 自杀:落子后自身块无气(play 已提对方,若提子则必有气)
  if (copy.countLiberties(copy.groupOf(i)) === 0) return 'suicide';

  // 简单劫:局面与上一手落子前的局面相同则禁止(立即回提)
  if (prevHash !== NO_PREV_HASH && Zobrist.fromBoard(copy).value === prevHash) {
    return 'ko';
  }
  return 'ok';
}

/** 是否合法(布尔便捷版) */
export function isLegal(
  board: Board,
  stone: Stone,
  i: number,
  prevHash: bigint = NO_PREV_HASH,
): boolean {
  return checkLegality(board, stone, i, prevHash) === 'ok';
}
