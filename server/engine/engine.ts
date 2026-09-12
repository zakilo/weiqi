/**
 * EngineInstance:绑定单个模型的引擎实例。
 *  - 持有 KataGo 进程、运行状态与统计
 *  - FIFO 队列 + 限流(maxInFlightPerEngine / maxQueuePerEngine / queueTimeoutMs)
 *  - 启动后执行一次 warmup 查询确认 ready
 * 依赖(进程/临时配置)通过构造注入,便于单测使用假实现。
 */
import type { EngineStatus, EngineState } from '../../src/engine/remote/protocol.ts';
import type { AnalyzeRequest, AnalyzeSnapshot, ThinkRequest, ThinkResult } from '../../src/engine/remote/protocol.ts';
import type { ModelConfig, ServerConfig } from '../config.ts';
import type { TempConfig } from './analysis-config.ts';
import type { AnalysisQuery, AnalysisResponse } from './protocol.ts';
import { buildAnalysisQuery, parseThink, toSnapshot } from './protocol.ts';
import type { KatagoProcessLike } from './katago-process.ts';

/** 排队已满时抛出,API 层映射为 HTTP 429 */
export class QueueFullError extends Error {
  constructor(message = '引擎队列已满') {
    super(message);
    this.name = 'QueueFullError';
  }
}

export interface EngineDeps {
  config: ServerConfig;
  createConfig: (maxVisits: number) => TempConfig;
  createProcess: (configPath: string) => KatagoProcessLike;
}

interface QueuedTask {
  query: AnalysisQuery;
  options: RunRequestOptions;
  resolve: (response: AnalysisResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RunRequestOptions {
  signal?: AbortSignal;
  onReport?: (response: AnalysisResponse) => void;
}

export interface AnalyzeOptions {
  signal?: AbortSignal;
  onSnapshot?: (snapshot: AnalyzeSnapshot) => void;
}

export class EngineInstance {
  private process: KatagoProcessLike | null = null;
  private tempConfig: TempConfig | null = null;
  private state: EngineState = 'stopped';
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private inFlight = 0;
  private rejected = 0;
  private totalRequests = 0;
  private readonly queue: QueuedTask[] = [];
  private starting: Promise<void> | null = null;
  private readonly model: ModelConfig;
  private readonly deps: EngineDeps;

  constructor(model: ModelConfig, deps: EngineDeps) {
    this.model = model;
    this.deps = deps;
  }

  get modelConfig(): ModelConfig {
    return this.model;
  }

  get isRunning(): boolean {
    return this.state === 'ready' || this.state === 'busy' || this.state === 'starting';
  }

  /** 启动引擎(幂等;warmup 失败则进入 error 态) */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.state === 'ready' || this.state === 'busy') return Promise.resolve();

    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.process) return;
    this.state = 'starting';
    this.lastError = null;
    try {
      const temp = this.deps.createConfig(this.deps.config.maxVisitsDefault);
      const proc = this.deps.createProcess(temp.path);
      this.tempConfig = temp;
      this.process = proc;
      proc.start();
      this.startedAt = Date.now();
      await proc.run(this.warmupQuery(), { timeoutMs: this.deps.config.requestTimeoutMs });
      this.state = 'ready';
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.state = 'error';
      this.process?.stop();
      this.process = null;
      this.tempConfig?.dispose();
      this.tempConfig = null;
    }
  }

  private warmupQuery(): AnalysisQuery {
    return {
      moves: [],
      rules: 'chinese',
      komi: this.deps.config.komi,
      boardXSize: 19,
      boardYSize: 19,
      maxVisits: 1,
    };
  }

  /** 停止引擎:终止进程、清理临时配置、拒绝所有排队查询 */
  stop(): void {
    this.state = 'stopped';
    this.startedAt = null;
    for (const task of this.queue) {
      if (task.timer) clearTimeout(task.timer);
      task.reject(new Error('引擎已停止'));
    }
    this.queue.length = 0;
    this.process?.stop();
    this.process = null;
    this.tempConfig?.dispose();
    this.tempConfig = null;
  }

  /** 让 AI 思考一步(内部做温度采样) */
  async think(request: ThinkRequest, options: RunRequestOptions = {}): Promise<ThinkResult> {
    const query = buildAnalysisQuery(request, {
      maxVisits: request.maxVisits ?? this.deps.config.maxVisitsDefault,
      reportDuringSearchEvery: this.deps.config.reportDuringSearchEvery,
    });
    const response = await this.run(query, options);
    return parseThink(response, request.maxTemperature ?? 0);
  }

  /** 持续分析一个局面:中间报文转为快照经 onSnapshot 回调 */
  async analyze(request: AnalyzeRequest, options: AnalyzeOptions = {}): Promise<void> {
    const query = buildAnalysisQuery(request, {
      maxVisits: request.maxVisits ?? this.deps.config.maxVisitsDefault,
      reportDuringSearchEvery: this.deps.config.reportDuringSearchEvery,
    });
    const onSnapshot = options.onSnapshot;
    const response = await this.run(query, {
      signal: options.signal,
      onReport: onSnapshot ? (resp) => onSnapshot(toSnapshot(resp)) : undefined,
    });
    onSnapshot?.(toSnapshot(response));
  }

  /** 提交查询:超出并发则入队;队列满抛 QueueFullError */
  run(query: AnalysisQuery, options: RunRequestOptions = {}): Promise<AnalysisResponse> {
    this.totalRequests++;
    const proc = this.process;
    if (this.state === 'stopped' || this.state === 'error' || !proc || !proc.running) {
      return Promise.reject(new Error('引擎未运行'));
    }
    const maxInFlight = Math.max(1, this.deps.config.maxInFlightPerEngine);
    if (this.inFlight >= maxInFlight) {
      if (this.queue.length >= this.deps.config.maxQueuePerEngine) {
        this.rejected++;
        return Promise.reject(new QueueFullError());
      }
      return this.enqueue(query, options);
    }
    return this.execute(query, options);
  }

  private enqueue(query: AnalysisQuery, options: RunRequestOptions): Promise<AnalysisResponse> {
    return new Promise<AnalysisResponse>((resolve, reject) => {
      const task: QueuedTask = { query, options, resolve, reject, timer: null };
      const timeoutMs = this.deps.config.queueTimeoutMs;
      if (timeoutMs > 0) {
        task.timer = setTimeout(() => {
          const idx = this.queue.indexOf(task);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            this.rejected++;
            reject(new Error('排队超时'));
          }
        }, timeoutMs);
      }
      this.queue.push(task);
    });
  }

  private execute(query: AnalysisQuery, options: RunRequestOptions): Promise<AnalysisResponse> {
    const proc = this.process;
    if (!proc) return Promise.reject(new Error('引擎未运行'));
    this.inFlight++;
    this.refreshBusyState();

    const signal = options.signal;
    const onReport = options.onReport;
    let settled = false;
    let onAbort: (() => void) | null = null;

    const result = new Promise<AnalysisResponse>((resolve, reject) => {
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        fn();
      };

      const runner = proc.run(query, {
        onReport: onReport ? (resp) => {
          if (!settled) onReport(resp);
        } : undefined,
        timeoutMs: this.deps.config.requestTimeoutMs,
      });
      runner.then(
        (resp) => finish(() => resolve(resp)),
        (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
      );

      if (signal) {
        onAbort = () => finish(() => reject(new Error('请求已取消')));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    return result.finally(() => {
      this.inFlight--;
      this.refreshBusyState();
      this.drain();
    });
  }

  private drain(): void {
    const maxInFlight = Math.max(1, this.deps.config.maxInFlightPerEngine);
    while (this.inFlight < maxInFlight && this.queue.length > 0) {
      const task = this.queue.shift()!;
      if (task.timer) clearTimeout(task.timer);
      this.execute(task.query, task.options).then(task.resolve, task.reject);
    }
  }

  private refreshBusyState(): void {
    if (this.state === 'starting' || this.state === 'error' || this.state === 'stopped') return;
    this.state = this.inFlight > 0 ? 'busy' : 'ready';
  }

  /** 当前状态快照 */
  status(): EngineStatus {
    return {
      modelId: this.model.id,
      modelName: this.model.name,
      state: this.state,
      pid: this.process?.pid ?? null,
      inFlight: this.inFlight,
      queued: this.queue.length,
      rejected: this.rejected,
      totalRequests: this.totalRequests,
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }

  /** 供 manager 汇总:总排队数 */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** 供 manager 汇总:总拒绝数 */
  get rejectedCount(): number {
    return this.rejected;
  }

  /** 供 manager 汇总:进行中的请求数 */
  get inFlightCount(): number {
    return this.inFlight;
  }
}
