import { describe, expect, it } from 'vitest';
import { BLACK, Board, idx, Stone } from '../src/core/board';
import { NO_PREV_HASH } from '../src/core/rules';
import { AnalysisClient } from '../src/engine/analysis-client';
import type { AnalysisState } from '../src/engine/analysis-engine';

/** 假 Worker:捕获 postMessage,可主动触发 onmessage */
class FakeWorker {
  posted: Record<string, unknown>[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(msg: unknown): void {
    this.posted.push(msg as Record<string, unknown>);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: unknown): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
}

const state: AnalysisState = {
  board: new Board(),
  stone: BLACK as Stone,
  recentMoves: [],
  komi: 3.75,
  prevHash: NO_PREV_HASH,
};

function readyClient(fake: FakeWorker): [AnalysisClient, Promise<string>] {
  const client = new AnalysisClient(() => fake as unknown as Worker);
  const p = client.ensure(new ArrayBuffer(8));
  fake.emit({ type: 'ready', backend: 'cpu' });
  return [client, p];
}

describe('AnalysisClient', () => {
  it('ensure 发送 init 并在 ready 后置就绪', async () => {
    const fake = new FakeWorker();
    const [client, p] = readyClient(fake);

    expect(fake.posted[0]).toMatchObject({ type: 'init' });
    await expect(p).resolves.toBe('cpu');
    expect(client.isReady).toBe(true);
    expect(client.backend).toBe('cpu');
  });

  it('init 失败时 ensure 拒绝', async () => {
    const fake = new FakeWorker();
    const client = new AnalysisClient(() => fake as unknown as Worker);
    const p = client.ensure(new ArrayBuffer(8));
    fake.emit({ type: 'error', id: null, message: '解析失败' });
    await expect(p).rejects.toThrow(/解析失败/);
    expect(client.isReady).toBe(false);
  });

  it('analyze 发送请求,snapshot 按 id 路由到回调', async () => {
    const fake = new FakeWorker();
    const [client] = readyClient(fake);

    const playouts: number[] = [];
    client.callbacks.onSnapshot = (s) => playouts.push(s.playouts);

    client.analyze(state);
    const sent = fake.posted[fake.posted.length - 1]!;
    expect(sent.type).toBe('analyze');
    expect(sent.request).toBeDefined();

    fake.emit({
      type: 'snapshot',
      id: sent.id,
      snapshot: { playouts: 40, rootValue: 0.5, bestMove: idx(9, 9), candidates: [] },
    });
    expect(playouts).toEqual([40]);
  });

  it('过期 analyze 的 snapshot 不回调,stop 后也不回调', async () => {
    const fake = new FakeWorker();
    const [client] = readyClient(fake);
    const playouts: number[] = [];
    client.callbacks.onSnapshot = (s) => playouts.push(s.playouts);

    client.analyze(state);
    const first = fake.posted[fake.posted.length - 1]!;
    client.analyze(state);
    const second = fake.posted[fake.posted.length - 1]!;
    expect(second.id).not.toBe(first.id);

    // 旧 id 的 snapshot 被忽略
    fake.emit({ type: 'snapshot', id: first.id, snapshot: { playouts: 10, rootValue: 0.5, bestMove: 0, candidates: [] } });
    expect(playouts).toEqual([]);
    // 新 id 正常回调
    fake.emit({ type: 'snapshot', id: second.id, snapshot: { playouts: 20, rootValue: 0.5, bestMove: 0, candidates: [] } });
    expect(playouts).toEqual([20]);

    // stop 后清空匹配,后续消息不再回调
    client.stop();
    fake.emit({ type: 'snapshot', id: second.id, snapshot: { playouts: 30, rootValue: 0.5, bestMove: 0, candidates: [] } });
    expect(playouts).toEqual([20]);
    expect(fake.posted[fake.posted.length - 1]).toMatchObject({ type: 'stop' });
  });

  it('variation 逐步回报按 id 路由,dispose 终止 Worker', async () => {
    const fake = new FakeWorker();
    const [client] = readyClient(fake);

    const steps: number[] = [];
    let doneLine: number[] | null = null;
    client.callbacks.onVariationStep = (move) => steps.push(move);
    client.callbacks.onVariationDone = (line) => {
      doneLine = line;
    };

    client.requestVariation(state, idx(3, 3), 3, 20);
    const sent = fake.posted[fake.posted.length - 1]!;
    expect(sent.type).toBe('variation');
    expect(sent.startMove).toBe(idx(3, 3));

    fake.emit({ type: 'variation-step', id: sent.id, move: idx(3, 3), index: 0 });
    fake.emit({ type: 'variation-step', id: sent.id, move: idx(9, 9), index: 1 });
    fake.emit({ type: 'variation-done', id: sent.id, line: [idx(3, 3), idx(9, 9)] });
    expect(steps).toEqual([idx(3, 3), idx(9, 9)]);
    expect(doneLine).toEqual([idx(3, 3), idx(9, 9)]);

    client.dispose();
    expect(fake.terminated).toBe(true);
  });
});
