# 后端架构（Node + KataGo 服务）

> 本文档描述 `server/` 目录的分层结构、模块职责、请求调用链与关键契约。
> 前端部分见 [frontend.md](./frontend.md);面向 AI 助手的项目总览与约定见 [../AGENTS.md](../AGENTS.md);人类可读说明见 [../../README.md](../../README.md)。

## 1. 概述与职责边界

后端是一个**零额外运行时依赖**的 Node HTTP 服务（仅用 `node:http`、`node:child_process`、`node:fs` 等内置模块），承担以下职责：

- 以 `spawn` 方式拉起本机已安装的 **KataGo 可执行文件**（`katago analysis`，**每个模型一个进程**），通过 **JSON 行协议**与其通信；
- 对浏览器/局域网客户端暴露统一的 HTTP `/api/*` 接口，是**唯一持有 AI 推理能力**的进程；
- 提供模型**加载 / 卸载 / 切换**、运行状态查看、**并发队列与限流**；
- 生产模式下同时**静态托管** `dist/` 前端产物。

客户端**不加载任何 AI 模型**：棋盘逻辑与界面在前端，坐标转换与推理全在后端。

```
浏览器 (src/)  ──HTTP /api/ai/*、/api/models|status|health──▶  Node 后端 (server/)
                                                                    │ spawn
                                                                    ▼
                                                          katago analysis（JSON 行协议）
```

## 2. 技术栈与运行方式

- **语言**：TypeScript，ESM（根 `package.json` 为 `"type": "module"`）。
- **运行方式**：`node server/index.ts` 直接运行，依赖 **Node 原生 TypeScript 类型剥离**（需较新 Node 版本）。
  - 因此 `server/` **内部相对导入必须带 `.ts` 后缀**（`tsconfig` 开启 `allowImportingTsExtensions` + `noEmit`）；前端 `src/` 内部导入**不带**后缀。
  - 避免使用无法被「类型剥离」的语法：`enum`、`namespace`、构造函数参数属性等（用显式字段声明 + 联合类型常量代替）。
- **端口**：默认 `8080`（可用 `AI_PORT` / 配置覆盖）。
- **依赖注入**：涉及进程 / 文件 / 时钟的逻辑一律通过构造参数注入，便于单测替换（详见第 10 节）。

## 3. 目录与模块职责

| 文件 | 职责 |
| --- | --- |
| `server/index.ts` | 服务入口：加载配置、创建管理器、探测 KataGo 版本、启动 HTTP 服务、优雅退出 |
| `server/config.ts` | 配置系统：`ServerConfig` 类型、`loadConfig()`、路径解析 |
| `server/http.ts` | 请求分发：构造 `URL`，命中 `/api/*` 交 `api`，否则交 `static` |
| `server/api.ts` | 全部 HTTP 路由实现、请求体解析、错误码映射、NDJSON 流式响应 |
| `server/static.ts` | `dist/` 静态托管（路径穿越防护 + SPA 回退） |
| `server/engine/manager.ts` | `EngineManager`：模型注册表、加载/卸载/切换、路由、状态聚合 |
| `server/engine/engine.ts` | `EngineInstance`：单模型实例，持有进程、状态机、FIFO 队列与限流 |
| `server/engine/katago-process.ts` | `NodeKatagoProcess`：子进程封装，JSON 行分帧、按 `id` 匹配 Promise |
| `server/engine/protocol.ts` | KataGo 查询构造与响应解析（纯函数） |
| `server/engine/coords.ts` | 棋盘索引 `pos` ↔ KataGo 文本坐标互转（纯函数） |
| `server/engine/analysis-config.ts` | 生成临时 KataGo `analysis` 配置文件并负责清理 |

### 调用链

```
index.ts
  └─ http.ts  (createRequestHandler)
       ├─ api.ts      (/api/* 路由)  ──▶ engine/manager.ts ──▶ engine/engine.ts ──▶ engine/katago-process.ts
       └─ static.ts   (非 /api/* → dist/)
```

`manager` 按 `request.model ?? activeModel` 把请求路由到某个 `EngineInstance`；`EngineInstance` 是并发的汇聚点，串行化对底层进程的访问。

## 4. 服务入口与生命周期（`server/index.ts`）

启动流程：

1. `loadConfig()` 读取配置（见第 9 节）。
2. `new EngineManager(config)` 建立模型注册表（此时**尚未启动任何进程**）。
3. `probeKatagoVersion()`：`execFile(katagoPath, ['version'], { timeout: 10000 })`，成功取版本号，失败返回 `null`（不阻塞）。
4. 计算 `distDir = resolve(ROOT_DIR, 'dist')`，`createRequestHandler({ manager, config, katagoVersion, distDir })`。
5. `createServer(handler).listen(config.port, config.host)`。

- **best-effort 预加载**：启动后调用 `manager.ensureActive().catch(...)`，仅告警、不阻塞服务。若未安装 KataGo 或未配置模型，服务仍正常启动，AI 功能以「未就绪」降级，本地能力不受影响。
- **优雅退出**：监听 `SIGINT` / `SIGTERM` → `manager.stopAll()` → `server.close(() => process.exit(0))`，并通过 `setTimeout(() => process.exit(0), 3000).unref()` 兜底强制退出。

## 5. 配置系统（`server/config.ts`）

`ServerConfig` 字段与默认值：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `port` | `8080` | HTTP 端口 |
| `host` | `'0.0.0.0'` | 监听地址（便于局域网访问） |
| `katagoPath` | `'katago'` | KataGo 可执行文件路径 |
| `modelDir` | `'./models'` | 权重目录（相对路径基于项目根解析） |
| `models` | `[]` | `{ id, name, file }[]` 模型清单 |
| `activeModel` | `null` | 默认激活模型 id（缺省取 `models[0]`） |
| `komi` | `3.75` | 贴目（沿用 `KOMI_AREA`） |
| `maxVisitsDefault` | `200` | 默认访问量上限 |
| `numAnalysisThreads` | `4` | KataGo 分析线程数 |
| `nnMaxBatchSize` | `8` | 神经网络批大小 |
| `reportDuringSearchEvery` | `40` | 分析中间报文间隔 |
| `analysisPVLen` | `15` | 变化线长度 |
| `maxInFlightPerEngine` | `1` | 单实例在途查询上限 |
| `maxQueuePerEngine` | `8` | 单实例排队上限 |
| `queueTimeoutMs` | `60000` | 排队等待超时 |
| `requestTimeoutMs` | `120000` | 单次查询超时 |

- `ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')`（即 `server/` 的上一级，项目根）。
- **优先级：环境变量 > `ai.config.json` > 内置默认值**。配置文件默认取项目根 `ai.config.json`，可用 `AI_CONFIG` 指定路径。
- 环境变量覆盖：`KATAGO_PATH`、`KATAGO_MODEL_DIR`、`AI_PORT`、`AI_ACTIVE_MODEL`（另有 `AI_CONFIG`）。
- `resolveModelPath(config, model)`：`model.file` 为绝对路径则直接用，否则 `resolve(config.modelDir, model.file)`。

## 6. HTTP 层（`http.ts` / `api.ts` / `static.ts`）

### 6.1 分发（`http.ts`）

`createRequestHandler(deps)` 用 `new URL(req.url, base)` 解析请求；调用 `handleApi(...)`，**命中即返回**（返回 `true`）；未命中则 `serveStatic(deps.distDir, url.pathname, res)`。

### 6.2 路由与错误码（`api.ts`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | `{ ok, katagoPath, katagoVersion, activeModel }` |
| `GET` | `/api/models` | `{ models:[{id,name,path,sizeBytes}], active }` |
| `GET` | `/api/status` | `{ engines, active, queue:{active,queued,rejected}, config:{katagoPath,modelDir} }` |
| `POST` | `/api/models/:id/load` | 加载模型（启动实例 + warmup 确认就绪） |
| `POST` | `/api/models/:id/unload` | 卸载模型（停止进程、释放资源） |
| `POST` | `/api/models/:id/activate` | 设为默认激活模型，并 `ensure()` 加载 |
| `POST` | `/api/ai/think` | 单次落子，返回 JSON |
| `POST` | `/api/ai/analyze` | **NDJSON 流**，逐行快照 |

- 辅助函数：`readJsonBody(req, limit = 4MB)`、`sendJson`、`sendError`。
- **错误码映射**：`error.name === 'QueueFullError'` → `429`；`error.message` 以 `未知模型` 开头 → `404`；请求体非法 → `400`；其余 → `500`。

### 6.3 NDJSON 流式分析（`handleAnalyze`）

- 响应头：`Content-Type: application/x-ndjson; charset=utf-8`、`Cache-Control: no-cache, no-transform`。
- 创建 `AbortController`，监听 `res.on('close')` 时调用 `controller.abort()`——**客户端断开即取消查询并释放引擎槽位**。
- 每个快照 `res.write(JSON.stringify(snapshot) + '\n')`。

### 6.4 静态托管（`static.ts`）

- 内置 `MIME` 映射表；通过 `createReadStream(file).pipe(res)` 输出。
- **路径穿越防护**：解析后若 `target !== root && !target.startsWith(root + sep)` 则返回 `403`。
- **SPA 回退**：请求未命中文件时回退到 `index.html`。

## 7. 引擎编排

### 7.1 `EngineManager`（`manager.ts`）

- `EngineLike` 接口约定实例能力：`modelConfig / isRunning / inFlightCount / queuedCount / rejectedCount / start / stop / status / think / analyze`。
- `defaultCreateEngine(config, model)` 注入依赖构造实例：`spawnFn`、`createConfig`（`createAnalysisConfig`）、`createProcess`（`NodeKatagoProcess`）。
- 内部 `engines: Map<id, EngineLike>`；`active = config.activeModel ?? config.models[0]?.id ?? null`。
- `resolveModelId(requestModel) => requestModel ?? this.active`（均无则抛错）；`think` / `analyze` 据此路由到实例。
- `status()` 聚合各实例的 `inFlight / queued / rejected` 为全局 `queue`；`health(katagoVersion)` 以激活引擎的 `isRunning` 判定 `ok`。

### 7.2 `EngineInstance`（`engine.ts`）

绑定单个模型，持有进程、状态与统计字段：`process / tempConfig / state / startedAt / lastError / inFlight / rejected / totalRequests / queue / starting`。

- **`start()` 幂等**：`doStart()` 创建临时配置 + 进程，`proc.start()` 后执行一次 **warmup 查询**并 `await`，
  warmup 查询为 `{ moves: [], rules: 'chinese', komi, boardXSize: 19, boardYSize: 19, maxVisits: 1 }`；
  失败则进入 `error` 态并清理资源。
- **`run(query)` 限流**：当在途数达到 `maxInFlightPerEngine` 时，若 `queue.length >= maxQueuePerEngine` 则 `rejected++` 并抛 `QueueFullError`，否则入队。
- **`execute()`**：`inFlight++` → `proc.run(...)`（支持 `signal` 中止与 `onReport` 回调）→ `finally` 中 `inFlight--`、`refreshBusyState()`、`drain()`。
- **`drain()`**：FIFO 取出队列任务并执行，直至达到并发上限。
- `think()`：`buildAnalysisQuery` + `parseThink(response, maxTemperature ?? 0)`。
- `analyze()`：中间报文经 `onReport` 转成快照回调，结束后再补发一次**最终快照**。
- `status()`：`{ modelId, modelName, state, pid, inFlight, queued, rejected, totalRequests, startedAt, lastError }`。

`QueueFullError extends Error`，`name = 'QueueFullError'`，默认消息 `'引擎队列已满'`（`api.ts` 依此名映射为 429）。

### 7.3 KataGo 子进程（`katago-process.ts`）

- 接口：`SpawnedProcess` / `SpawnFn`（依赖注入点）/ `KatagoProcessLike`（`pid / running / start / run / stop`）。
- `start()`：`spawn(katagoPath, ['analysis', '-config', configPath, '-model', modelPath], { stdio: ['pipe','pipe','pipe'] })`，并监听 `stdout / stderr / error / exit`。
- `run(query, options)`：`id = 'q' + nextId++`；向 stdin 写 `JSON.stringify({ id, ...query }) + '\n'`；`pending: Map<id, { resolve, reject, onReport, timer }>`。
- `handleLine`：`JSON.parse` 后，若 `isDuringSearch` 则回调 `onReport`（中间报文），否则删除 pending、清 timer 并 `resolve`。
- `onExit`：非主动 `stopping` 时 `failAll(new Error('KataGo 进程已退出(...)'))`。
- stderr 收集为日志（`logBuffer` 上限 200 行）。

## 8. 协议与坐标（`protocol.ts` / `coords.ts`）

### 8.1 坐标互转（`coords.ts`）

- 常量：`BOARD_SIZE = 19`、`BOARD_AREA = 361`、`PASS = 361`、`COLUMN_LABELS = 'ABCDEFGHJKLMNOPQRST'`（跳过 `I`）。
- `posToKataGo(pos)`：`PASS` → `'pass'`；越界抛 `RangeError`；文本为 `列字母 + (19 - row)`。
- `kataGoToPos(s)`：`'pass'` → `PASS`；`col = COLUMN_LABELS.indexOf(letter)`，`row = 19 - num`；无法识别返回 `null`。
- **与 KataGo 文本坐标的互转由后端独占**，客户端只使用棋盘索引。

### 8.2 协议纯函数（`protocol.ts`）

类型：`AnalysisQuery { moves: [string,string][], rules, komi, boardXSize, boardYSize, maxVisits?, reportDuringSearchEvery? }`；`AnalysisResponse { id?, isDuringSearch?, turnNumber?, moveInfos?, rootInfo? }`。

- `buildAnalysisQuery(request, options)`：`moves.map(m => [m.stone, posToKataGo(m.pos ?? PASS)])`；可选字段仅在 `> 0` 时写入（向下取整）。
- `parseAnalysis(response)`：候选按 `visits` 降序；`bestMove` 取首位，否则 `PASS`。
- `pickMoveByTemperature(candidates, temperature, rng)`：权重 `visits^(1/T)`，`T <= 0` 取最优。
- `parseThink(response, temperature, rng)` → `{ move, winRate, scoreLead, visits }`。
- `toSnapshot(response)` → `{ playouts, rootValue, bestMove, candidates }`。

### 8.3 临时分析配置（`analysis-config.ts`）

- `renderAnalysisConfig(config, maxVisits)`：生成 `numAnalysisThreads / nnMaxBatchSize / maxVisits / reportDuringSearchEvery / analysisPVLen`。
- `createAnalysisConfig(config, maxVisits)`：`mkdtempSync(tmpdir()/'weiqi-katago-')` 写入 `analysis.cfg`，返回 `{ path, dispose }`（`dispose` 递归删除临时目录）。

## 9. 引擎状态机与并发模型

### 9.1 状态机

```
starting ──▶ ready ⇄ busy ──▶ error
   │                      └▶ stopped
```

| 状态 | 含义 |
| --- | --- |
| `starting` | 进程启动 + warmup 进行中 |
| `ready` | 空闲可接收请求 |
| `busy` | 有在途查询 |
| `error` | 启动或运行失败（`lastError` 记录原因） |
| `stopped` | 已卸载/停止 |

### 9.2 并发与限流

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `maxInFlightPerEngine` | `1` | 同时处理的查询数（KataGo 实例内串行） |
| `maxQueuePerEngine` | `8` | 超出的请求入队；队列满则拒绝并返回 `429` |
| `queueTimeoutMs` | `60000` | 排队等待超时后失败 |
| `requestTimeoutMs` | `120000` | 单次查询超时后失败 |

- `analyze` 流会**长时间占用槽位**（持续到客户端断开）；期间对弈请求会排队。客户端离开回放或开始对弈时会主动取消分析流以释放槽位。

## 10. 依赖注入约定（测试友好，硬约定）

新增涉及**进程 / 文件 / 网络 / 时钟**的后端逻辑时，优先把外部依赖作为参数注入，而不是直接调用 `spawn` / `execFile` / `Date.now`，以便用假实现做单测：

- `manager.defaultCreateEngine` 注入 `spawnFn`、`createConfig`、`createProcess`。
- `NodeKatagoProcess` 通过构造注入 `SpawnFn`。
- `EngineInstance` 通过构造注入进程与临时配置工厂。

## 11. 测试

- 框架：**vitest**，`environment: 'node'`，`include: ['test/**/*.test.ts']`（见 `vite.config.ts`）。
- 后端相关用例：`test/kata-coords.test.ts`（坐标双向/边界/`pass`）、`test/kata-protocol.test.ts`（查询构造与解析、think 取最优）、`test/kata-process.test.ts`（假 `spawn` 验证分帧与按 `id` 匹配、进程退出/错误）、`test/engine-manager.test.ts`（假引擎验证加载/卸载/切换、状态聚合、限流与 429）、`test/server-config.test.ts`（env 覆盖与默认值合并）、`test/remote-service-client.test.ts`（假 `fetch` + NDJSON 流与取消）。
- 后端测试从 `../server/...ts` 导入（**带 `.ts` 后缀**）。
- 改动核心逻辑请同步补充/更新单测，并跑 `npm test` 与 `npm run build`。

## 12. 相关文档

- 前端架构：[frontend.md](./frontend.md)
- AI 助手总览与约定：[../AGENTS.md](../AGENTS.md)
- 人类可读说明：[../../README.md](../../README.md)
- 服务化改造计划：[../milestones/2026-09-12-AI服务化改造计划.md](../milestones/2026-09-12-AI服务化改造计划.md)
