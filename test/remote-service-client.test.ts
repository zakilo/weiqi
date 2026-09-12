import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceClient } from '../src/engine/remote/service-client';
import type { AnalyzeSnapshot } from '../src/engine/remote/protocol';

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 每次 pull 产出一个 chunk 的可读流 */
function ndjsonStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

const ANALYZE_REQUEST = { moves: [], komi: 3.75, rules: 'chinese' as const };

describe('ServiceClient 基础请求', () => {
  it('health/models/status 走 GET,解析 JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ok: true, katagoPath: 'katago', katagoVersion: '1.0', activeModel: 'a' }))
      .mockResolvedValueOnce(json({ models: [{ id: 'a', name: 'A', path: '/a', sizeBytes: null }], active: 'a' }))
      .mockResolvedValueOnce(
        json({
          engines: [],
          active: 'a',
          queue: { active: 0, queued: 0, rejected: 0 },
          config: { katagoPath: 'katago', modelDir: '/m' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ServiceClient();
    expect((await client.health()).ok).toBe(true);
    expect((await client.models()).active).toBe('a');
    expect((await client.status()).config.modelDir).toBe('/m');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/health', '/api/models', '/api/status']);
  });

  it('baseUrl 前缀拼接', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ServiceClient('http://localhost:8080');
    await client.health();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8080/api/health');
  });

  it('think 以 POST 发送 JSON 体', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ move: 5, winRate: 0.5, scoreLead: 1, visits: 100 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ServiceClient();
    const result = await client.think({ ...ANALYZE_REQUEST, maxVisits: 200 });
    expect(result).toEqual({ move: 5, winRate: 0.5, scoreLead: 1, visits: 100 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ai/think');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ maxVisits: 200 });
  });

  it('模型操作路由正确并对 id 编码', async () => {
    // 每次返回新的 Response(复用同一实例会导致 body 被重复读取)
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ServiceClient();
    await client.loadModel('a b');
    await client.unloadModel('x');
    await client.activateModel('y');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/models/a%20b/load',
      '/api/models/x/unload',
      '/api/models/y/activate',
    ]);
  });
});

describe('ServiceClient 错误处理', () => {
  it('从 JSON error 字段提取消息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: '引擎失败' }, 500)));
    await expect(new ServiceClient().health()).rejects.toThrow('引擎失败');
  });

  it('非 JSON 错误体原样透出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('plain error', { status: 502 })));
    await expect(new ServiceClient().health()).rejects.toThrow('plain error');
  });

  it('空响应体回退为 HTTP 状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(new ServiceClient().health()).rejects.toThrow('HTTP 503');
  });
});

describe('ServiceClient analyze(NDJSON)', () => {
  it('解析跨 chunk 与末尾无换行的逐行报文', async () => {
    const stream = ndjsonStream([
      '{"playouts":20,"rootValue":0.5,"bestMove":3,"candidates":[]}\n{"play',
      'outs":40,"rootValue":0.6,"bestMove":4,"candidates":[]}',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const snapshots: AnalyzeSnapshot[] = [];
    await new ServiceClient().analyze(ANALYZE_REQUEST, { onSnapshot: (s) => snapshots.push(s) });
    expect(snapshots.map((s) => s.playouts)).toEqual([20, 40]);
  });

  it('error 行交给 onError', async () => {
    const stream = ndjsonStream([
      '{"playouts":20,"rootValue":0.5,"bestMove":3,"candidates":[]}\n',
      '{"error":"分析失败"}\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const snapshots: AnalyzeSnapshot[] = [];
    const errors: Error[] = [];
    await new ServiceClient().analyze(ANALYZE_REQUEST, {
      onSnapshot: (s) => snapshots.push(s),
      onError: (e) => errors.push(e),
    });
    expect(snapshots).toHaveLength(1);
    expect(errors[0]!.message).toBe('分析失败');
  });

  it('非 2xx 响应抛出解析后的错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: '队列已满' }, 429)));
    await expect(new ServiceClient().analyze(ANALYZE_REQUEST, { onSnapshot: () => {} })).rejects.toThrow('队列已满');
  });

  it('流错误在读取阶段抛出', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('流错误'));
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    await expect(new ServiceClient().analyze(ANALYZE_REQUEST, { onSnapshot: () => {} })).rejects.toThrow('流错误');
  });

  it('signal 中止时以 AbortError 拒绝', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => {
            const err = new Error('已取消');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }),
    );

    const controller = new AbortController();
    const p = new ServiceClient().analyze(ANALYZE_REQUEST, { onSnapshot: () => {} }, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow('已取消');
  });
});
