/**
 * dist/ 静态资源托管(生产环境):MIME 映射、路径穿越防护、SPA 回退。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** 托管一个静态文件;返回是否已处理(总为 true) */
export function serveStatic(distDir: string, urlPath: string, res: ServerResponse): boolean {
  let pathname = urlPath;
  const q = pathname.indexOf('?');
  if (q >= 0) pathname = pathname.slice(0, q);
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    pathname = '/';
  }
  if (pathname === '' || pathname === '/') pathname = '/index.html';

  const root = resolve(distDir);
  const normalized = normalize(pathname).replace(/^([/\\])+/, '');
  const target = resolve(root, normalized);
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }

  let file = target;
  if (!existsSync(file) || !statSync(file).isFile()) {
    file = resolve(root, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return true;
    }
  }

  const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const stat = statSync(file);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
  createReadStream(file).pipe(res);
  return true;
}
