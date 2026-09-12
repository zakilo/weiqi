import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  NodeKatagoProcess,
  type SpawnFn,
  type SpawnedProcess,
} from '../server/engine/katago-process.ts';
import type { AnalysisQuery, AnalysisResponse } from '../server/engine/protocol.ts';

/** 记录写入并可作为 stdout/stderr 派发事件 */
class FakeStream extends EventEmitter {
  readonly writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

/** 最小化假子进程 */
class FakeChild extends EventEmitter {
  pid = 4321;
  readonly stdin = new FakeStream();
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killed: string | null = null;
  kill(signal?: string): boolean {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }
}

interface Harness {
  proc: NodeKatagoProcess;
  spawnCalls: { command: string; args: string[]; options: { stdio?: string[] } }[];
  child: () => FakeChild;
}

function makeHarness(): Harness {
  const spawnCalls: Harness['spawnCalls'] = [];
  let child!: FakeChild;
  const spawn: SpawnFn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    child = new FakeChild();
    return child as unknown as SpawnedProcess;
  };
  const proc = new NodeKatagoProcess({
    katagoPath: 'katago',
    configPath: '/cfg/analysis.cfg',
    modelPath: '/models/m.bin.gz',
    spawn,
  });
  return { proc, spawnCalls, child: () => child };
}

const QUERY: AnalysisQuery = {
  moves: [],
  rules: 'chinese',
  komi: 3.75,
  boardXSize: 19,
  boardYSize: 19,
};

const byte = (id: string | number): string => `q${id}`;

describe('NodeKatagoProcess', () => {
  it('start 以正确参数启动且幂等', () => {
    const h = makeHarness();
    h.proc.start();
    h.proc.start();

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]).toEqual({
      command: 'katago',
      args: ['analysis', '-config', '/cfg/analysis.cfg', '-model', '/models/m.bin.gz'],
      options: { stdio: ['pipe', 'pipe', 'pipe'] },
    });
    expect(h.proc.running).toBe(true);
    expect(h.proc.pid).toBe(4321);
  });

  it('按 id 匹配乱序响应', async () => {
    const h = makeHarness();
    h.proc.start();
    const child = h.child();

    const p1 = h.proc.run(QUERY);
    const p2 = h.proc.run(QUERY);
    const id1 = (JSON.parse(child.stdin.writes[0]!) as { id: string }).id;
    const id2 = (JSON.parse(child.stdin.writes[1]!) as { id: string }).id;
    expect(id1).not.toBe(id2);

    // 先回来 q2,再回来 q1
    child.stdout.emit('data', `${JSON.stringify({ id: id2, rootInfo: { visits: 2 } })}\n`);
    child.stdout.emit('data', `${JSON.stringify({ id: id1, rootInfo: { visits: 1 } })}\n`);

    await expect(p2).resolves.toMatchObject({ id: id2 });
    await expect(p1).resolves.toMatchObject({ id: id1 });
  });

  it('stdout 跨 chunk 的半行被正确分帧', async () => {
    const h = makeHarness();
    h.proc.start();
    const child = h.child();

    const p = h.proc.run(QUERY);
    const full = JSON.stringify({ id: byte(1), rootInfo: { visits: 9 } });
    child.stdout.emit('data', full.slice(0, 8));
    child.stdout.emit('data', `${full.slice(8)}\n`);

    await expect(p).resolves.toMatchObject({ rootInfo: { visits: 9 } });
  });

  it('isDuringSearch 中间报文走 onReport,不结束查询', async () => {
    const h = makeHarness();
    h.proc.start();
    const child = h.child();

    const reports: AnalysisResponse[] = [];
    const p = h.proc.run(QUERY, { onReport: (r) => reports.push(r) });
    const id = (JSON.parse(child.stdin.writes[0]!) as { id: string }).id;

    child.stdout.emit('data', `${JSON.stringify({ id, isDuringSearch: true, turnNumber: 1 })}\n`);
    expect(reports).toHaveLength(1);

    child.stdout.emit('data', `${JSON.stringify({ id, rootInfo: { visits: 40 } })}\n`);
    await expect(p).resolves.toMatchObject({ rootInfo: { visits: 40 } });
    expect(reports).toHaveLength(1);
  });

  it('KataGo 返回 error 报文时拒绝查询(不静默当作空结果)', async () => {
    const h = makeHarness();
    h.proc.start();
    const child = h.child();

    const p = h.proc.run(QUERY);
    const id = (JSON.parse(child.stdin.writes[0]!) as { id: string }).id;

    child.stdout.emit(
      'data',
      `${JSON.stringify({ id, error: 'Must be a integer or half-integer', field: 'komi' })}\n`,
    );
    await expect(p).rejects.toThrow(/KataGo 拒绝查询/);
  });

  it('进程退出时拒绝未完成查询', async () => {
    const h = makeHarness();
    h.proc.start();
    const child = h.child();

    const p = h.proc.run(QUERY);
    child.emit('exit', 1, null);

    await expect(p).rejects.toThrow(/进程已退出/);
    expect(h.proc.running).toBe(false);
  });

  it('stop 终止进程并拒绝未完成查询', async () => {
    const h = makeHarness();
    h.proc.start();
    const child = h.child();

    const p = h.proc.run(QUERY);
    h.proc.stop();

    await expect(p).rejects.toThrow(/引擎已停止/);
    expect(child.killed).toBe('SIGTERM');
    expect(h.proc.running).toBe(false);
  });

  it('无法解析的响应写入日志', () => {
    const h = makeHarness();
    h.proc.start();
    h.child().stdout.emit('data', 'not-a-json\n');
    expect(h.proc.logs.some((line) => line.includes('无法解析响应'))).toBe(true);
  });

  it('未运行时提交查询即拒绝', async () => {
    const h = makeHarness();
    await expect(h.proc.run(QUERY)).rejects.toThrow(/未运行/);
  });

  it('查询超时被拒绝', async () => {
    const h = makeHarness();
    h.proc.start();
    await expect(h.proc.run(QUERY, { timeoutMs: 10 })).rejects.toThrow(/查询超时/);
  });

  it('stderr 被收集为日志', () => {
    const h = makeHarness();
    h.proc.start();
    h.child().stderr.emit('data', 'warning: model loaded\n');
    expect(h.proc.logs).toContain('warning: model loaded');
  });
});
