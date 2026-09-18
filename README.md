# 网页版 AI 围棋(本机 AI 服务 + 局域网客户端)

本机运行 Node 后端,调用本机已安装的 **KataGo 可执行文件**提供 AI 围棋服务;浏览器只做界面与
棋局逻辑。**本机与局域网设备统一走该服务**,客户端**不再加载任何 AI 模型**。

```text
本机/局域网浏览器 (src/, 不加载模型)
   │  HTTP  /api/ai/*        (think 单次 JSON / analyze NDJSON 流)
   │  HTTP  /api/models|status|health
   ▼
Node 后端 (server/)  ── spawn ──▶  katago analysis(JSON 行协议,每模型一进程)
   • EngineManager:模型注册、加载/卸载/切换、状态查看、并发队列限流
   • 生产环境同时静态托管 dist/
```

## 功能

- **19×19 对弈**:完整围棋规则——气、提子、打劫、禁着点、双方虚着终局,默认中国规则数子(贴 3.75 子)
- **人机对弈**:AI 执黑 / AI 执白 / 双人三种模式,30级 至 业余5段 共十档难度(经本机 AI 服务推理)
- **棋谱库**:对局保存为 SGF、SGF 导入导出,棋谱存储在浏览器 IndexedDB
- **棋谱回放**:逐步 / 跳转 / 自动播放,可从棋谱任一手"继续对弈"
- **回放 AI 分析**:回放暂停时自动分析当前局面,展示候选着法(胜率 + 访问量);
  点击候选可查看 15 步变化线(半透明棋子 + 步序编号)
- **AI 服务管理**:查看服务连接状态、KataGo 路径与模型目录、模型列表与当前激活项、
  每个运行实例状态(state / pid / 在途 / 排队 / 请求数 / 最近错误),并支持**加载 / 卸载 / 设为默认**

## 技术架构

- **前端构建**:Vite + 原生 TypeScript(无框架),Canvas 渲染棋盘;`src/` 不再引用 TF.js 推理路径
- **AI 推理**:后端(`server/`)以 `katago analysis` 子进程形式接入外部引擎,JSON 行协议通信
- **坐标契约**:客户端 ↔ 后端统一使用棋盘索引 `pos = row*19 + col`(row 0 在上),`pos = 361` 表示虚着;
  与 KataGo 文本坐标(如 `D4` / `pass`)的互转由后端独占,客户端不感知 KataGo 坐标
- **协议**:`think` 返回单次 JSON(`move/winRate/scoreLead/visits`);`analyze` 返回
  **NDJSON 流**,每 `reportDuringSearchEvery` 回报一行快照,客户端断开即取消并释放槽位
- **模块划分**:
  - `src/core/` — 棋盘、规则、计分、Zobrist、SGF 解析
  - `src/engine/remote/` — **服务客户端**:`service-client`(HTTP 封装)、`remote-ai-player`、`remote-analysis`、`protocol`(共享类型)
  - `src/store/` — 对局、棋谱回放、IndexedDB
  - `src/ui/` — Canvas 棋盘渲染(含候选标记与变化线)
  - `server/` — **Node 后端**:`config`、`engine/*`(坐标、协议、KataGo 进程、实例、编排)、`api`/`http`/`static`/`index`

> 说明:早期浏览器端 TF.js 本地推理代码已移除,AI 推理统一由 Node 后端通过 KataGo 提供;
> `src/core/*` 仍被前端与单测使用。

## 前置要求:安装 KataGo

服务需要本机可执行的 KataGo(官方 C++ 版),以及至少一个模型权重文件。

1. 安装 KataGo:从 [KataGo releases](https://github.com/lightvector/KataGo/releases) 下载对应平台的可执行文件,
   放到 PATH 中(如 `katago`),或记住其绝对路径。
2. 下载模型权重(如 `kata1-b18c384nbt-s9996604416-d4316597426.bin.gz`),
   来源:[KataGo 训练网络](https://media.katagotraining.org/uploaded/networks/models/kata1/)
   或 releases 页面附件。将权重放入 `modelDir`(默认 `./models`)。
3. 准备配置:复制 `ai.config.example.json` 为 `ai.config.json`,填写 `katagoPath`、`modelDir` 与 `models`。

> 若本机未安装 KataGo 或未配置模型,服务仍会正常启动,只是 AI 功能以「未就绪」降级(面板给出提示),
> 双人 / SGF / 回放等本地功能不受影响。

## 配置 `ai.config.json`

优先级:`环境变量` > `ai.config.json` > 内置默认值。配置文件在启动时的当前工作目录读取(可用 `AI_CONFIG` 指定路径)。

```json
{
  "katagoPath": "/usr/local/bin/katago",
  "modelDir": "./models",
  "activeModel": "b18c384nbt",
  "komi": 3.5,
  "port": 8080,
  "host": "0.0.0.0",
  "models": [
    {
      "id": "b18c384nbt",
      "name": "KataGo b18c384nbt",
      "file": "kata1-b18c384nbt-s9996604416-d4316597426.bin.gz"
    }
  ],
  "maxVisitsDefault": 200,
  "numAnalysisThreads": 4,
  "numSearchThreads": 4,
  "nnMaxBatchSize": 8,
  "reportDuringSearchEvery": 40,
  "analysisPVLen": 15,
  "maxInFlightPerEngine": 1,
  "maxQueuePerEngine": 8,
  "queueTimeoutMs": 60000,
  "requestTimeoutMs": 120000
}
```

- `katagoPath` / `modelDir`:KataGo 可执行路径与模型目录(`modelDir` 相对路径基于项目根解析,`models[].file` 相对路径拼接到 `modelDir`)
- `models[]`:`id`(唯一标识)、`name`(显示名,缺省取 id)、`file`(权重文件名或绝对路径)
- `activeModel`:默认激活的模型 id(缺省为 `models[0]`)
- `komi`:贴目,默认与前端计分常量 `KOMI_AREA = 3.5` 一致(取 KataGo 合法的半整数,仅用于 warmup;真实对局 komi 由客户端随请求携带)
- `maxVisitsDefault` / `numAnalysisThreads` / `numSearchThreads` / `nnMaxBatchSize` / `reportDuringSearchEvery` / `analysisPVLen`:生成临时 KataGo analysis 配置时使用
- `maxInFlightPerEngine` / `maxQueuePerEngine` / `queueTimeoutMs` / `requestTimeoutMs`:并发与限流参数(见下)

支持的环境变量覆盖:

| 环境变量 | 对应配置 |
| --- | --- |
| `KATAGO_PATH` | `katagoPath` |
| `KATAGO_MODEL_DIR` | `modelDir` |
| `AI_PORT` | `port` |
| `AI_ACTIVE_MODEL` | `activeModel` |
| `AI_CONFIG` | 指定配置文件路径 |

`ai.config.json` 已加入 `.gitignore`,本地配置不会提交;`ai.config.example.json` 为示例模板。

## 运行

```bash
npm install                 # 安装依赖

# 开发:同时启动后端(:8080)与 Vite(:5173),前端经 /api 代理访问后端
npm run dev

# 仅启动后端 AI 服务
npm run server              # = node server/index.ts

# 仅前端调试(需另行运行 npm run server)
npm run dev:web             # = vite

# 生产:先构建,再由后端同时托管 dist/ 与 /api
npm run build               # = tsc && vite build
npm start                   # = node server/index.ts(托管 dist/)
```

后端直接以 `node server/index.ts` 运行,依赖 Node 原生 TypeScript 类型剥离(需较新的 Node);

### 局域网访问

- **开发模式**:Vite 已配置 `host: true`,局域网设备访问启动日志里打印的 `Network` 地址
  (如 `http://192.0.2.188:5173/`);页面内的 `/api` 请求由 Vite 代理到本机后端。
- **生产模式**:直接访问后端地址 `http://<本机IP>:8080/`,后端同时提供 `dist/` 页面与 `/api`。

无论哪种模式,客户端都不加载模型,全部 AI 推理都在本机后端完成。

## 模型管理与并发限流

通过「AI 服务」面板或 REST 接口管理后端模型(每个模型对应一个 `katago analysis` 进程实例):

- **加载 / 卸载 / 切换**:加载启动实例并做一次 warmup 查询确认就绪;卸载停止实例;设为默认决定后续请求默认路由到的模型。
- **状态查看**:面板每 2 秒轮询 `/api/status`,展示各实例的 `state`(`starting|ready|busy|error|stopped`)、
  pid、在途 / 排队请求数、累计请求数与最近错误。
- **并发与限流**:每个实例默认 `maxInFlightPerEngine = 1`(同时只处理一个查询)、
  `maxQueuePerEngine = 8`(超出即返回 `429`),队列等待超 `queueTimeoutMs`、单次查询超 `requestTimeoutMs` 会失败。
  分析流占用槽位期间,对弈请求会排队;客户端离开回放或开始对弈时会主动取消分析流以释放槽位。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务健康:`{ ok, katagoPath, katagoVersion, activeModel }` |
| `GET` | `/api/models` | 模型列表:`{ models:[{id,name,path,sizeBytes}], active }` |
| `GET` | `/api/status` | 运行状态:`{ engines, active, queue:{active,queued,rejected}, config:{katagoPath,modelDir} }` |
| `POST` | `/api/models/:id/load` | 加载模型 |
| `POST` | `/api/models/:id/unload` | 卸载模型 |
| `POST` | `/api/models/:id/activate` | 设为默认激活模型 |
| `POST` | `/api/ai/think` | 单次落子:`{ move, winRate, scoreLead, visits }` |
| `POST` | `/api/ai/analyze` | **NDJSON 流**:逐行 `{ playouts, rootValue, bestMove, candidates:[{pos,visits,winRate,scoreLead,prior,pv}] }` |

`think` / `analyze` 请求体携带**从空盘起的完整手顺** `moves: { stone:'B'|'W'; pos:number|null }[]`,
以及 `komi`、`rules:'chinese'`,可加 `maxVisits`。

## 开发脚本

```bash
npm test            # 全量单测(vitest,node 环境)
npm run test:watch  # 监听模式
npm run build       # 类型检查 + 生产构建
```

测试使用 vitest(node 环境)+ fake-indexeddb;服务端新增模块(`server/config`、坐标、协议、KataGo 进程、
引擎管理与服务客户端)均有单测覆盖,现有前端模块的单测保持不变并继续通过。
