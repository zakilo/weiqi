/**
 * 服务连通性探测:models + status 并发拉取,失败自动重试一次。
 *
 * 为什么需要重试:移动端 WiFi 省电会在空闲时回收 keep-alive 连接,
 * 轮询偶尔撞上死套接字导致单次 fetch 失败;若据此立刻判定"未连接",
 * 界面上就会出现每次落子后闪几秒的假断联。重试 + 连续失败计数可消除抖动。
 */
import type { ModelInfo, ServiceStatus } from './protocol';
import type { ServiceClient } from './service-client';

export interface ServiceProbeOptions {
  /** 总尝试次数(含首次),默认 2 */
  attempts?: number;
  /** 重试间隔(ms),默认 300 */
  retryDelayMs?: number;
  /** 可注入的 sleep,便于单测 */
  sleep?: (ms: number) => Promise<void>;
}

export interface ServiceProbe {
  ok: boolean;
  models?: ModelInfo[];
  status?: ServiceStatus;
  /** 最后一次失败的错误文案 */
  error?: string;
  /** 实际尝试次数 */
  attempts: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function probeService(client: ServiceClient, options: ServiceProbeOptions = {}): Promise<ServiceProbe> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const retryDelayMs = options.retryDelayMs ?? 300;
  const sleep = options.sleep ?? defaultSleep;
  let error = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const [models, status] = await Promise.all([client.models(), client.status()]);
      return { ok: true, models: models.models, status, attempts: i };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (i < attempts) await sleep(retryDelayMs);
    }
  }
  return { ok: false, error, attempts };
}
