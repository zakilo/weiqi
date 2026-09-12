#!/usr/bin/env node
/**
 * 开发脚本:同时启动后端 AI 服务(node server/index.ts,:8080)与 Vite 前端(:5173)。
 * 前端经 vite.config.ts 的 /api 代理访问后端;局域网设备访问 Vite 打印的 Network 地址。
 * 任一进程退出即整体关闭。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('node:child_process').ChildProcess[]} */
const procs = [];
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    if (!p.killed) p.kill('SIGINT');
  }
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function run(name, command, args) {
  const child = spawn(command, args, { cwd: rootDir, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`[dev] ${name} 退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    shutdown();
  });
  child.on('error', (err) => {
    console.error(`[dev] 无法启动 ${name}: ${err.message}`);
    shutdown();
  });
  procs.push(child);
}

// 后端 AI 服务(Node 原生 TS 类型剥离,直接运行)
run('server', process.execPath, ['server/index.ts']);

// 前端 Vite(优先使用本地 .bin,回退到 PATH 中的 vite)
const viteBin = resolve(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
if (existsSync(viteBin)) {
  run('vite', viteBin, []);
} else {
  run('vite', 'vite', []);
}
