/**
 * 服务端配置:优先级 env > ai.config.json > 默认值。
 * 配置文件默认位于项目根目录 ai.config.json,可用 AI_CONFIG 环境变量覆盖路径。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ModelConfig {
  /** 唯一 id(缓存/路由键) */
  id: string;
  /** 显示名称 */
  name: string;
  /** 模型文件(相对 modelDir 或绝对路径) */
  file: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** KataGo 可执行文件(PATH 命令名或绝对路径) */
  katagoPath: string;
  /** 模型目录(相对项目根或绝对路径) */
  modelDir: string;
  models: ModelConfig[];
  /** 当前激活模型 id */
  activeModel: string | null;
  /** Human-SL 人类风格模型文件(相对 modelDir 或绝对路径);null 表示禁用 */
  humanModelFile: string | null;
  /** 贴目(仅 warmup 用;真实对局 komi 由客户端随请求携带 KOMI_AREA) */
  komi: number;
  /** 默认搜索访问次数上限 */
  maxVisitsDefault: number;
  numAnalysisThreads: number;
  /** 单次搜索使用的 CPU 线程数(KataGo analysis 必填) */
  numSearchThreads: number;
  nnMaxBatchSize: number;
  reportDuringSearchEvery: number;
  analysisPVLen: number;
  /** 每实例并发进行中的请求数上限 */
  maxInFlightPerEngine: number;
  /** 每实例等待队列上限 */
  maxQueuePerEngine: number;
  /** 排队超时(ms) */
  queueTimeoutMs: number;
  /** 单次查询超时(ms) */
  requestTimeoutMs: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 8080,
  // 只监听回环:公网访问一律经 nginx / 隧道转发,避免 AI 接口被直连扫描
  host: '127.0.0.1',
  katagoPath: 'katago',
  modelDir: './models',
  models: [],
  activeModel: null,
  humanModelFile: 'b18c384nbt-humanv0.bin.gz',
  komi: 3.5,
  maxVisitsDefault: 200,
  numAnalysisThreads: 4,
  numSearchThreads: 4,
  nnMaxBatchSize: 8,
  reportDuringSearchEvery: 40,
  analysisPVLen: 15,
  maxInFlightPerEngine: 1,
  maxQueuePerEngine: 8,
  queueTimeoutMs: 60_000,
  requestTimeoutMs: 120_000,
};

/** 项目根目录(server/ 的上一级) */
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface LoadConfigOptions {
  /** 配置文件路径(默认 env.AI_CONFIG 或 <root>/ai.config.json) */
  configPath?: string;
  /** 环境变量来源(默认 process.env) */
  env?: Record<string, string | undefined>;
  /** 项目根目录(用于解析相对路径) */
  rootDir?: string;
}

function readConfigFile(path: string): Partial<ServerConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<ServerConfig>;
  } catch (e) {
    throw new Error(`无法解析配置文件 ${path}: ${String(e)}`);
  }
}

function toNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeModels(value: unknown): ModelConfig[] {
  if (!Array.isArray(value)) return [];
  const models: ModelConfig[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string' || typeof m.file !== 'string') continue;
    models.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      file: m.file,
    });
  }
  return models;
}

/** 载入并合并配置(env 覆盖文件覆盖默认值) */
export function loadConfig(options: LoadConfigOptions = {}): ServerConfig {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? ROOT_DIR;
  const configPath = options.configPath ?? env.AI_CONFIG ?? resolve(rootDir, 'ai.config.json');
  const file = readConfigFile(configPath);

  const merged: ServerConfig = {
    port: toNumber(file.port, DEFAULT_CONFIG.port),
    host: typeof file.host === 'string' ? file.host : DEFAULT_CONFIG.host,
    katagoPath: typeof file.katagoPath === 'string' ? file.katagoPath : DEFAULT_CONFIG.katagoPath,
    modelDir: typeof file.modelDir === 'string' ? file.modelDir : DEFAULT_CONFIG.modelDir,
    models: normalizeModels(file.models),
    activeModel: typeof file.activeModel === 'string' ? file.activeModel : DEFAULT_CONFIG.activeModel,
    humanModelFile:
      typeof file.humanModelFile === 'string'
        ? file.humanModelFile
        : file.humanModelFile === null
          ? null
          : DEFAULT_CONFIG.humanModelFile,
    komi: toNumber(file.komi, DEFAULT_CONFIG.komi),
    maxVisitsDefault: toNumber(file.maxVisitsDefault, DEFAULT_CONFIG.maxVisitsDefault),
    numAnalysisThreads: toNumber(file.numAnalysisThreads, DEFAULT_CONFIG.numAnalysisThreads),
    numSearchThreads: toNumber(file.numSearchThreads, DEFAULT_CONFIG.numSearchThreads),
    nnMaxBatchSize: toNumber(file.nnMaxBatchSize, DEFAULT_CONFIG.nnMaxBatchSize),
    reportDuringSearchEvery: toNumber(file.reportDuringSearchEvery, DEFAULT_CONFIG.reportDuringSearchEvery),
    analysisPVLen: toNumber(file.analysisPVLen, DEFAULT_CONFIG.analysisPVLen),
    maxInFlightPerEngine: toNumber(file.maxInFlightPerEngine, DEFAULT_CONFIG.maxInFlightPerEngine),
    maxQueuePerEngine: toNumber(file.maxQueuePerEngine, DEFAULT_CONFIG.maxQueuePerEngine),
    queueTimeoutMs: toNumber(file.queueTimeoutMs, DEFAULT_CONFIG.queueTimeoutMs),
    requestTimeoutMs: toNumber(file.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs),
  };

  // 环境变量覆盖
  if (env.KATAGO_PATH) merged.katagoPath = env.KATAGO_PATH;
  if (env.KATAGO_MODEL_DIR) merged.modelDir = env.KATAGO_MODEL_DIR;
  if (env.AI_PORT) merged.port = toNumber(env.AI_PORT, merged.port);
  if (env.AI_HOST) merged.host = env.AI_HOST;
  if (env.AI_ACTIVE_MODEL) merged.activeModel = env.AI_ACTIVE_MODEL;
  // 空字符串表示禁用 human 模型
  if (env.AI_HUMAN_MODEL !== undefined) {
    merged.humanModelFile = env.AI_HUMAN_MODEL === '' ? null : env.AI_HUMAN_MODEL;
  }

  // 相对路径基于项目根解析
  merged.modelDir = isAbsolute(merged.modelDir) ? merged.modelDir : resolve(rootDir, merged.modelDir);

  return merged;
}

/** 模型文件绝对路径 */
export function resolveModelPath(config: ServerConfig, model: ModelConfig): string {
  return isAbsolute(model.file) ? model.file : resolve(config.modelDir, model.file);
}

/** Human-SL 人类风格模型绝对路径;未配置返回 null */
export function resolveHumanModelPath(config: ServerConfig): string | null {
  const file = config.humanModelFile;
  if (typeof file !== 'string' || file.length === 0) return null;
  return isAbsolute(file) ? file : resolve(config.modelDir, file);
}
