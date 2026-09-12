/**
 * 由 ServerConfig 生成临时 KataGo analysis 配置文件,供 `-config` 使用。
 *  - renderAnalysisConfig:生成配置文本(纯函数,可单测)。
 *  - createAnalysisConfig:写入临时目录,返回 { path, dispose }。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '../config.ts';

/** 生成 analysis 配置文本 */
export function renderAnalysisConfig(config: ServerConfig, maxVisits: number): string {
  const lines = [
    '# 由 weiqi server 自动生成(无需手动编辑)',
    `numAnalysisThreads = ${Math.max(1, Math.floor(config.numAnalysisThreads))}`,
    `numSearchThreads = ${Math.max(1, Math.floor(config.numSearchThreads))}`,
    `nnMaxBatchSize = ${Math.max(1, Math.floor(config.nnMaxBatchSize))}`,
    `maxVisits = ${Math.max(1, Math.floor(maxVisits))}`,
    `reportDuringSearchEvery = ${Math.max(1, Math.floor(config.reportDuringSearchEvery))}`,
    `analysisPVLen = ${Math.max(1, Math.floor(config.analysisPVLen))}`,
  ];
  return `${lines.join('\n')}\n`;
}

export interface TempConfig {
  path: string;
  dispose: () => void;
}

/** 写入临时 analysis 配置文件;dispose 清理临时目录 */
export function createAnalysisConfig(config: ServerConfig, maxVisits: number): TempConfig {
  const dir = mkdtempSync(join(tmpdir(), 'weiqi-katago-'));
  const path = join(dir, 'analysis.cfg');
  writeFileSync(path, renderAnalysisConfig(config, maxVisits), 'utf8');
  return {
    path,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败忽略
      }
    },
  };
}
