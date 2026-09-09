/**
 * 主线程分析客户端:管理 Worker 生命周期,
 * 把持续分析/变化线请求转发到 Worker 并分发回报。
 * 新请求自动作废旧请求(Worker 侧按代际处理)。
 */
import { AnalysisSnapshot, AnalysisState, requestToWire, WorkerIn, WorkerOut } from './analysis-engine';

export interface AnalysisCallbacks {
  onSnapshot?: (snap: AnalysisSnapshot) => void;
  onVariationStep?: (move: number, index: number) => void;
  onVariationDone?: (line: number[]) => void;
  onError?: (message: string) => void;
}

export class AnalysisClient {
  private worker: Worker | null = null;
  private ready = false;
  private backendLabel = '';
  private initPromise: Promise<string> | null = null;
  private nextId = 0;
  private currentAnalyzeId = 0;
  private currentVariationId = 0;
  callbacks: AnalysisCallbacks = {};

  /** @param workerFactory Worker 工厂(测试可注入假实现) */
  constructor(private readonly workerFactory: () => Worker = createAnalysisWorker) {}

  get isReady(): boolean {
    return this.ready;
  }

  get backend(): string {
    return this.backendLabel;
  }

  /** 启动 Worker 并加载模型字节(重复调用安全,并发等待同一初始化) */
  ensure(modelBytes: ArrayBuffer): Promise<string> {
    if (this.ready) return Promise.resolve(this.backendLabel);
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise<string>((resolve, reject) => {
      try {
        this.worker = this.workerFactory();
      } catch (err) {
        this.initPromise = null;
        reject(err);
        return;
      }
      this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          this.ready = true;
          this.backendLabel = msg.backend;
          resolve(msg.backend);
          return;
        }
        if (msg.type === 'error' && msg.id === null) {
          this.initPromise = null;
          reject(new Error(msg.message));
          return;
        }
        this.handle(msg);
      };
      this.worker.onerror = (e) => {
        this.initPromise = null;
        reject(new Error(e.message || '分析 Worker 启动失败'));
      };
      this.worker.postMessage({ type: 'init', modelBytes } satisfies WorkerIn);
    });
    return this.initPromise;
  }

  /** 开始持续分析局面(新请求自动作废旧请求) */
  analyze(state: AnalysisState): void {
    if (!this.ready || !this.worker) return;
    const id = ++this.nextId;
    this.currentAnalyzeId = id;
    this.worker.postMessage({ type: 'analyze', id, request: requestToWire(state) } satisfies WorkerIn);
  }

  /** 展开变化线:firstMove 后双方按最优着法互搏 depth 步 */
  requestVariation(state: AnalysisState, startMove: number, depth: number, perMovePlayouts: number): void {
    if (!this.ready || !this.worker) return;
    const id = ++this.nextId;
    this.currentVariationId = id;
    this.worker.postMessage({
      type: 'variation',
      id,
      request: requestToWire(state),
      startMove,
      depth,
      perMovePlayouts,
    } satisfies WorkerIn);
  }

  /** 停止所有进行中的任务 */
  stop(): void {
    this.currentAnalyzeId = 0;
    this.currentVariationId = 0;
    this.worker?.postMessage({ type: 'stop' } satisfies WorkerIn);
  }

  /** 终止 Worker(释放后端资源) */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.backendLabel = '';
    this.initPromise = null;
  }

  private handle(msg: WorkerOut): void {
    switch (msg.type) {
      case 'snapshot':
        if (msg.id === this.currentAnalyzeId) this.callbacks.onSnapshot?.(msg.snapshot);
        break;
      case 'variation-step':
        if (msg.id === this.currentVariationId) this.callbacks.onVariationStep?.(msg.move, msg.index);
        break;
      case 'variation-done':
        if (msg.id === this.currentVariationId) this.callbacks.onVariationDone?.(msg.line);
        break;
      case 'error':
        this.callbacks.onError?.(msg.message);
        break;
      case 'ready':
        break;
    }
  }
}

/** 默认 Worker 工厂(Vite 模块 Worker) */
function createAnalysisWorker(): Worker {
  return new Worker(new URL('./analysis-worker.ts', import.meta.url), { type: 'module' });
}
