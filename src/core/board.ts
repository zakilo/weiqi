/** 棋盘路数(本项目仅支持 19 路) */
export const BOARD_SIZE = 19;

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export type Stone = typeof BLACK | typeof WHITE;
export type CellValue = typeof EMPTY | Stone;

export const opponent = (c: Stone): Stone => (c === BLACK ? WHITE : BLACK);

/** 一维索引(行主序) */
export const idx = (col: number, row: number): number => row * BOARD_SIZE + col;
export const colOf = (i: number): number => i % BOARD_SIZE;
export const rowOf = (i: number): number => Math.floor(i / BOARD_SIZE);
export const inBounds = (col: number, row: number): boolean =>
  col >= 0 && col < BOARD_SIZE && row >= 0 && row < BOARD_SIZE;

/** 每个格点的四邻索引,构建一次复用 */
const NEIGHBORS: ReadonlyArray<readonly number[]> = (() => {
  const table: number[][] = [];
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    const col = colOf(i);
    const row = rowOf(i);
    const list: number[] = [];
    if (col > 0) list.push(i - 1);
    if (col < BOARD_SIZE - 1) list.push(i + 1);
    if (row > 0) list.push(i - BOARD_SIZE);
    if (row < BOARD_SIZE - 1) list.push(i + BOARD_SIZE);
    table.push(list);
  }
  return table;
})();

export const neighborsOf = (i: number): readonly number[] => NEIGHBORS[i];

/** 围棋棋盘:存储棋子,负责落子与提子 */
export class Board {
  private readonly cells = new Int8Array(BOARD_SIZE * BOARD_SIZE);

  get(i: number): CellValue {
    return this.cells[i] as CellValue;
  }

  /**
   * 落子并提掉因此无气的敌方块,返回被提子数。
   * 调用方需保证落点合法(空点、非自杀、非打劫)。
   */
  play(stone: Stone, i: number): number {
    this.cells[i] = stone;
    let captured = 0;
    for (const nb of neighborsOf(i)) {
      if (this.cells[nb] !== opponent(stone)) continue;
      const group = this.groupOf(nb);
      if (this.countLiberties(group) === 0) {
        captured += group.length;
        for (const p of group) this.cells[p] = EMPTY;
      }
    }
    return captured;
  }

  /** 所在连通块(含自身,顺序不保证) */
  groupOf(i: number): number[] {
    const stone = this.cells[i];
    const group: number[] = [];
    const seen = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      group.push(cur);
      for (const nb of neighborsOf(cur)) {
        if (this.cells[nb] === stone && !seen[nb]) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    return group;
  }

  /** 连通块的气数 */
  countLiberties(group: readonly number[]): number {
    const liberties = new Set<number>();
    for (const p of group) {
      for (const nb of neighborsOf(p)) {
        if (this.cells[nb] === EMPTY) liberties.add(nb);
      }
    }
    return liberties.size;
  }

  /** 深拷贝(模拟落子、悔棋、分析等场景) */
  clone(): Board {
    const copy = new Board();
    copy.cells.set(this.cells);
    return copy;
  }
}
