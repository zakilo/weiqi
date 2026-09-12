import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EngineManager, type EngineLike, type ManagerDeps } from '../server/engine/manager.ts';
import type { ServerConfig, ModelConfig } from '../server/config.ts';
import type {
  AnalyzeRequest,
  EngineStatus,
  ThinkRequest,
  ThinkResult,
} from '../src/engine/remote/protocol.ts';

/** 记录生命周期调用与可配置统计的假引擎 */
class FakeEngine implements EngineLike {
  readonly modelConfig: ModelConfig;
  running = false;
  inFlightCount = 0;
  queuedCount = 0;
  rejectedCount = 0;
  startedTimes = 0;
  stoppedTimes = 0;
  lastRequest: ThinkRequest | null = null;

  constructor(model: ModelConfig) {
    this.modelConfig = model;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startedTimes++;
  }

  stop(): void {
    this.running = false;
    this.stoppedTimes++;
  }

  status(): EngineStatus {
    return {
      modelId: this.modelConfig.id,
      modelName: this.modelConfig.name,
      state: this.running ? 'ready' : 'stopped',
      pid: null,
      inFlight: this.inFlightCount,
      queued: this.queuedCount,
      rejected: this.rejectedCount,
      totalRequests: 0,
      startedAt: null,
      lastError: null,
    };
  }

  async think(request: ThinkRequest): Promise<ThinkResult> {
    this.lastRequest = request;
    return { move: 7, winRate: 0.5, scoreLead: 1, visits: 100 };
  }

  async analyze(_request: AnalyzeRequest): Promise<void> {
    /* no-op */
  }
}

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 8080,
    host: '0.0.0.0',
    katagoPath: 'katago',
    modelDir: '/abs/models',
    models: [
      { id: 'a', name: 'Model A', file: 'a.bin.gz' },
      { id: 'b', name: 'Model B', file: 'b.bin.gz' },
    ],
    activeModel: 'a',
    komi: 3.75,
    maxVisitsDefault: 200,
    numAnalysisThreads: 4,
    nnMaxBatchSize: 8,
    reportDuringSearchEvery: 40,
    analysisPVLen: 15,
    maxInFlightPerEngine: 1,
    maxQueuePerEngine: 8,
    queueTimeoutMs: 60000,
    requestTimeoutMs: 120000,
    ...overrides,
  };
}

function makeManager(config = makeConfig()): { manager: EngineManager; created: FakeEngine[] } {
  const created: FakeEngine[] = [];
  const deps: ManagerDeps = {
    createEngine: (model) => {
      const engine = new FakeEngine(model);
      created.push(engine);
      return engine;
    },
  };
  return { manager: new EngineManager(config, deps), created };
}

const THINK: ThinkRequest = { moves: [], komi: 3.75, rules: 'chinese' };

describe('EngineManager 生命周期', () => {
  it('默认激活 activeModel,缺省回退首个模型', () => {
    expect(makeManager().manager.activeModel).toBe('a');
    const { manager } = makeManager(makeConfig({ activeModel: null }));
    expect(manager.activeModel).toBe('a');
    const empty = makeManager(makeConfig({ models: [], activeModel: null }));
    expect(empty.manager.activeModel).toBeNull();
  });

  it('ensureEngine 缓存实例,未知模型抛错', () => {
    const { manager, created } = makeManager();
    const first = manager.ensureEngine('a');
    const second = manager.ensureEngine('a');
    expect(first).toBe(second);
    expect(created).toHaveLength(1);
    expect(() => manager.ensureEngine('z')).toThrow(/未知模型/);
  });

  it('load 启动实例,unload 停止并释放', async () => {
    const { manager, created } = makeManager();
    await manager.load('a');
    expect(created[0]!.startedTimes).toBe(1);
    expect(created[0]!.isRunning).toBe(true);

    await manager.unload('a');
    expect(created[0]!.stoppedTimes).toBe(1);
    // 卸载后再次 ensureEngine 会创建新实例
    const again = manager.ensureEngine('a');
    expect(again).not.toBe(created[0]);
  });

  it('activate 设为默认并加载,未知模型抛错', async () => {
    const { manager, created } = makeManager();
    await manager.activate('b');
    expect(manager.activeModel).toBe('b');
    expect(created[0]!.modelConfig.id).toBe('b');
    expect(created[0]!.startedTimes).toBe(1);

    await expect(manager.activate('z')).rejects.toThrow(/未知模型/);
  });

  it('stopAll 停止所有实例', async () => {
    const { manager, created } = makeManager();
    await manager.load('a');
    await manager.load('b');
    manager.stopAll();
    expect(created.every((e) => e.stoppedTimes === 1)).toBe(true);
    expect(manager.status().engines).toEqual([]);
  });
});

describe('EngineManager 路由', () => {
  it('think 默认路由到激活模型', async () => {
    const { manager, created } = makeManager();
    const result = await manager.think(THINK);
    expect(result.move).toBe(7);
    expect(created.map((e) => e.modelConfig.id)).toEqual(['a']);
  });

  it('think 携带 model 时路由到指定模型', async () => {
    const { manager, created } = makeManager();
    await manager.think({ ...THINK, model: 'b' });
    expect(created[created.length - 1]!.modelConfig.id).toBe('b');
  });

  it('无激活模型且未指定时报错', async () => {
    const { manager } = makeManager(makeConfig({ models: [], activeModel: null }));
    await expect(manager.think(THINK)).rejects.toThrow(/未指定模型/);
  });
});

describe('EngineManager 状态聚合', () => {
  it('status 汇总各实例统计与只读路径', () => {
    const { manager } = makeManager();
    const a = manager.ensureEngine('a') as FakeEngine;
    const b = manager.ensureEngine('b') as FakeEngine;
    a.inFlightCount = 1;
    a.queuedCount = 2;
    a.rejectedCount = 3;
    b.queuedCount = 1;

    const status = manager.status();
    expect(status.engines).toHaveLength(2);
    expect(status.active).toBe('a');
    expect(status.queue).toEqual({ active: 1, queued: 3, rejected: 3 });
    expect(status.config).toEqual({ katagoPath: 'katago', modelDir: '/abs/models' });
  });

  it('health 以激活实例是否运行判定 ok', async () => {
    const { manager } = makeManager();
    expect(manager.health('v1.0').ok).toBe(false);

    await manager.load('a');
    expect(manager.health('v1.0')).toMatchObject({
      ok: true,
      activeModel: 'a',
      katagoVersion: 'v1.0',
      katagoPath: 'katago',
    });
  });

  it('listModels 附带路径,文件缺失时 sizeBytes 为 null', () => {
    const { manager } = makeManager();
    const models = manager.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: 'a', name: 'Model A', path: resolve('/abs/models', 'a.bin.gz') });
    expect(models[0]!.sizeBytes).toBeNull();
  });
});
