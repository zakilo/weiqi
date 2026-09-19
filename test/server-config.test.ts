import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, resolveHumanModelPath, resolveModelPath } from '../server/config.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weiqi-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, data: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  return path;
}

describe('loadConfig 默认值', () => {
  it('无配置文件时使用默认值,模型目录解析为绝对路径', () => {
    const cfg = loadConfig({ configPath: join(dir, 'missing.json'), env: {}, rootDir: dir });
    expect(cfg.port).toBe(DEFAULT_CONFIG.port);
    expect(cfg.host).toBe(DEFAULT_CONFIG.host);
    expect(cfg.katagoPath).toBe(DEFAULT_CONFIG.katagoPath);
    expect(cfg.modelDir).toBe(resolve(dir, DEFAULT_CONFIG.modelDir));
    expect(cfg.models).toEqual([]);
    expect(cfg.activeModel).toBeNull();
    expect(cfg.humanModelFile).toBe(DEFAULT_CONFIG.humanModelFile);
    expect(cfg.komi).toBe(DEFAULT_CONFIG.komi);
  });

  it('非法数值回退到默认值', () => {
    const path = writeConfig('ai.json', { port: 'not-a-number', komi: 'x' });
    const cfg = loadConfig({ configPath: path, env: {}, rootDir: dir });
    expect(cfg.port).toBe(DEFAULT_CONFIG.port);
    expect(cfg.komi).toBe(DEFAULT_CONFIG.komi);
  });
});

describe('loadConfig 文件合并', () => {
  it('文件覆盖默认值,未提供项保留默认', () => {
    const path = writeConfig('ai.json', {
      port: 9000,
      komi: 7.5,
      models: [{ id: 'm', file: 'm.bin.gz' }],
    });
    const cfg = loadConfig({ configPath: path, env: {}, rootDir: dir });
    expect(cfg.port).toBe(9000);
    expect(cfg.komi).toBe(7.5);
    expect(cfg.models).toEqual([{ id: 'm', name: 'm', file: 'm.bin.gz' }]);
    expect(cfg.maxVisitsDefault).toBe(DEFAULT_CONFIG.maxVisitsDefault);
  });

  it('models 规范化:跳过缺少 id/file 的项,name 缺省取 id', () => {
    const path = writeConfig('ai.json', {
      models: [
        { id: 'a', file: 'a.gz' },
        { id: 'b' },
        { file: 'c.gz' },
        null,
        42,
        { id: 'd', file: 'd.gz', name: 'D' },
      ],
    });
    const cfg = loadConfig({ configPath: path, env: {}, rootDir: dir });
    expect(cfg.models).toEqual([
      { id: 'a', name: 'a', file: 'a.gz' },
      { id: 'd', name: 'D', file: 'd.gz' },
    ]);
  });

  it('humanModelFile 可被文件覆盖,置 null 禁用', () => {
    const path = writeConfig('ai.json', { humanModelFile: 'custom-human.bin.gz' });
    const cfg = loadConfig({ configPath: path, env: {}, rootDir: dir });
    expect(cfg.humanModelFile).toBe('custom-human.bin.gz');

    const off = writeConfig('off.json', { humanModelFile: null });
    expect(loadConfig({ configPath: off, env: {}, rootDir: dir }).humanModelFile).toBeNull();
  });

  it('非法 JSON 抛出错误', () => {
    const path = writeConfig('bad.json', '{ not json');
    expect(() => loadConfig({ configPath: path, env: {}, rootDir: dir })).toThrow(/无法解析/);
  });
});

describe('loadConfig 环境变量覆盖', () => {
  it('env 覆盖文件值', () => {
    const path = writeConfig('ai.json', {
      katagoPath: '/from/file/katago',
      port: 9000,
      activeModel: 'fileModel',
    });
    const env = {
      KATAGO_PATH: '/from/env/katago',
      KATAGO_MODEL_DIR: '/abs/env-models',
      AI_PORT: '7777',
      AI_ACTIVE_MODEL: 'envModel',
    };
    const cfg = loadConfig({ configPath: path, env, rootDir: dir });
    expect(cfg.katagoPath).toBe('/from/env/katago');
    expect(cfg.modelDir).toBe('/abs/env-models');
    expect(cfg.port).toBe(7777);
    expect(cfg.activeModel).toBe('envModel');
  });

  it('AI_HUMAN_MODEL 覆盖,空字符串禁用', () => {
    const base = { configPath: join(dir, 'missing.json'), rootDir: dir };
    const cfg = loadConfig({ ...base, env: { AI_HUMAN_MODEL: '/x/h.bin.gz' } });
    expect(cfg.humanModelFile).toBe('/x/h.bin.gz');
    const off = loadConfig({ ...base, env: { AI_HUMAN_MODEL: '' } });
    expect(off.humanModelFile).toBeNull();
  });

  it('相对模型目录基于 rootDir 解析', () => {
    const cfg = loadConfig({
      configPath: join(dir, 'missing.json'),
      env: { KATAGO_MODEL_DIR: 'rel/dir' },
      rootDir: dir,
    });
    expect(cfg.modelDir).toBe(resolve(dir, 'rel/dir'));
  });

  it('AI_CONFIG 指定配置文件路径', () => {
    const path = writeConfig('custom.json', { port: 4321 });
    const cfg = loadConfig({ env: { AI_CONFIG: path }, rootDir: dir });
    expect(cfg.port).toBe(4321);
  });
});

describe('resolveModelPath', () => {
  const cfg = { ...DEFAULT_CONFIG, modelDir: '/abs/models' };

  it('相对文件名拼接到 modelDir', () => {
    expect(resolveModelPath(cfg, { id: 'x', name: 'x', file: 'x.gz' })).toBe(resolve('/abs/models', 'x.gz'));
  });

  it('绝对路径原样返回', () => {
    expect(resolveModelPath(cfg, { id: 'x', name: 'x', file: '/other/y.gz' })).toBe('/other/y.gz');
  });
});

describe('resolveHumanModelPath', () => {
  const cfg = { ...DEFAULT_CONFIG, modelDir: '/abs/models' };

  it('默认文件名拼接到 modelDir', () => {
    expect(resolveHumanModelPath(cfg)).toBe(
      resolve('/abs/models', DEFAULT_CONFIG.humanModelFile as string),
    );
  });

  it('绝对路径原样返回', () => {
    expect(resolveHumanModelPath({ ...cfg, humanModelFile: '/x/h.bin.gz' })).toBe('/x/h.bin.gz');
  });

  it('未配置或空字符串返回 null', () => {
    expect(resolveHumanModelPath({ ...cfg, humanModelFile: null })).toBeNull();
    expect(resolveHumanModelPath({ ...cfg, humanModelFile: '' })).toBeNull();
  });
});
