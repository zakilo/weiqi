import { describe, expect, it } from 'vitest';
import { blackEvalOf, leadText } from '../src/engine/remote/eval';

describe('blackEvalOf', () => {
  it('黑方行棋:行棋方视角即黑方视角,原样透传', () => {
    const e = blackEvalOf({ rootValue: 0.62, rootScoreLead: 4.5 }, 'B');
    expect(e.blackWinRate).toBeCloseTo(0.62, 10);
    expect(e.blackLead).toBeCloseTo(4.5, 10);
  });

  it('白方行棋:胜率取补、目差取反', () => {
    const e = blackEvalOf({ rootValue: 0.62, rootScoreLead: 4.5 }, 'W');
    expect(e.blackWinRate).toBeCloseTo(0.38, 10);
    expect(e.blackLead).toBeCloseTo(-4.5, 10);
  });
});

describe('leadText', () => {
  it('1 子内视为接近(含边界)', () => {
    expect(leadText(0)).toBe('形势接近');
    expect(leadText(0.9)).toBe('形势接近');
    expect(leadText(-0.9)).toBe('形势接近');
  });

  it('领先文案含方向与一位小数', () => {
    expect(leadText(4.5)).toBe('黑领先 4.5 子');
    expect(leadText(-2)).toBe('白领先 2.0 子');
  });
});
