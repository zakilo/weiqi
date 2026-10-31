/**
 * 访问安全辅助:回环判定 + 浏览器同源判定。
 * 后端只监听回环网卡(见 config.host),公网流量一律经 nginx / 隧道进来,
 * 因此这里区分"本机诊断"与"外部请求",对外屏蔽内部路径、拦截跨站写操作。
 */
import type { IncomingMessage } from 'node:http';

/** 去掉 IPv4-mapped IPv6 前缀(::ffff:127.0.0.1 → 127.0.0.1) */
function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower;
}

/**
 * 请求是否来自本机。
 * 后端只监听回环,远程用户是经 nginx 反代进来的(socket 地址恒为 127.0.0.1),
 * 因此以 nginx 覆写的 X-Real-IP 为准;直连后端时(无该头)回落到 socket 地址。
 */
export function isLoopback(req: IncomingMessage): boolean {
  const forwarded = req.headers?.['x-real-ip'];
  const single = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = normalizeIp(single || req.socket?.remoteAddress || '');
  if (ip === '::1' || ip === 'localhost') return true;
  return ip.startsWith('127.');
}

/** 取 URL 的 host(含端口);解析失败返回 null */
function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 浏览器发起的写请求是否同源。
 *  - 无 Origin 也无 Referer:视为非浏览器客户端(curl / 脚本),放行
 *  - 有 Origin/Referer 但主机与当前 Host 不一致:视为跨站伪造(CSRF),拒绝
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const target = req.headers.host?.toLowerCase();
  if (!target) return false;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const source = origin ?? referer;
  if (!source) return true;
  const single = Array.isArray(source) ? source[0] : source;
  if (!single) return true;
  return hostOf(single) === target;
}
