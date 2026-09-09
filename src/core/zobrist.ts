import { Board, BOARD_SIZE, CellValue } from './board';

/** 每格点 3 种状态(空/黑/白)的 64 位随机数表;空状态为零值,黑/白为随机数 */
const TABLE: bigint[] = (() => {
  let seed = 0x9e3779b97f4a7c15n;
  const rand = (): bigint => {
    seed ^= seed << 7n;
    seed ^= seed >> 9n;
    seed ^= seed << 8n;
    return BigInt.asUintN(64, seed);
  };
  const table: bigint[] = [];
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    table.push(0n); // EMPTY
    table.push(rand()); // BLACK
    table.push(rand()); // WHITE
  }
  return table;
})();

const indexOf = (i: number, value: CellValue): number => i * 3 + value;

/** Zobrist 局面哈希:支持增量更新,用于打劫检测与分析缓存 */
export class Zobrist {
  private hash = 0n;

  /** 全盘扫描构建 */
  static fromBoard(board: Board): Zobrist {
    const z = new Zobrist();
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
      const value = board.get(i);
      if (value !== 0) z.hash ^= TABLE[indexOf(i, value)];
    }
    return z;
  }

  get value(): bigint {
    return this.hash;
  }

  /** 将 i 点的值由 from 变为 to(XOR 语义) */
  update(i: number, from: CellValue, to: CellValue): void {
    if (from === to) return;
    this.hash ^= TABLE[indexOf(i, from)] ^ TABLE[indexOf(i, to)];
  }
}
