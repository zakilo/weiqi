/**
 * 安全层单测:回环判定、CSRF 同源校验、外部请求路径屏蔽。
 */
import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isLoopback, isSameOrigin } from '../server/security.ts';
import { handleApi } from '../server/api.ts';
import type { EngineManager } from '../server/engine/manager.ts';
import type { ServiceStatus } from '../src/engine/remote/protocol.ts';

function req(opts: {
  method?: string;
  remote?: string;
  host?: string;
  origin?: string;
  referer?: string;
  realIp?: string;
}): IncomingMessage {
  const headers: Record<string, string> = { host: opts.host ?? 'localhost:8080' };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.referer) headers.referer = opts.referer;
  if (opts.realIp) headers['x-real-ip'] = opts.realIp;
  return {
    method: opts.method ?? 'GET',
    headers,
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

/** 收集 sendJson 输出的最小 res 桩 */
function fakeRes(): { res: ServerResponse; sent(): { status: number; body: Record<string, unknown> } } {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(body?: string) {
      text = body ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  return { res, sent: () => ({ status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }) };
}

const statusFixture: ServiceStatus = {
  engines: [],
  active: 'b18',
  queue: { active: 0, queued: 0, rejected: 0 },
  config: {
    katagoPath: '/usr/local/bin/katago',
    modelDir: '/Users/me/weiqi/models',
    humanModelPath: '/Users/me/weiqi/models/human.bin.gz',
    humanModelExists: true,
  },
};

const manager = {
  health: () => ({
    ok: true,
    katagoPath: '/usr/local/bin/katago',
    katagoVersion: 'KataGo v1.18.2',
    activeModel: 'b18',
  }),
  status: () => statusFixture,
  listModels: () => [],
  activeModel: 'b18',
} as unknown as EngineManager;

async function call(request: IncomingMessage, path: string) {
  const { res, sent } = fakeRes();
  const url = new URL(path, `http://${request.headers.host}`);
  const handled = await handleApi(request, res, url, { manager, katagoVersion: 'KataGo v1.18.2' });
  return { handled, ...sent() };
}

describe('isLoopback', () => {
  it('识别 127.* / ::1 / IPv4-mapped 回环', () => {
    expect(isLoopback(req({ remote: '127.0.0.1' }))).toBe(true);
    expect(isLoopback(req({ remote: '127.0.0.2' }))).toBe(true);
    expect(isLoopback(req({ remote: '::1' }))).toBe(true);
    expect(isLoopback(req({ remote: '::ffff:127.0.0.1' }))).toBe(true);
  });
  it('局域网与公网地址不算回环', () => {
    expect(isLoopback(req({ remote: '192.0.2.71' }))).toBe(false);
    expect(isLoopback(req({ remote: '2001:db8:5678:1::1' }))).toBe(false);
    // socket 未就绪(极端情况)按外部处理
    expect(isLoopback({ socket: {} } as unknown as IncomingMessage)).toBe(false);
  });
  it('经 nginx 反代时以 X-Real-IP 判定真实来源', () => {
    // socket 永远是 127.0.0.1,但远程用户要识别为非本机
    expect(isLoopback(req({ realIp: '192.0.2.71' }))).toBe(false);
    expect(isLoopback(req({ realIp: '203.0.113.9' }))).toBe(false);
    expect(isLoopback(req({ realIp: '127.0.0.1' }))).toBe(true);
    expect(isLoopback(req({ realIp: '::1' }))).toBe(true);
  });
});

describe('isSameOrigin', () => {
  it('无 Origin/Referer 的非浏览器客户端放行', () => {
    expect(isSameOrigin(req({ method: 'POST' }))).toBe(true);
  });
  it('同源通过,跨站拒绝', () => {
    expect(isSameOrigin(req({ method: 'POST', origin: 'http://localhost:8080' }))).toBe(true);
    expect(isSameOrigin(req({ method: 'POST', origin: 'http://evil.example' }))).toBe(false);
    expect(isSameOrigin(req({ method: 'POST', referer: 'http://localhost:8080/index.html' }))).toBe(true);
    expect(isSameOrigin(req({ method: 'POST', referer: 'http://evil.example/x' }))).toBe(false);
  });
  it('按含端口的 host 比较,协议大小写不敏感', () => {
    expect(isSameOrigin(req({ host: 'GO.EXAMPLE.COM', origin: 'https://go.example.com' }))).toBe(true);
    expect(isSameOrigin(req({ host: 'go.example.com', origin: 'https://go.example.com:443' }))).toBe(true);
    expect(isSameOrigin(req({ host: 'go.example.com', origin: 'https://evil.example' }))).toBe(false);
  });
});

describe('handleApi 安全行为', () => {
  it('跨站写请求返回 403', async () => {
    const r = await call(req({ method: 'POST', origin: 'http://evil.example' }), '/api/ai/think');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(403);
  });

  it('同源写请求不被 CSRF 拦截(走到参数校验)', async () => {
    const r = await call(req({ method: 'POST', origin: 'http://localhost:8080' }), '/api/unknown');
    expect(r.status).toBe(404);
  });

  it('外部请求的 /api/health 屏蔽 katagoPath,本机保留', async () => {
    const remote = await call(req({ remote: '203.0.113.9' }), '/api/health');
    expect(remote.status).toBe(200);
    expect(remote.body.katagoPath).toBeUndefined();
    expect(remote.body.ok).toBe(true);
    // 反代进来的远程用户(socket 是 127.0.0.1)同样屏蔽
    const proxied = await call(req({ realIp: '192.0.2.71' }), '/api/health');
    expect(proxied.body.katagoPath).toBeUndefined();
    const local = await call(req({}), '/api/health');
    expect(local.body.katagoPath).toBe('/usr/local/bin/katago');
  });

  it('外部请求的 /api/status 屏蔽全部本机路径', async () => {
    const r = await call(req({ remote: '192.0.2.71' }), '/api/status');
    const config = r.body.config as Record<string, unknown>;
    expect(config.katagoPath).toBeUndefined();
    expect(config.modelDir).toBeUndefined();
    expect(config.humanModelPath).toBeUndefined();
    expect(config.humanModelExists).toBe(true);
    expect(r.body.queue).toEqual({ active: 0, queued: 0, rejected: 0 });
    const local = await call(req({}), '/api/status');
    expect((local.body.config as Record<string, unknown>).modelDir).toBe('/Users/me/weiqi/models');
  });
});
