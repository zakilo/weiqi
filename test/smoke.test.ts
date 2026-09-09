import { describe, expect, it } from 'vitest';

describe('测试环境冒烟', () => {
  it('基础断言可用', () => {
    expect(1 + 1).toBe(2);
  });
});
