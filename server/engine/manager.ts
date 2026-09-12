/**
 * EngineManager:模型注册表与路由。
 *  - load / unload / activate:模型生命周期管理
 *  - status:各实例状态 + 全局队列统计 + 只读路径
 *  - think / analyze:按 request.model ?? activeModel 路由到实例
 * createEngine 通过构造注入,便于单测使用假引擎。
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import type {
  AnalyzeRequest,
  AnalyzeSnapshot,
  EngineStatus,
  HealthResponse,
  ModelInfo,
  ServiceStatus,
  ThinkRequest,
  ThinkResult,
} from '../../src/engine/remote/protocol.ts';
import type { ModelConfig, ServerConfig } from '../config.ts';
import { resolveModelPath } from '../config.ts';
import { createAnalysisConfig } from './analysis-config.ts';
import { EngineInstance, type AnalyzeOptions, type RunRequestOptions } from './engine.ts';
import { NodeKatagoProcess, type SpawnFn, type SpawnedProcess } from './katago-process.ts';

/** 引擎实例的对外契约(供 manager 依赖注入) */
export interface EngineLike {
  readonly modelConfig: ModelConfig;
  readonly isRunning: boolean;
  readonly inFlightCount: number;
  readonly queuedCount: number;
  readonly rejectedCount: number;
  start(): Promise<void>;
  stop(): void;
  status(): EngineStatus;
  think(request: ThinkRequest, options?: RunRequestOptions): Promise<ThinkResult>;
  analyze(request: AnalyzeRequest, options?: AnalyzeOptions): Promise<void>;
}

export interface ManagerDeps {
  /** 覆盖默认引擎工厂(单测注入假引擎) */
  createEngine?: (model: ModelConfig) => EngineLike;
}

function defaultCreateEngine(config: ServerConfig, model: ModelConfig): EngineLike {
  const spawnFn: SpawnFn = (command, args, options) =>
    spawn(command, args, options) as unknown as SpawnedProcess;
  return new EngineInstance(model, {
    config,
    createConfig: (maxVisits) => createAnalysisConfig(config, maxVisits),
    createProcess: (configPath) =>
      new NodeKatagoProcess({
        katagoPath: config.katagoPath,
        configPath,
        modelPath: resolveModelPath(config, model),
        spawn: spawnFn,
      }),
  });
}

export class EngineManager {
  readonly config: ServerConfig;
  private readonly engines = new Map<string, EngineLike>();
  private active: string | null;
  private readonly createEngine: (model: ModelConfig) => EngineLike;

  constructor(config: ServerConfig, deps: ManagerDeps = {}) {
    this.config = config;
    this.createEngine = deps.createEngine ?? ((model) => defaultCreateEngine(config, model));
    this.active = config.activeModel ?? config.models[0]?.id ?? null;
  }

  get activeModel(): string | null {
    return this.active;
  }

  private findModel(id: string): ModelConfig | undefined {
    return this.config.models.find((m) => m.id === id);
  }

  /** 取得(必要时创建)引擎实例 */
  ensureEngine(id: string): EngineLike {
    const existing = this.engines.get(id);
    if (existing) return existing;
    const model = this.findModel(id);
    if (!model) throw new Error(`未知模型: ${id}`);
    const engine = this.createEngine(model);
    this.engines.set(id, engine);
    return engine;
  }

  /** 加载模型并等待就绪 */
  async load(id: string): Promise<EngineLike> {
    const engine = this.ensureEngine(id);
    await engine.start();
    return engine;
  }

  /** 卸载模型并释放资源 */
  async unload(id: string): Promise<void> {
    const engine = this.engines.get(id);
    if (!engine) return;
    engine.stop();
    this.engines.delete(id);
  }

  /** 设为默认并加载 */
  async activate(id: string): Promise<EngineLike> {
    if (!this.findModel(id)) throw new Error(`未知模型: ${id}`);
    this.active = id;
    return this.load(id);
  }

  /** 启动当前激活模型(若未运行);无模型则 no-op */
  async ensureActive(): Promise<void> {
    if (!this.active) return;
    await this.load(this.active);
  }

  private resolveModelId(requestModel: string | undefined): string {
    const id = requestModel ?? this.active;
    if (!id) throw new Error('未指定模型且无激活模型');
    return id;
  }

  async think(request: ThinkRequest, options: RunRequestOptions = {}): Promise<ThinkResult> {
    const engine = this.ensureEngine(this.resolveModelId(request.model));
    return engine.think(request, options);
  }

  async analyze(request: AnalyzeRequest, options: AnalyzeOptions = {}): Promise<void> {
    const engine = this.ensureEngine(this.resolveModelId(request.model));
    await engine.analyze(request, options);
  }

  /** 模型清单(附带文件大小) */
  listModels(): ModelInfo[] {
    return this.config.models.map((m) => {
      const path = resolveModelPath(this.config, m);
      let sizeBytes: number | null = null;
      try {
        sizeBytes = statSync(path).size;
      } catch {
        sizeBytes = null;
      }
      return { id: m.id, name: m.name, path, sizeBytes };
    });
  }

  /** 整体状态聚合 */
  status(): ServiceStatus {
    let active = 0;
    let queued = 0;
    let rejected = 0;
    const engines: EngineStatus[] = [];
    for (const engine of this.engines.values()) {
      engines.push(engine.status());
      active += engine.inFlightCount;
      queued += engine.queuedCount;
      rejected += engine.rejectedCount;
    }
    return {
      engines,
      active: this.active,
      queue: { active, queued, rejected },
      config: { katagoPath: this.config.katagoPath, modelDir: this.config.modelDir },
    };
  }

  /** 健康度:任一激活引擎就绪即 ok */
  health(katagoVersion: string | null): HealthResponse {
    const activeEngine = this.active ? this.engines.get(this.active) : undefined;
    return {
      ok: activeEngine ? activeEngine.isRunning : false,
      katagoPath: this.config.katagoPath,
      katagoVersion,
      activeModel: this.active,
    };
  }

  /** 对外提供快照类型引用(避免类型被裁剪) */
  static snapshotType(): AnalyzeSnapshot | null {
    return null;
  }

  stopAll(): void {
    for (const engine of this.engines.values()) engine.stop();
    this.engines.clear();
  }
}
