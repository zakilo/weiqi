import { describe, expect, it } from 'vitest';
import { Board, BLACK, WHITE, idx } from '../src/core/board';
import { encodeFeatures, INPUT_SPATIAL_CHANNELS, EncodedMove } from '../src/engine/features';

const at = (spatial: Float32Array, pos: number, channel: number): number =>
  spatial[pos * INPUT_SPATIAL_CHANNELS + channel];

describe('encodeFeatures', () => {
  it('空棋盘:通道 0 全 1,棋子/气平面全 0,komi 通道正确', () => {
    const board = new Board();
    const { spatial, global } = encodeFeatures(board, BLACK, []);
    for (let i = 0; i < 361; i++) {
      expect(at(spatial, i, 0)).toBe(1);
      expect(at(spatial, i, 1)).toBe(0);
      expect(at(spatial, i, 2)).toBe(0);
      expect(at(spatial, i, 3)).toBe(0);
    }
    // 黑方视角 selfKomi = -7.5
    expect(global[5]).toBeCloseTo(-7.5 / 20);
  });

  it('通道 1/2 标记双方棋子', () => {
    const board = new Board();
    board.play(BLACK, idx(3, 3));
    board.play(WHITE, idx(15, 15));
    const { spatial } = encodeFeatures(board, BLACK, []);
    expect(at(spatial, idx(3, 3), 1)).toBe(1); // 当前方(黑)
    expect(at(spatial, idx(3, 3), 2)).toBe(0);
    expect(at(spatial, idx(15, 15), 2)).toBe(1); // 对方(白)
    expect(at(spatial, idx(15, 15), 1)).toBe(0);
    expect(at(spatial, idx(9, 9), 1)).toBe(0);
  });

  it('气数平面:1/2/3 气连通块', () => {
    const board = new Board();
    // 黑组 {(0,0),(0,1)} 被白 (1,0),(0,2) 挤压到 1 气
    board.play(BLACK, idx(0, 0));
    board.play(WHITE, idx(1, 0));
    board.play(BLACK, idx(0, 1));
    board.play(WHITE, idx(0, 2));
    const { spatial } = encodeFeatures(board, WHITE, []);
    expect(at(spatial, idx(0, 0), 3)).toBe(1);
    expect(at(spatial, idx(0, 1), 3)).toBe(1);
    // 白 (1,0) 单子 2 气,应出现在通道 4 而非 3/5
    expect(at(spatial, idx(1, 0), 4)).toBe(1);
    expect(at(spatial, idx(1, 0), 3)).toBe(0);
    expect(at(spatial, idx(1, 0), 5)).toBe(0);
  });

  it('历史通道 9-13:最近 5 手落点与交替截断', () => {
    const board = new Board();
    board.play(BLACK, idx(3, 3));
    board.play(WHITE, idx(15, 15));
    board.play(BLACK, idx(10, 10));
    // 当前方白:历史应交替为 [黑,白,黑]
    const moves: EncodedMove[] = [
      { stone: BLACK, pos: idx(3, 3) },
      { stone: WHITE, pos: idx(15, 15) },
      { stone: BLACK, pos: idx(10, 10) },
    ];
    const { spatial } = encodeFeatures(board, WHITE, moves);
    // 最近一手(黑 10,10)在通道 9
    expect(at(spatial, idx(10, 10), 9)).toBe(1);
    expect(at(spatial, idx(15, 15), 10)).toBe(1);
    expect(at(spatial, idx(3, 3), 11)).toBe(1);
    expect(at(spatial, idx(9, 9), 9)).toBe(0);
  });

  it('交替不符即截断历史', () => {
    const board = new Board();
    board.play(BLACK, idx(3, 3));
    board.play(BLACK, idx(15, 15)); // 连续两手黑,交替被打断
    const moves: EncodedMove[] = [
      { stone: BLACK, pos: idx(3, 3) },
      { stone: BLACK, pos: idx(15, 15) },
    ];
    // 当前方白:期待最近一手是黑,但再往前应是白,实际是黑 → 只取 1 手
    const { spatial } = encodeFeatures(board, WHITE, moves);
    expect(at(spatial, idx(15, 15), 9)).toBe(1);
    expect(at(spatial, idx(3, 3), 10)).toBe(0);
  });

  it('虚着历史:global 0-4 与 pass 终局标记 global 14', () => {
    const board = new Board();
    board.play(BLACK, idx(3, 3));
    board.play(WHITE, idx(15, 15));
    // 当前方黑,上一手白虚着
    const moves: EncodedMove[] = [
      { stone: BLACK, pos: idx(3, 3) },
      { stone: WHITE, pos: null },
    ];
    const { global, spatial } = encodeFeatures(board, BLACK, moves);
    expect(global[0]).toBe(1); // 最近一手是 pass
    expect(global[14]).toBe(1); // 再 pass 则终局
    expect(at(spatial, idx(3, 3), 10)).toBe(1); // 次近一手仍正常记录
  });

  it('komi parity wave(19 路奇数,贴 7.5)', () => {
    const board = new Board();
    const black = encodeFeatures(board, BLACK, []);
    const white = encodeFeatures(board, WHITE, []);
    // 黑方视角 selfKomi=-7.5:komiFloor=-9,delta=1.5 → wave=1.5-2=-0.5
    expect(black.global[18]).toBeCloseTo(-0.5);
    // 白方视角 selfKomi=7.5:komiFloor=7,delta=0.5 → wave=1-0.5=0.5
    expect(white.global[18]).toBeCloseTo(0.5);
  });

  it('规则通道在中国规则下均为 0', () => {
    const board = new Board();
    const { global } = encodeFeatures(board, BLACK, []);
    for (const c of [6, 7, 8, 9, 10, 11, 15, 16, 17]) {
      expect(global[c]).toBe(0);
    }
  });
});
