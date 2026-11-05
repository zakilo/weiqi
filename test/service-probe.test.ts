import { describe, expect, it } from 'vitest';
import { probeService } from '../src/engine/remote/service-probe';
import type { ServiceClient } from '../src/engine/remote/service-client';

function fakeClient(failures: number): { client: ServiceClient; calls: () => number } {
  let remaining = failures;
  let calls = 0;
  const ok = { models: [{ id: 'b18', name: 'b18', path: '/m', sizeBytes: 1 }], active: 'b18' };
  const status = { engines: [], active: 'b18', queue: { active: 0, queued: 0, rejected: 0 }, config: {} };
  const client = {
    models: async () => {
      calls++;
      if (remaining > 0) {
        remaining--;
        throw new Error('socket hang up');
      }
      return ok;
    },
    status: async () => {
      calls++;
      if (remaining > 0) throw new Error('socket hang up');
      return status;
    },
  } as unknown as ServiceClient;
  return { client, calls: () => calls };
}

const noSleep = async (): Promise<void> => {};

describe('probeService', () => {
  it('首次成功即返回 ok', async () => {
    const { client, calls } = fakeClient(0);
    const probe = await probeService(client, { sleep: noSleep });
    expect(probe.ok).toBe(true);
    expect(probe.attempts).toBe(1);
    expect(probe.models?.[0]?.id).toBe('b18');
    expect(calls()).toBe(2);
  });

  it('单次失败重试后成功,不判定断联', async () => {
    const { client } = fakeClient(1);
    const probe = await probeService(client, { sleep: noSleep });
    expect(probe.ok).toBe(true);
    expect(probe.attempts).toBe(2);
    expect(probe.error).toBeUndefined();
  });

  it('连续失败返回错误文案,供界面展示真实原因', async () => {
    const { client } = fakeClient(5);
    const probe = await probeService(client, { sleep: noSleep });
    expect(probe.ok).toBe(false);
    expect(probe.error).toBe('socket hang up');
    expect(probe.attempts).toBe(2);
  });

  it('重试间隔可配置且确实等待', async () => {
    const { client } = fakeClient(1);
    const waits: number[] = [];
    await probeService(client, { retryDelayMs: 123, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([123]);
  });
});
