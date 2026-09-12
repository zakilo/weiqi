# AGENTS.md — 项目说明(面向 AI 编程助手)

> 本文件供 AI 编程助手(Qoder / Cursor / Copilot 等)快速上手本仓库。
> 人类可读的完整说明见仓库根目录 [`README.md`](../README.md);本文件聚焦「改代码时需要知道的约定与坑」。
> 前后端分层架构细节见 [`docs/architecture/backend.md`](architecture/backend.md)(后端)与 [`docs/architecture/frontend.md`](architecture/frontend.md)(前端)。

## 1. 项目一句话

**网页版 AI 围棋**:本机运行 Node 后端,`spawn` 本机已安装的 **KataGo 可执行文件**提供 AI 服务;
浏览器只做界面与棋局逻辑,**不加载任何 AI 模型**,所有推理都在本机后端完成,局域网设备统一访问该服务。

```
本机/局域网浏览器 (src/)  ──HTTP /api/ai/*、/api/models|status|health──▶  Node 后端 (server/)
                                                                              │ spawn
                                                                              ▼
                                                                    katago analysis(每模型一进程)
```

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run dev` | 同时启动后端(:8080)与 Vite 前端(:5173),前端经 `/api` 代理访问后端 |
| `npm run server` / `npm start` | 仅启动后端(`node server/index.ts`);`npm start` 时后端同时托管 `dist/` |
| `npm run dev:web` | 仅启动 Vite(需另行启动后端) |
| `npm run build` | `tsc && vite build`,类型检查 + 生产构建到 `dist/` |
| `npm test` | 全量单测(vitest,node 环境) |
| `npm run test:watch` | 单测监听模式 |

- 端口:后端 `8080`,Vite 开发 `5173`,Vite 预览 `4173`。
- 后端直接以 `node server/index.ts` 运行,依赖 **Node 原生 TypeScript 类型剥离**(需较新的 Node 版本)。

## 3. 架构与目录

| 目录 | 职责 |
| --- | --- |
| `src/core/` | 与渲染无关的围棋核心:棋盘、规则、计分、Zobrist 哈希、SGF 解析/序列化 |
| `src/engine/remote/` | **当前使用的 AI 路径**:`service-client`(HTTP 封装)、`remote-ai-player`、`remote-analysis`、`protocol`(共享类型) |
| `src/engine/`(其余) | **遗留的本地 TF.js 推理路径**:特征编码、KataGoNet、权重解析、MCTS、AI 玩家、分析引擎/Worker/客户端 |
| `src/store/` | 应用状态:对局状态机(`game`)、棋谱回放(`replay`)、IndexedDB 棋谱库(`db`)、SGF 导入导出(`game-io`) |
| `src/ui/` | Canvas 棋盘渲染器(`board-renderer`) |
| `src/main.ts` | 前端入口:构建 DOM、绑定事件、驱动对弈/回放/分析/服务面板 |
| `server/` | **Node 后端**:`config`(配置)、`engine/*`(坐标、协议、KataGo 进程、实例、编排)、`api`/`http`/`static`/`index` |
| `test/` | vitest 单测(含 `helpers/`) |
| `scripts/dev.mjs` | 并行启动后端与 Vite 的开发脚本 |

后端模块调用链:`index` → `http` →(`api` | `static`);`api` → `engine/manager` → `engine/engine`(`EngineInstance`)→ `engine/katago-process`。

> 更详尽的前后端分层、模块职责与调用链见 [`architecture/backend.md`](architecture/backend.md) 与 [`architecture/frontend.md`](architecture/frontend.md)。

## 4. 关键契约(务必遵守)

### 4.1 坐标契约

- **全链路统一使用棋盘索引** `pos = row * 19 + col`(row `0` 在上),`pos = 361` 表示**虚着(pass)**。常量见 [coords.ts](../server/engine/coords.ts) 的 `BOARD_SIZE` / `BOARD_AREA` / `PASS`。
- **与 KataGo 文本坐标的互转由后端独占**:客户端不感知 KataGo 坐标。转换函数 `posToKataGo` / `kataGoToPos` 在 `server/engine/coords.ts`。
- 列标签**跳过字母 I**:`ABCDEFGHJKLMNOPQRST`(见 `COLUMN_LABELS`,与 `src/ui/board-renderer.ts` 保持一致)。
- 前端 `src/core/board.ts` 提供 `idx/colOf/rowOf/inBounds/neighborsOf`,颜色常量 `EMPTY=0 / BLACK=1 / WHITE=2`。

> 改动坐标或棋盘尺寸时:`src/core/board.ts`、`server/engine/coords.ts`、`src/ui/board-renderer.ts` 三处常量必须一致(当前均为 19 路)。

### 4.2 请求/响应协议

- 共享的**纯类型**契约在 [src/engine/remote/protocol.ts](../src/engine/remote/protocol.ts)(仅类型,无运行时产物)。
- `think` / `analyze` 请求体携带**从空盘起的完整手顺** `moves: { stone:'B'|'W'; pos:number|null }[]`,以及 `komi`、`rules:'chinese'`,可加 `maxVisits`;`think` 另可加 `maxTemperature`。
- 请求体字段 `model?: string` 指定目标模型,缺省用当前激活模型。
- `think` 返回单次 JSON:`{ move, winRate, scoreLead, visits }`(`winRate`/`scoreLead` 为行棋方视角)。
- `analyze` 返回 **NDJSON 流**,每行一个 `AnalyzeSnapshot`:`{ playouts, rootValue, bestMove, candidates[] }`;`candidate.pv` 为主线变化(棋盘索引),**变化线直接来自响应,无需单独请求**。
- 客户端断开(AbortController)即取消分析并释放引擎槽位。

### 4.3 计分与规则

- 默认**中国规则数子**,贴子常量 `KOMI_AREA = 3.75`(`src/core/scoring.ts`);另有备用 `KOMI_TERRITORY = 7.5`。
- 落子合法性 `checkLegality` 返回 `'ok' | 'occupied' | 'suicide' | 'ko'`;打劫检测基于 Zobrist 哈希(传入上一手落子**前**的局面哈希)。
- 双方连续虚着终局,自动按 `KOMI_AREA` 结算。

### 4.4 难度档位(远端语义)

`src/engine/remote/remote-ai-player.ts` 中难度用 `maxVisits` / `maxTemperature` 表达,访问次数越少、温度越高越弱:

| id | 档位 | maxVisits | maxTemperature |
| --- | --- | --- | --- |
| `easy` | 入门 | 80 | 1 |
| `normal` | 进阶 | 200 | 0.6 |
| `hard` | 高手 | 500 | 0.2 |

## 5. 配置

- 优先级:**环境变量 > `ai.config.json` > 内置默认值**(`server/config.ts` 的 `DEFAULT_CONFIG`)。
- 配置文件默认读取项目根 `ai.config.json`(已 gitignore),可用 `AI_CONFIG` 指定路径;模板见 [`ai.config.example.json`](../ai.config.example.json)。
- 支持的环境变量覆盖:`KATAGO_PATH`、`KATAGO_MODEL_DIR`、`AI_PORT`、`AI_ACTIVE_MODEL`、`AI_CONFIG`。
- 相对路径(`modelDir` 等)基于**项目根**解析(`ROOT_DIR` = `server/` 的上一级)。
- 关键运行参数:`maxVisitsDefault`、`numAnalysisThreads`、`nnMaxBatchSize`、`reportDuringSearchEvery`、`analysisPVLen` 会写入临时 KataGo analysis 配置;`maxInFlightPerEngine` / `maxQueuePerEngine` / `queueTimeoutMs` / `requestTimeoutMs` 控制并发与限流。
- 未安装 KataGo 或未配置模型时,服务仍会启动,AI 功能以「未就绪」降级,本地功能(双人/SGF/回放)不受影响。

## 6. HTTP API(`server/api.ts`)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | `{ ok, katagoPath, katagoVersion, activeModel }` |
| `GET` | `/api/models` | `{ models:[{id,name,path,sizeBytes}], active }` |
| `GET` | `/api/status` | `{ engines, active, queue:{active,queued,rejected}, config }` |
| `POST` | `/api/models/:id/load` | 加载模型(启动实例 + warmup 确认就绪) |
| `POST` | `/api/models/:id/unload` | 卸载模型(停止进程、释放资源) |
| `POST` | `/api/models/:id/activate` | 设为默认激活模型并加载 |
| `POST` | `/api/ai/think` | 单次落子,返回 JSON |
| `POST` | `/api/ai/analyze` | NDJSON 流 |

错误码约定:队列满(`QueueFullError`)→ `429`;未知模型 → `404`;请求体非法 → `400`;其余 → `500`。
非 `/api/*` 请求回退到 `dist/` 静态托管(`server/static.ts`,含路径穿越防护与 SPA 回退到 `index.html`)。

## 7. 后端要点

> 完整后端架构(模块详解、状态机、并发模型、错误码、DI 约定)见 [`architecture/backend.md`](architecture/backend.md)。

- `EngineManager`(`server/engine/manager.ts`):模型注册表与路由;`createEngine` 通过构造注入,**便于单测注入假引擎**。按 `request.model ?? activeModel` 路由。
- `EngineInstance`(`server/engine/engine.ts`):绑定单个模型,持有 KataGo 进程、状态与统计;启动后执行一次 `maxVisits:1` 的 **warmup** 确认 `ready`;内部 FIFO 队列 + 限流;**依赖通过构造注入**(进程/临时配置),便于单测。
- `NodeKatagoProcess`(`server/engine/katago-process.ts`):`spawn(katagoPath, ['analysis','-config',cfg,'-model',model])`;stdin 写 JSON 行,stdout 按行分帧并按 `id` 匹配 pending Promise;`isDuringSearch` 的中间报文经 `onReport` 转发,最终报文 resolve;`spawn` 通过依赖注入以便测试。
- `createAnalysisConfig`(`server/engine/analysis-config.ts`):生成临时 analysis 配置文件,`dispose()` 清理临时目录。
- 引擎状态机:`starting | ready | busy | error | stopped`。

> **测试友好是硬约定**:新增涉及进程 / 网络 / 时钟的后端逻辑时,优先把外部依赖作为参数注入,而不是直接 `spawn`/`fetch`/`Date.now`,以便用假实现做单测。

## 8. 前端要点

> 完整前端架构(分层、数据流、core/store/remote/ui 详解、遗留路径)见 [`architecture/frontend.md`](architecture/frontend.md)。

- **无框架**:`src/main.ts` 用模板字符串一次性写入 `#app`,再通过 `querySelector` + 事件监听驱动。新增 UI 沿用该风格,不要引入框架。
- AI 走 `ServiceClient`(`src/engine/remote/service-client.ts`),`baseUrl` 默认空(开发经 Vite 代理,生产同源)。
- 回放暂停时由 `RemoteAnalysisClient` 持续分析并展示候选;点击候选展开 `VARIATION_DEPTH`(15)步变化线。
- `BoardRenderer`(`src/ui/board-renderer.ts`)负责 Canvas 渲染,颜色/线宽/星位等视觉逻辑集中在此;`resize()` 适配高分屏。

## 9. 测试

- 框架:vitest,`environment: 'node'`,`include: ['test/**/*.test.ts']`(见 `vite.config.ts`)。
- IndexedDB 相关测试顶部 `import 'fake-indexeddb/auto'`,并在 `beforeEach` 重置 `indexedDB = new IDBFactory()`。
- 后端测试从 `../server/...ts` 导入(带 `.ts` 后缀);前端测试从 `../src/...` 导入(不带后缀)。
- 覆盖范围:core(rules/scoring/board/sgf/zobrist)、store(game/replay/db/game-io)、server(config/坐标/协议/进程/管理/服务客户端)、以及遗留引擎路径(ai-player/mcts/net/weights/model-loader 等)。
- 改动核心逻辑请同步补充/更新对应单测,并跑 `npm test` 与 `npm run build`。

## 10. 代码约定

- 语言:TypeScript,`strict: true`,并开启 `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch`,禁止未使用变量与落空 switch。
- 模块系统:ESM(`"type": "module"`);`isolatedModules` + `noEmit`。
- **`server/` 内部相对导入带 `.ts` 后缀**(`tsconfig` 开启 `allowImportingTsExtensions`,以支持 Node 原生类型剥离直跑);**`src/` 内部导入不带后缀**。
- 在会被 Node 直接运行的文件里,避免无法被「类型剥离」的语法:`enum`、`namespace`、构造函数参数属性等(用显式字段声明 + 联合类型常量代替)。
- 注释与 JSDoc 使用**中文**;每个模块顶部有一段 JSDoc 说明职责。2 空格缩进,单引号,语句带分号。
- 优先 `import type` 导入仅用于类型的符号。

## 11. 注意事项 / 常见坑

1. **存在两条 AI 路径,只有一条在用**。当前实际使用的是 `src/engine/remote/*` → 后端 KataGo。
   而 `src/engine/{features,net,weights,mcts,ai-player,backend,analysis-engine,analysis-worker,analysis-client,model-loader}.ts`
   是**遗留的本地 TF.js 推理路径**:`main.ts` 仅从中取了两个常量(`PASS` 来自 `mcts`、`VARIATION_DEPTH` 来自 `analysis-engine`),
   其余不再接线,但**仍有单测覆盖并需继续通过**。除非任务明确要求,不要扩展或删除它们。
2. **不要假设浏览器端会加载模型**:任何「在客户端推理」的实现方向都不符合当前架构。
3. **坐标转换只在后端做**;前端一律用索引 `pos`,乱转坐标会导致前后端不一致。
4. `dist/` 是构建产物、`ai.config.json` 与 `models/` 已 gitignore;不要提交本地配置与模型。
5. 修改后端并发/超时行为时,注意 `analyze` 流会长时间占用引擎槽位;对弈请求会被排队,客户端离开回放/开始对弈时会主动取消分析流以释放槽位。
6. `server/index.ts` 启动时 `best-effort` 预加载激活模型:失败只告警,不阻塞服务。改动此处不要引入启动硬失败。
