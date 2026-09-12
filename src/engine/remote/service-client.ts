/**
 * AI 服务 HTTP 客户端:封装 /api/health|models|status、think、analyze(NDJSON 流)。
 * 浏览器与后端同源(开发经 Vite 代理,生产由 Node 托管),故 baseUrl 默认空。
 */
import type {
  AnalyzeRequest,
  AnalyzeSnapshot,
  HealthResponse,
  ModelActionResponse,
  ModelsResponse,
  ServiceStatus,
  ThinkRequest,
  ThinkResult,
} from './protocol';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

async function errorMessage(resp: Response): Promise<string> {
  let text = '';
  try {
    text = await resp.text();
  } catch {
    return `HTTP ${resp.status}`;
  }
  if (!text) return `HTTP ${resp.status}`;
  try {
    const data = JSON.parse(text) as { error?: unknown };
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // 非 JSON,直接用原文
  }
  return text;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export interface AnalyzeHandlers {
  onSnapshot: (snapshot: AnalyzeSnapshot) => void;
  onError?: (error: Error) => void;
}

export class ServiceClient {
  constructor(private readonly baseUrl = '') {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const resp = await fetch(this.url(path), { signal });
    if (!resp.ok) throw new Error(await errorMessage(resp));
    return (await resp.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const resp = await fetch(this.url(path), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) throw new Error(await errorMessage(resp));
    return (await resp.json()) as T;
  }

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.getJson<HealthResponse>('/api/health', signal);
  }

  models(signal?: AbortSignal): Promise<ModelsResponse> {
    return this.getJson<ModelsResponse>('/api/models', signal);
  }

  status(signal?: AbortSignal): Promise<ServiceStatus> {
    return this.getJson<ServiceStatus>('/api/status', signal);
  }

  loadModel(id: string, signal?: AbortSignal): Promise<ModelActionResponse> {
    return this.postJson<ModelActionResponse>(`/api/models/${encodeURIComponent(id)}/load`, {}, signal);
  }

  unloadModel(id: string, signal?: AbortSignal): Promise<ModelActionResponse> {
    return this.postJson<ModelActionResponse>(`/api/models/${encodeURIComponent(id)}/unload`, {}, signal);
  }

  activateModel(id: string, signal?: AbortSignal): Promise<ModelActionResponse> {
    return this.postJson<ModelActionResponse>(`/api/models/${encodeURIComponent(id)}/activate`, {}, signal);
  }

  think(request: ThinkRequest, signal?: AbortSignal): Promise<ThinkResult> {
    return this.postJson<ThinkResult>('/api/ai/think', request, signal);
  }

  /** 持续分析:按行解析 NDJSON;signal 触发即中止并抛 AbortError */
  async analyze(request: AnalyzeRequest, handlers: AnalyzeHandlers, signal?: AbortSignal): Promise<void> {
    const resp = await fetch(this.url('/api/ai/analyze'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
      signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(await errorMessage(resp));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) handleLine(line, handlers);
          idx = buffer.indexOf('\n');
        }
      }
      const tail = buffer.trim();
      if (tail) handleLine(tail, handlers);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

function handleLine(line: string, handlers: AnalyzeHandlers): void {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg && typeof msg === 'object' && 'error' in msg) {
    handlers.onError?.(new Error(String((msg as { error: unknown }).error)));
    return;
  }
  handlers.onSnapshot(msg as AnalyzeSnapshot);
}
