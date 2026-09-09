import { describe, expect, it } from 'vitest';
import {
  buildSgfDoc,
  extractMainLine,
  parseSgf,
  pointToSgf,
  serializeSgf,
  sgfToPoint,
} from '../src/core/sgf';

describe('SGF 坐标', () => {
  it('坐标转换往返', () => {
    expect(sgfToPoint('aa')).toEqual({ col: 0, row: 0 });
    expect(sgfToPoint('ss')).toEqual({ col: 18, row: 18 });
    expect(sgfToPoint('pd')).toEqual({ col: 15, row: 3 });
    expect(sgfToPoint('x')).toBeNull();
    expect(pointToSgf(15, 3)).toBe('pd');
    expect(pointToSgf(0, 0)).toBe('aa');
  });
});

describe('SGF 解析', () => {
  it('解析基础棋谱', () => {
    const doc = parseSgf('(;GM[1]FF[4]SZ[19]KM[7.5];B[pd];W[dp];B[pp])');
    expect(doc).not.toBeNull();
    expect(doc!.properties['GM']).toEqual(['1']);
    expect(doc!.properties['SZ']).toEqual(['19']);
    const moves = extractMainLine(doc!);
    expect(moves).toHaveLength(3);
    expect(moves[0]).toEqual({ stone: 1, col: 15, row: 3 });
    expect(moves[1]).toEqual({ stone: 2, col: 3, row: 15 });
    expect(moves[2]).toEqual({ stone: 1, col: 15, row: 15 });
  });

  it('虚着与注释', () => {
    const doc = parseSgf('(;GM[1]SZ[19];B[aa]C[你好];W[];B[ab])');
    const moves = extractMainLine(doc!);
    expect(moves).toHaveLength(3);
    expect(moves[0].comment).toBe('你好');
    expect(moves[1].col).toBeNull();
    expect(moves[1].row).toBeNull();
    expect(moves[2]).toEqual({ stone: 1, col: 0, row: 1 });
  });

  it('分支解析:主线 2 手,分支挂在第 1 手', () => {
    const doc = parseSgf('(;GM[1];B[aa];W[bb](;B[cc])(;B[dd];W[ee]))');
    expect(doc).not.toBeNull();
    // 结构:root → B[aa] → W[bb];W[bb] 有两个子分支
    const first = doc!.children[0]!;
    expect(first.properties['B']).toEqual(['aa']);
    const second = first.children[0]!;
    expect(second.properties['W']).toEqual(['bb']);
    expect(second.children).toHaveLength(2);
    expect(second.children[0]!.properties['B']).toEqual(['cc']);
    expect(second.children[1]!.properties['B']).toEqual(['dd']);
  });

  it('属性值转义(] 与 \\)', () => {
    const doc = parseSgf('(;GM[1];B[aa]C[foo\\]bar\\\\baz])');
    expect(doc).not.toBeNull();
    const moves = extractMainLine(doc!);
    expect(moves[0].comment).toBe('foo]bar\\baz');
  });

  it('非法文本返回 null', () => {
    expect(parseSgf('这不是棋谱')).toBeNull();
    expect(parseSgf('')).toBeNull();
  });
});

describe('SGF 序列化与往返', () => {
  it('序列化后重新解析,主线一致', () => {
    const moves = [
      { stone: 1 as const, col: 15, row: 3 },
      { stone: 2 as const, col: 3, row: 15 },
      { stone: 1 as const, col: null, row: null },
      { stone: 2 as const, col: 9, row: 9, comment: '天元' },
    ];
    const doc = buildSgfDoc(moves, { blackName: '黑方', whiteName: '白方', result: 'B+3.75' });
    const text = serializeSgf(doc);
    expect(text).toContain('GM[1]');
    expect(text).toContain('PB[黑方]');
    expect(text).toContain('RE[B+3.75]');
    const reparsed = parseSgf(text)!;
    expect(reparsed.properties['PB']).toEqual(['黑方']);
    const line = extractMainLine(reparsed);
    expect(line).toHaveLength(4);
    expect(line[2].col).toBeNull();
    expect(line[3].comment).toBe('天元');
  });

  it('分支序列化保留结构', () => {
    const doc = parseSgf('(;GM[1];B[aa];W[bb](;B[cc])(;B[dd]))')!;
    const text = serializeSgf(doc);
    const reparsed = parseSgf(text)!;
    const second = reparsed.children[0]!.children[0]!;
    expect(second.children).toHaveLength(2);
    expect(second.children[0]!.properties['B']).toEqual(['cc']);
    expect(second.children[1]!.properties['B']).toEqual(['dd']);
  });
});
