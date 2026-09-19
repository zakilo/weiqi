/**
 * KataGo analysis 子进程封装:
 *  - spawn(katagoPath, ['analysis', '-config', cfg, '-model', model])(可选追加 -human-model)
 *  - stdin 写 JSON 行;stdout 按行分帧,按 id 匹配 pending Promise
 *  - isDuringSearch 的中间报文转发给 onReport,最终报文 resolve
 *  - stderr 收集为日志
 * spawn 通过依赖注入以便单测使用假进程。
 */
import type { AnalysisQuery, AnalysisResponse } from './protocol.ts';

/** 最小化子进程 IO 接口(便于用 EventEmitter 伪造) */
export interface SpawnedProcess {
  pid?: number;
  stdin: { write(chunk: string): unknown } | null;
  stdout: { on(event: string, listener: (...args: unknown[]) => void): unknown } | null;
  stderr: { on(event: string, listener: (...args: unknown[]) => void): unknown } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): unknown;
}

export type StdioMode = 'pipe' | 'ignore' | 'inherit';

export interface SpawnOptions {
  stdio?: StdioMode[];
  cwd?: string;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

export interface RunOptions {
  /** 中间报文(搜索进行中)回调 */
  onReport?: (response: AnalysisResponse) => void;
  /** 超时(ms),<=0 表示不超时 */
  timeoutMs?: number;
}

/** 进程抽象(供 EngineInstance 依赖注入) */
export interface KatagoProcessLike {
  readonly pid: number | null;
  readonly running: boolean;
  start(): void;
  run(query: AnalysisQuery, options?: RunOptions): Promise<AnalysisResponse>;
  stop(): void;
}

interface Pending {
  resolve: (response: AnalysisResponse) => void;
  reject: (error: Error) => void;
  onReport?: (response: AnalysisResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface NodeKatagoProcessOptions {
  katagoPath: string;
  configPath: string;
  modelPath: string;
  /** Human-SL 人类风格模型路径;设置后追加 -human-model 参数 */
  humanModelPath?: string | null;
  spawn: SpawnFn;
  onLog?: (line: string) => void;
}

export class NodeKatagoProcess implements KatagoProcessLike {
  private child: SpawnedProcess | null = null;
  private stopping = false;
  private nextId = 1;
  private stdoutBuf = '';
  private readonly pending = new Map<string, Pending>();
  private readonly logBuffer: string[] = [];
  private readonly options: NodeKatagoProcessOptions;

  constructor(options: NodeKatagoProcessOptions) {
    this.options = options;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** 最近收集的 stderr 日志(便于上游诊断) */
  get logs(): readonly string[] {
    return this.logBuffer;
  }

  /** 启动进程(幂等) */
  start(): void {
    if (this.child) return;
    this.stopping = false;
    this.stdoutBuf = '';
    const args = ['analysis', '-config', this.options.configPath, '-model', this.options.modelPath];
    if (this.options.humanModelPath) args.push('-human-model', this.options.humanModelPath);
    const child = this.options.spawn(this.options.katagoPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk) => this.onStdout(String(chunk)));
    child.stderr?.on('data', (chunk) => this.onStderr(String(chunk)));
    child.on('error', (err: unknown) => this.failAll(toError(err)));
    child.on('exit', (code: unknown, signal: unknown) => this.onExit(code, signal));
  }

  /** 发送一条查询;返回最终报文(中间报文经 onReport 转发) */
  run(query: AnalysisQuery, options: RunOptions = {}): Promise<AnalysisResponse> {
    return new Promise<AnalysisResponse>((resolve, reject) => {
      const child = this.child;
      if (!child || !child.stdin) {
        reject(new Error('KataGo 进程未运行'));
        return;
      }
      const id = `q${this.nextId++}`;
      const payload = JSON.stringify({ id, ...query });
      const timeoutMs = options.timeoutMs ?? 0;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(id)) reject(new Error(`查询超时(${timeoutMs}ms)`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, onReport: options.onReport, timer });
      try {
        child.stdin.write(`${payload}\n`);
      } catch (e) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(toError(e));
      }
    });
  }

  /** 停止进程并拒绝所有未完成查询 */
  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.failAll(new Error('引擎已停止'));
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 忽略
      }
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx = this.stdoutBuf.indexOf('\n');
    while (idx >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line) this.handleLine(line);
      idx = this.stdoutBuf.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let msg: AnalysisResponse;
    try {
      msg = JSON.parse(line) as AnalysisResponse;
    } catch {
      this.pushLog(`无法解析响应: ${line}`);
      return;
    }
    if (msg.id === undefined) return;
    const key = String(msg.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    if (typeof msg.error === 'string' && msg.error.length > 0) {
      this.pending.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(`KataGo 拒绝查询:${msg.error}`));
      return;
    }
    if (msg.isDuringSearch) {
      pending.onReport?.(msg);
      return;
    }
    this.pending.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  private onStderr(chunk: string): void {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      if (line) this.pushLog(line);
    }
  }

  private onExit(code: unknown, signal: unknown): void {
    this.child = null;
    if (this.stopping) return;
    const reason = signal ? `信号 ${String(signal)}` : `退出码 ${String(code)}`;
    this.failAll(new Error(`KataGo 进程已退出(${reason})`));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private pushLog(line: string): void {
    this.logBuffer.push(line);
    if (this.logBuffer.length > 200) this.logBuffer.shift();
    this.options.onLog?.(line);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
