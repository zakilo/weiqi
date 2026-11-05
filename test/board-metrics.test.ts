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

  it('坐标文字整体落在最外圈网格线外侧的坐标带内', () => {
    for (const view of VIEWS) {
      const m = boardMetrics(view);
      expect(m.labelEdge + m.labelFont / 2).toBeLessThan(m.padding);
    }
  });
});
