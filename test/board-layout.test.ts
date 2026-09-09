import { describe, expect, it } from 'vitest';
import { BOARD_SIZE, COLUMN_LABELS, STAR_POINTS } from '../src/ui/board-renderer';

describe('棋盘布局常量', () => {
  it('19 路棋盘', () => {
    expect(BOARD_SIZE).toBe(19);
  });

  it('列坐标共 19 个且跳过 I', () => {
    expect(COLUMN_LABELS).toHaveLength(19);
    expect(COLUMN_LABELS).not.toContain('I');
    expect(COLUMN_LABELS[0]).toBe('A');
    expect(COLUMN_LABELS[18]).toBe('T');
  });

  it('星位为 9 个且坐标对称', () => {
    expect(STAR_POINTS).toHaveLength(9);
    for (const [col, row] of STAR_POINTS) {
      expect(col).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(BOARD_SIZE);
      // 中心对称:每个星位都有其镜像星位
      const mirror: readonly [number, number] = [
        BOARD_SIZE - 1 - col,
        BOARD_SIZE - 1 - row,
      ];
      expect(STAR_POINTS.some(([c, r]) => c === mirror[0] && r === mirror[1])).toBe(true);
    }
  });
});
