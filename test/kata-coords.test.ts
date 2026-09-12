import { describe, expect, it } from 'vitest';
import {
  BOARD_AREA,
  COLUMN_LABELS,
  PASS,
  kataGoToPos,
  posToKataGo,
} from '../server/engine/coords.ts';

/** 棋盘索引:pos = row*19 + col(row 0 在上) */
const idx = (col: number, row: number): number => row * 19 + col;

describe('coords: pos ↔ KataGo', () => {
  it('角点与虚着', () => {
    expect(posToKataGo(idx(0, 18))).toBe('A1'); // 左下
    expect(posToKataGo(idx(0, 0))).toBe('A19'); // 左上
    expect(posToKataGo(idx(18, 0))).toBe('T19'); // 右上(跳过 I)
    expect(posToKataGo(idx(18, 18))).toBe('T1'); // 右下
    expect(posToKataGo(PASS)).toBe('pass');
  });

  it('kataGoToPos 反向', () => {
    expect(kataGoToPos('A1')).toBe(idx(0, 18));
    expect(kataGoToPos('A19')).toBe(idx(0, 0));
    expect(kataGoToPos('T19')).toBe(idx(18, 0));
    expect(kataGoToPos('pass')).toBe(PASS);
    expect(kataGoToPos('PASS')).toBe(PASS);
    expect(kataGoToPos(' Pass ')).toBe(PASS);
  });

  it('列标签跳过字母 I', () => {
    expect(COLUMN_LABELS).toBe('ABCDEFGHJKLMNOPQRST');
    expect(COLUMN_LABELS.indexOf('I')).toBe(-1);
    expect(kataGoToPos('I5')).toBeNull();
  });

  it('非法输入返回 null', () => {
    expect(kataGoToPos('')).toBeNull();
    expect(kataGoToPos('A0')).toBeNull();
    expect(kataGoToPos('A20')).toBeNull();
    expect(kataGoToPos('Z5')).toBeNull();
    expect(kataGoToPos('1A')).toBeNull();
  });

  it('越界或非整数索引抛错', () => {
    expect(() => posToKataGo(-1)).toThrow(RangeError);
    expect(() => posToKataGo(BOARD_AREA + 1)).toThrow(RangeError);
    expect(() => posToKataGo(1.5)).toThrow(RangeError);
  });

  it('361 点全量往返一致', () => {
    for (let pos = 0; pos < BOARD_AREA; pos++) {
      expect(kataGoToPos(posToKataGo(pos))).toBe(pos);
    }
  });
});
