# 前端架构（Vite + 原生 TypeScript + Canvas）

> 本文档描述 `src/` 目录的分层结构、模块职责、数据流与关键契约。
> 后端部分见 [backend.md](./backend.md);面向 AI 助手的项目总览与约定见 [../AGENTS.md](../AGENTS.md);人类可读说明见 [../../README.md](../../README.md)。

## 1. 概述与职责边界

前端是一个 **Vite + 原生 TypeScript（无框架）** 的单页应用，负责：

- 围棋**棋局逻辑与规则**（棋盘、气、提子、打劫、终局判定、中国规则数子）；
- **Canvas 棋盘渲染**（含坐标、星位、最后一手标记、候选点与变化线叠加）；
- **对局 / 回放 / 棋谱库**的界面与交互；
- 通过 HTTP 调用本机后端完成 AI 走子与局面分析，**自身不加载任何 AI 模型**。

> 关键边界：所有 AI 推理都在后端（`server/`）完成；前端只使用棋盘索引 `pos`，**不感知 KataGo 坐标**。

## 2. 技术栈

- **构建**：Vite（`base: './'`，`build.target: 'es2022'`）；开发/预览通过 `proxy` 将 `/api` 转发到 `http://localhost:8080`。
- **语言**：TypeScript，`strict: true`，ESM；`src/` 内部导入**不带** `.ts` 后缀。
- **渲染**：原生 Canvas 2D（无渲染库、无框架）。
- **测试**：vitest，`environment: 'node'`，IndexedDB 用例借助 `fake-indexeddb`。

## 3. 目录与模块职责

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 入口：构建 DOM 模板、绑定事件，驱动对弈 / 回放 / 分析 / 服务面板 |
| `src/core/board.ts` | 棋盘数据结构与基础操作（落子提子、连通块、气） |
| `src/core/rules.ts` | 落子合法性（占位 / 自杀 / 打劫） |
| `src/core/scoring.ts` | 中国规则数子结算 |
| `src/core/zobrist.ts` | 局面 Zobrist 哈希（打劫检测） |
| `src/core/sgf.ts` | SGF 解析 / 序列化（节点树、主线提取、终局元数据） |
| `src/store/game.ts` | 对局状态机：落子、虚着、悔棋、终局、从手顺导入 |
| `src/store/replay.ts` | 棋谱回放：预计算每步快照，支持 O(1) 跳转 |
| `src/store/db.ts` | IndexedDB 棋谱库（保存 / 列表 / 读取 / 删除） |
| `src/store/game-io.ts` | 对局 ↔ SGF 文本的导入导出粘合层 |
| `src/engine/remote/protocol.ts` | **前后端共享纯类型契约**（仅类型，无运行时产物） |
| `src/engine/remote/service-client.ts` | HTTP 客户端：封装 `/api/*` 调用（含 NDJSON 流解析） |
| `src/engine/remote/remote-ai-player.ts` | 远端 AI 玩家：难度档位 + `think` 调用 |
| `src/engine/remote/remote-analysis.ts` | 远端分析客户端：`analyze` 流 + 取消 |
| `src/ui/board-renderer.ts` | Canvas 棋盘渲染器 |
| `src/engine/`（其余文件） | **遗留的本地 TF.js 推理路径**（见第 9 节，不再被 `main.ts` 引用） |

各目录 `index.ts` 为桶文件（re-export）。

## 4. 分层与数据流

```
用户操作 ──▶ main.ts ──▶ store/Game（对局状态机）
                 │            │
                 │            ▼
                 │      ui/BoardRenderer.setState（重绘棋盘）
                 │
AI 走子/分析 ──▶ engine/remote/* ──HTTP──▶ 后端 server/
```

- **对局路径**：落子 → `Game.play` → `refresh()` → `BoardRenderer.setState`。
- **AI 路径**：`maybeAiMove()` 触发 `RemoteAiPlayer.think` → `ServiceClient` → 后端 `/api/ai/think` → 结果回填 `Game`。
- **分析路径**：回放暂停时 `RemoteAnalysisClient.analyze` → 后端 `/api/ai/analyze`（NDJSON 流）→ `analysisSnapshot` → `refresh()` 叠加渲染。

## 5. core 层（与渲染无关的围棋核心）

### 5.1 棋盘 `board.ts`

- 常量：`BOARD_SIZE = 19`、`EMPTY = 0`、`BLACK = 1`、`WHITE = 2`；`opponent` 取反色。
- 坐标：`idx(col, row) = row * 19 + col`、`colOf`、`rowOf`、`inBounds`；预构建 `NEIGHBORS` 邻接表，`neighborsOf` 查询。
- `Board` 类：内部 `cells: Int8Array(361)`；提供 `get`、`play`（含提子）、`groupOf`（BFS 连通块）、`countLiberties`（气集合）、`clear`、`clone`、`cellsCopy`、`fromCells`。

### 5.2 规则 `rules.ts`

- `NO_PREV_HASH = -1n`；`Legality = 'ok' | 'occupied' | 'suicide' | 'ko'`。
- `checkLegality(board, stone, i, prevHash)`：依次判定占位 → 模拟落子判自杀 → 打劫（`Zobrist.fromBoard(copy).value === prevHash`）。
- `isLegal` 为布尔便捷版。

### 5.3 计分 `scoring.ts`

- 常量：`KOMI_AREA = 3.75`（默认）、`KOMI_TERRITORY = 7.5`（备用）。
- `ScoreResult { blackStones, whiteStones, blackTerritory, whiteTerritory, neutral, blackScore, whiteScore, margin, winner }`。
- `scoreGame(board, deadStones, komi = KOMI_AREA)`：移除死子 → 统计子数 → 对空域 BFS 染色（仅邻黑=黑空、仅邻白=白空、混合=中立）→ 计算得分（`whiteScore` 含 `komi`）。

### 5.4 Zobrist `zobrist.ts`

- 每格 3 态（空 / 黑 / 白）的 64 位随机数表（空为零值）；用 xorshift 由固定种子生成。
- `Zobrist.fromBoard(board)` 全盘扫描构建；`update(i, from, to)` 支持增量 XOR；`value` 取哈希值。

### 5.5 SGF `sgf.ts`

- 类型：`SgfNode { properties, children }`、`SgfLineMove { stone, col|null, row|null, comment? }`、`SgfGameMeta`。
- 坐标：`sgfToPoint` / `pointToSgf`（`'a'~'s'`）。
- `parseSgf(text)`：手写递归解析器，产出节点树，非法文本返回 `null`。
- `serializeSgf(root)`：主线平铺、分支加括号；注释说明「仅当恰好 1 个孩子时才平铺」的歧义规避策略。
- `extractMainLine(root)` 提取主线手顺（含注释与虚着）；`buildSgfDoc(moves, meta)` 由手顺 + 元数据构建可序列化节点树（`GM/FF/SZ/KM/PB/PW/RE/HA`）。

## 6. store 层（应用状态）

### 6.1 对局状态机 `game.ts`

- `Move = { kind:'play', stone, pos, captured } | { kind:'pass', stone }`；`PlayOutcome { ok, reason? }`。
- `Game` 字段：`board / moves / beforeHashes / consecutivePasses / finished / _result`。
- 派生属性：`currentStone`（黑先，按 `moves.length` 奇偶）、`moveCount`、`isFinished`、`result`、`consecutivePassCount`、`getBoard`、`getMoves`、`getLastPlayPos`。
- `play(col, row)`：非法时返回 reason 且不改状态；合法时先记录**落子前局面哈希** → `board.play` → push move。
- `pass()`：连续两次虚着即 `finish()`。
- 悔棋：`undoSince(stone)` 面向人机对弈（找回人类最后一手并撤销其后步数：未应手退 1、已应手退 2）；`undo(steps)` 重放前 N 手并重算连续虚着计数。
- `loadMoves(moves)`：从手顺重建，逐手校验，非法返回 `false`。
- `finishWithScore(deadStones)` 结算终局；`prevHashForNext` 返回最后一手落子**前**的哈希。

### 6.2 回放 `replay.ts`

- `Replay`（私有构造，`static fromMoves(moves)`）：加载时逐手重放并预计算 `boards[]` / `lastPlays[]`（虚着共享前一快照）；**非法手处截断**；含打劫校验。
- 方法：`pos` / `moveCount` / `lineMoves()` / `board()` / `lastPlayPos()` / `nextStone()` / `recentMoves(n)` / `prevHash()` / `isAtStart()` / `isAtEnd()` / `goto(pos)` / `step(delta)` / `start()` / `end()`。跳转为 O(1)。

### 6.3 棋谱库 `db.ts`

- `SavedGame { id, name, sgfText, moveCount, createdAt }`。
- 常量：`DB_NAME = 'weiqi'`、`DB_VERSION = 2`、`STORE_NAME = 'games'`、`MODEL_STORE = 'model-blobs'`（后者为遗留模型缓存表）。
- `openDb()`（`onupgradeneeded` 建表）、`listGames()`（按 `createdAt` 倒序）、`saveGame()`、`getGame()`、`deleteGame()`。

### 6.4 SGF 粘合 `game-io.ts`

- `gameToLineMoves(game)`、`exportGameSgf(game)`（终局写入 `RE`，如 `B+3.75`）、`exportLineSgf(moves)`、`parseSgfToLine(text)`。

## 7. engine/remote 层（服务客户端）

### 7.1 共享类型 `protocol.ts`

仅含**纯类型**（无运行时产物，供前后端共用）：`WireStone`、`WireMove`、`AiMoveRequest`、`ThinkRequest`、`AnalyzeRequest`、`CandidateWire`、`AnalyzeSnapshot`、`ThinkResult`、`EngineState`、`EngineStatus`、`ModelInfo`、`ModelsResponse`、`HealthResponse`、`QueueStatus`、`ServiceStatus`、`ModelActionResponse` 等。

### 7.2 HTTP 客户端 `service-client.ts`

- `ServiceClient`（`baseUrl` 默认空 → 开发经 Vite 代理、生产同源）。
- 方法：`health / models / status / loadModel / unloadModel / activateModel / think / analyze`。
- `analyze()`：`fetch` + `resp.body.getReader()` + `TextDecoder`，按 `\n` 分帧解析 NDJSON；单行含 `error` 字段走 `onError`，否则 `onSnapshot`；`AbortError` 直接抛出（正常取消）。

### 7.3 远端 AI 玩家 `remote-ai-player.ts`

- `REMOTE_AI_LEVELS` 难度档位：

| id | 档位 | `maxVisits` | `maxTemperature` |
| --- | --- | --- | --- |
| `easy` | 入门 | 80 | 1 |
| `normal` | 进阶 | 200 | 0.6 |
| `hard` | 高手 | 500 | 0.2 |

- `RemoteAiPlayer`：对外形状 `isReady`、`backendLabel = '远端服务'`、`thinking`、`refresh()`（调 `health`）、`setReady()`。
- `think(game, level)`：把 `game.getMoves()` 序列化为 `moves`，带 `komi = KOMI_AREA`，调 `client.think`；返回落子或 `{ kind:'pass' }`。

### 7.4 远端分析 `remote-analysis.ts`

- `RemoteAnalysisClient`：持有 `controller: AbortController | null`。
- `ensure()`：调 `health`，设置 `backendLabel = '远端 · ${katagoVersion}'`。
- `analyze(state)`：先 `stop()` 再新建 `AbortController`（**新请求自动中止旧请求**）。
- `stop()` / `dispose()` 中断；`callbacks { onSnapshot, onError? }`。

## 8. ui 层与入口

### 8.1 Canvas 渲染器 `board-renderer.ts`

- 常量：`STAR_POINTS`（9 个星位）、`COLUMN_LABELS = 'ABCDEFGHJKLMNOPQRST'`（跳过 `I`，与后端 `coords.ts` 一致）。
- `RenderState { board, lastMove, ghost, analysis? }`；`analysis` 含 `candidates[{pos,winRate}]` 与可选 `variation{stone, moves[{pos,order}]}`。
- `BoardRenderer`：`setState`（更新并重绘）、`resize()`（按 `devicePixelRatio` 适配高分屏，`cell = view / 20`）、`pointToPixel`（网格点 → 像素）、`pixelToPoint`（像素 → 最近网格点，过远返回 `null`）。
- 绘制流程：木纹底色 → 网格线（外圈加粗）→ 星位 → 坐标标注 → 棋子 / 最后一手标记 / 悬停预览 → 分析叠加（候选胜率圆标 + 变化线半透明棋子与步序编号）。虚着（`pos >= 361`）不画在盘上。

### 8.2 入口 `main.ts`

- 用**模板字符串一次性写入** `#app.innerHTML`（顶部工具栏、回放控件、对弈模式/难度、`#board` canvas、侧栏棋谱库 / AI 分析面板 / AI 服务面板、消息与结果面板），随后 `querySelector` 取节点并绑定事件。
- 关键状态：`mode: 'play' | 'replay'`、`replay: Replay | null`、`autoplayTimer`、`vsMode: 'human' | 'ai-white' | 'ai-black'`、`ghost`、`serviceClient / aiPlayer / analysisClient`、`analysisSnapshot / variationLine / analysisTimer / analysisBackend`、`serviceStatus / serviceModelList`。
- 关键函数：
  - `isAiTurn()` / `humanStone()`：判定当前是否 AI 回合、人类执子色；
  - `coordText(col, row)`：坐标文本（如 `Q16`）；
  - `refresh()`：核心渲染，按模式取展示局面与分析数据后调用 `board.setState`，并处理状态栏 / 结果面板；
  - `tryPlay()`：人类落子入口，随后调用 `maybeAiMove()`；
  - `maybeAiMove()`：AI 思考并落子，`finally` 中递归调用以支持连续 AI 行棋；
  - `analysisState()`：把回放视角转成 `{ moves, komi: KOMI_AREA }`（从空盘起的完整手顺）；
  - `stopAnalysis()` / `scheduleAnalysis()`（250ms 防抖）/ `startAnalysis()`；
  - `renderCandidateList()` / `renderVariationList()`：候选与变化线渲染（点击候选取 `pv.slice(0, VARIATION_DEPTH)`）；
  - `enterReplay()` / `renderLibrary()` / `openSavedGame()`：回放与棋谱库；
  - `refreshService()`（每 2s 轮询 `models` + `status`）/ `renderServicePanel()` / `serviceAction()`：AI 服务面板。
- `new ResizeObserver(() => board.resize()).observe(canvas)` 响应尺寸变化。
- **常量接入**：`VARIATION_DEPTH`（`./engine/analysis-engine`，值 15）、`PASS`（`./engine/mcts`），仅取这两个常量，其余遗留模块不再接线。

## 9. 遗留 TF.js 推理路径（保留但不再使用）

`src/engine/{features, net, weights, mcts, ai-player, backend, analysis-engine, analysis-worker, analysis-client, model-loader}.ts` 是**早期本地 TF.js 推理路径**：

- `main.ts` 仅从中取两个常量（`PASS`、`VARIATION_DEPTH`），其余不再引用；
- 这些模块**仍有单测覆盖并需继续通过**；除非任务明确要求，**不要扩展或删除**它们；
- 相关依赖（`@tensorflow/tfjs*`）仍在 `package.json` 中。

> 当前实际生效的 AI 路径是 `src/engine/remote/*` → 后端 KataGo。任何「在浏览器端加载/推理模型」的实现方向都不符合当前架构。

## 10. 关键约定

- **坐标契约**：全链路统一 `pos = row * 19 + col`（row 0 在上），`pos = 361` 表示虚着；与 KataGo 文本坐标的互转**只在后端**进行。
- **棋盘尺寸常量一致性**：改动尺寸/坐标时，`src/core/board.ts`、`src/ui/board-renderer.ts`、`server/engine/coords.ts` **三处必须一致**（当前均为 19 路）。
- **无框架**：新增 UI 沿用「模板字符串 + `querySelector` + 事件监听」风格。
- **共享类型**：前后端契约以 `src/engine/remote/protocol.ts` 的**纯类型**为准，仅 `import type`，不产生运行时代码。
- **计分**：默认中国规则数子，贴子 `KOMI_AREA = 3.75`；打劫检测基于 Zobrist（传入上一手落子**前**的局面哈希）。

## 11. 测试

- 框架：vitest，`environment: 'node'`，`include: ['test/**/*.test.ts']`。
- IndexedDB 相关测试顶部 `import 'fake-indexeddb/auto'`，并在 `beforeEach` 重置 `indexedDB = new IDBFactory()`。
- 覆盖范围（前端）：core（`rules` / `scoring` / `board` / `board-edge` / `board-layout` / `sgf`）、store（`game` / `replay` / `db` / `game-io`）、remote（`remote-service-client`），以及遗留引擎路径（`ai-player` / `mcts` / `net` / `weights` / `model-loader` / `analysis-*` 等）。
- 前端测试从 `../src/...` 导入（**不带**后缀）。
- 改动核心逻辑请同步补充/更新单测，并跑 `npm test` 与 `npm run build`。

## 12. 相关文档

- 后端架构：[backend.md](./backend.md)
- AI 助手总览与约定：[../AGENTS.md](../AGENTS.md)
- 人类可读说明：[../../README.md](../../README.md)
- 服务化改造计划：[../milestones/2026-09-12-AI服务化改造计划.md](../milestones/2026-09-12-AI服务化改造计划.md)
