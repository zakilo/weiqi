import { describe, expect, it } from 'vitest';
import { boardMetrics } from '../src/ui/board-renderer';

const VIEWS = [240, 320, 375, 500, 768, 1200];

describe('棋盘布局度量', () => {
  it('网格线全部位于画布内,左右留白相等', () => {
    for (const view of VIEWS) {
      const m = boardMetrics(view);
      const last = m.padding + 18 * m.cell;
      expect(last).toBeLessThan(view);
      expect(view - last).toBeCloseTo(m.padding, 6);
    }
  });

  it('坐标文字不被画布边缘裁切', () => {
    for (const view of VIEWS) {
      const m = boardMetrics(view);
      expect(m.labelEdge - m.labelFont / 2).toBeGreaterThanOrEqual(0);
    }
  });

  it('坐标文字与收边线不重叠,收边线在最外圈网格线外侧', () => {
    for (const view of VIEWS) {
      const m = boardMetrics(view);
      const halfText = m.labelFont / 2;
      expect(m.labelEdge + halfText).toBeLessThan(m.border);
      expect(m.border).toBeLessThan(m.padding);
    }
  });

  it('收边线关于画布居中(上下左右同余量)', () => {
    for (const view of VIEWS) {
      const m = boardMetrics(view);
      const size = 18 * m.cell + 2 * (m.padding - m.border);
      expect(m.border + size).toBeCloseTo(view - m.border, 6);
    }
  });
});
