/**
 * RemoteAnalysisClient:同 AnalysisClient 的对外形状(ensure / analyze / stop / callbacks.onSnapshot),
 * 但持续分析走远端服务。回放视角转成从空盘起的完整手顺 + komi 请求;
 * 变化线直接由响应的 candidate.pv 提供,无需单独请求。
 * 新请求自动中止旧请求;stop() 通过 AbortController 中断流。
 */
import type { AnalyzeRequest, AnalyzeSnapshot, WireMove } from './protocol';
import type { AnalyzeHandlers, ServiceClient } from './service-client';

/** 回放视角的分析请求(从空盘起的完整手顺 + komi) */
export interface RemoteAnalysisState {
  moves: WireMove[];
  komi: number;
  /** 搜索访问次数上限;缺省用服务端默认值 */
  maxVisits?: number;
}

export interface RemoteAnalysisCallbacks {
  onSnapshot?: (snap: AnalyzeSnapshot) => void;
  onError?: (message: string) => void;
}

export class RemoteAnalysisClient {
  private controller: AbortController | null = null;
  private ready = false;
  private backendLabel = '';
  callbacks: RemoteAnalysisCallbacks = {};

  constructor(private readonly client: ServiceClient) {}

  get isReady(): boolean {
    return this.ready;
  }

  get backend(): string {
    return this.backendLabel;
  }

  /** 探测服务可用性(重复调用安全),返回后端标签 */
  async ensure(): Promise<string> {
    const health = await this.client.health();
    this.ready = health.ok;
    this.backendLabel = health.katagoVersion ? `远端 · ${health.katagoVersion}` : '远端服务';
    return this.backendLabel;
  }

  /** 开始持续分析局面(新请求自动中止旧请求) */
  analyze(state: RemoteAnalysisState): void {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    const request: AnalyzeRequest = {
      moves: state.moves,
      komi: state.komi,
      rules: 'chinese',
      maxVisits: state.maxVisits,
    };
    const handlers: AnalyzeHandlers = {
      onSnapshot: (snap) => {
        if (this.controller === controller) this.callbacks.onSnapshot?.(snap);
      },
      onError: (error) => {
        if (this.controller === controller) this.callbacks.onError?.(error.message);
      },
    };
    void this.client.analyze(request, handlers, controller.signal).catch((error: unknown) => {
      if (this.controller !== controller) return;
      if (error instanceof Error && error.name === 'AbortError') return;
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
    });
  }

  /** 中断当前分析 */
  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** 释放状态 */
  dispose(): void {
    this.stop();
    this.ready = false;
    this.backendLabel = '';
  }
}
