import { describe, expect, it } from 'vitest';
import {
  REMOTE_AI_DEFAULT_LEVEL_ID,
  REMOTE_AI_LEVELS,
  remoteLevelOf,
} from '../src/engine/remote/remote-ai-player';

describe('远端难度档位', () => {
  it('共 21 档(20级~业余1段),id / label / profile 唯一', () => {
    expect(REMOTE_AI_LEVELS).toHaveLength(21);
    expect(REMOTE_AI_LEVELS[0]!.label).toBe('20级');
    expect(REMOTE_AI_LEVELS[REMOTE_AI_LEVELS.length - 1]!.label).toBe('业余1段');
    expect(new Set(REMOTE_AI_LEVELS.map((l) => l.id)).size).toBe(REMOTE_AI_LEVELS.length);
    expect(new Set(REMOTE_AI_LEVELS.map((l) => l.label)).size).toBe(REMOTE_AI_LEVELS.length);
    expect(new Set(REMOTE_AI_LEVELS.map((l) => l.profile)).size).toBe(REMOTE_AI_LEVELS.length);
  });

  it('profile 与 id 一一对应(rank_{id},数字级位需补零到两位)', () => {
    for (const level of REMOTE_AI_LEVELS) {
      expect(level.profile).toBe(`rank_${level.id}`);
      expect(level.profile).toMatch(/^rank_(\d{2}k|\dk|\dd)$/);
    }
  });

  it('回退参数:maxVisits 严格递增,maxTemperature 严格递减且在 (0,1]', () => {
    for (let i = 1; i < REMOTE_AI_LEVELS.length; i++) {
      const prev = REMOTE_AI_LEVELS[i - 1]!;
      const cur = REMOTE_AI_LEVELS[i]!;
      expect(cur.maxVisits).toBeGreaterThan(prev.maxVisits);
      expect(cur.maxTemperature).toBeLessThan(prev.maxTemperature);
    }
    for (const level of REMOTE_AI_LEVELS) {
      expect(level.maxVisits).toBeGreaterThan(0);
      expect(level.maxTemperature).toBeGreaterThan(0);
      expect(level.maxTemperature).toBeLessThanOrEqual(1);
    }
  });

  it('remoteLevelOf 命中每一档;未知 id 回退到默认档', () => {
    for (const level of REMOTE_AI_LEVELS) {
      expect(remoteLevelOf(level.id)).toBe(level);
    }
    const fallback = REMOTE_AI_LEVELS.find((l) => l.id === REMOTE_AI_DEFAULT_LEVEL_ID);
    expect(fallback).toBeDefined();
    expect(remoteLevelOf('unknown')).toBe(fallback);
    expect(remoteLevelOf('')).toBe(fallback);
  });
});
