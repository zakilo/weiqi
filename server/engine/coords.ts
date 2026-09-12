/**
 * 棋盘索引 ↔ KataGo 文本坐标互转。
 *  - 棋盘索引:pos = row*19 + col(row 0 在上),0..360 为落点,361 表示虚着。
 *  - KataGo 文本:列字母(A..T,跳过 I)+ 行号(自下而上 1..19),虚着为 "pass"。
 */

export const BOARD_SIZE = 19;
export const BOARD_AREA = BOARD_SIZE * BOARD_SIZE;
/** 虚着索引(与 src/engine/mcts.ts 的 PASS 数值一致) */
export const PASS = BOARD_AREA;

/** 列标签(跳过字母 I),与 src/ui/board-renderer.ts 一致 */
export const COLUMN_LABELS = 'ABCDEFGHJKLMNOPQRST';

/** 棋盘索引 → KataGo 坐标;虚着 → "pass"。越界抛错 */
export function posToKataGo(pos: number): string {
  if (pos === PASS) return 'pass';
  if (!Number.isInteger(pos) || pos < 0 || pos >= BOARD_AREA) {
    throw new RangeError(`非法着法索引: ${pos}`);
  }
  const col = pos % BOARD_SIZE;
  const row = Math.floor(pos / BOARD_SIZE);
  const num = BOARD_SIZE - row;
  return `${COLUMN_LABELS[col]}${num}`;
}

/** KataGo 坐标 → 棋盘索引;无法识别返回 null(含 "pass") */
export function kataGoToPos(s: string): number | null {
  if (typeof s !== 'string') return null;
  const text = s.trim();
  if (text.length === 0) return null;
  if (text.toLowerCase() === 'pass') return PASS;
  const letter = text[0]!.toUpperCase();
  const col = COLUMN_LABELS.indexOf(letter);
  if (col < 0) return null;
  const num = Number(text.slice(1));
  if (!Number.isInteger(num) || num < 1 || num > BOARD_SIZE) return null;
  const row = BOARD_SIZE - num;
  return row * BOARD_SIZE + col;
}
