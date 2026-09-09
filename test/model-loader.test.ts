import 'fake-indexeddb/auto';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheModelBytes,
  getCachedModelBytes,
  importModelFromFile,
  LoadPhase,
  loadModelBytes,
  ModelSpec,
} from '../src/engine/model-loader';

const RAW = new TextEncoder().encode('kataGo-weight-bytes-0123456789'.repeat(100));
const GZIPPED = new Uint8Array(gzipSync(RAW));

const SPEC: ModelSpec = {
  id: 'test-model',
  name: '测试模型',
  urls: ['https://example.com/a.bin.gz', 'https://example.com/b.bin.gz'],
  approxBytes: GZIPPED.length,
};

function streamResponse(body: Uint8Array, status = 200): Response {
  return new Response(new Blob([new Uint8Array(body)]).stream(), {
    status,
    headers: { 'content-length': String(body.length) },
  });
}

beforeEach(() => {
  indexedDB = new IDBFactory();
});

describe('模型加载管线', () => {
  it('下载 gzip 模型:进度回调 + 解压 + 缓存,二次加载命中缓存', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(GZIPPED));
    vi.stubGlobal('fetch', fetchMock);

    const progress: [LoadPhase, number, number | null][] = [];
    const onProgress = (phase: LoadPhase, loaded: number, total: number | null) =>
      progress.push([phase, loaded, total]);

    const bytes = await loadModelBytes(SPEC, onProgress);
    expect(new Uint8Array(bytes)).toEqual(RAW);

    // 下载进度:total 为 content-length,loaded 递增
    const downloadCalls = progress.filter((p) => p[0] === 'download');
    expect(downloadCalls.length).toBeGreaterThan(0);
    expect(downloadCalls.at(-1)![1]).toBe(GZIPPED.length);
    expect(downloadCalls[0]![2]).toBe(GZIPPED.length);
    // 解压进度:total 未知
    const decompressCalls = progress.filter((p) => p[0] === 'decompress');
    expect(decompressCalls.length).toBeGreaterThan(0);
    expect(decompressCalls.at(-1)![1]).toBe(RAW.length);
    expect(decompressCalls[0]![2]).toBeNull();

    // 二次加载:命中缓存,不再发起网络请求
    fetchMock.mockClear();
    const again = await loadModelBytes(SPEC);
    expect(new Uint8Array(again)).toEqual(RAW);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('首个地址失败时回退到下一个地址', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse(GZIPPED, 404))
      .mockResolvedValueOnce(streamResponse(GZIPPED));
    vi.stubGlobal('fetch', fetchMock);

    const bytes = await loadModelBytes(SPEC);
    expect(new Uint8Array(bytes)).toEqual(RAW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('全部地址失败时抛出错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(GZIPPED, 500)));
    await expect(loadModelBytes(SPEC)).rejects.toThrow(/模型下载失败/);
  });

  it('非 gzip 内容原样返回', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(RAW)));
    const bytes = await loadModelBytes(SPEC);
    expect(new Uint8Array(bytes)).toEqual(RAW);
  });

  it('缓存写入后可读取', async () => {
    await cacheModelBytes('m1', RAW.buffer);
    const cached = await getCachedModelBytes('m1');
    expect(new Uint8Array(cached!)).toEqual(RAW);
    expect(await getCachedModelBytes('missing')).toBeNull();
  });

  it('本地文件导入:gzip 自动解压并缓存', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const file = new Blob([new Uint8Array(GZIPPED)]);
    const bytes = await importModelFromFile(SPEC, file);
    expect(new Uint8Array(bytes)).toEqual(RAW);
    // 已缓存,后续加载不再走网络
    const again = await loadModelBytes(SPEC);
    expect(new Uint8Array(again)).toEqual(RAW);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
