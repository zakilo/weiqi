# 网页版单机 AI 围棋

在浏览器中即可游玩的单机 AI 围棋,无需后端服务。使用 TensorFlow.js 在本地运行
KataGo 神经网络(b18c384nbt 小网络)+ 自研 MCTS 搜索。

## 功能

- **19×19 对弈**:完整围棋规则——气、提子、打劫、禁着点、双方虚着终局,默认中国规则数子(贴 3.75 子)
- **人机对弈**:AI 执黑 / AI 执白 / 双人三种模式,入门 / 进阶 / 高手三档难度
- **棋谱库**:对局保存为 SGF、SGF 导入导出,棋谱存储在浏览器 IndexedDB
- **棋谱回放**:逐步 / 跳转 / 自动播放,可从棋谱任一手"继续对弈"
- **回放 AI 分析**:回放暂停时自动分析当前局面,展示候选着法(胜率 + 访问量);
  点击候选可查看 15 步变化线(半透明棋子 + 步序编号)
- **模型管理**:权重从网络下载或本地导入,缓存在 IndexedDB,二次进入秒开

## 技术架构

- **构建**:Vite + 原生 TypeScript(无框架),Canvas 渲染棋盘
- **推理**:@tensorflow/tfjs,后端逐级回退 webgpu → wasm → cpu;
  对弈(主线程)与分析(Worker)分离,非 WebGPU 环境下变化线推理次数自动降级
- **搜索**:自研 MCTS(PUCT 选择 / 批量叶子评估 / Dirichlet 噪声 / 虚拟损失),
  `MctsSession` 支持增量运行与进度快照,分析引擎可持续迭代并回报候选
- **模块划分**:
  - `src/core/` — 棋盘、规则、计分、Zobrist、SGF 解析
  - `src/engine/` — 特征编码、KataGoNet、权重解析、MCTS、AI 玩家、分析引擎/Worker/客户端
  - `src/store/` — 对局、棋谱回放、IndexedDB
  - `src/ui/` — Canvas 棋盘渲染(含候选标记与变化线)

## 模型说明

默认模型为 KataGo b18c384nbt(~93 MB,下载后解压为 ~28 MB)。点击侧栏
「下载」按钮自动下载并缓存;若网络跨域受限,可点「手动下载」链接在浏览器中
打开权重文件(.bin.gz),再点「导入」加载本地文件。模型文件来源:

- https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz
- https://github.com/lightvector/KataGo/releases/tag/v1.15.0

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发服务器
npm test           # 全量单测(vitest,node 环境)
npm run build      # 类型检查 + 生产构建
```

开发/预览服务器已配置 `host: true`,监听所有网卡,局域网设备可通过启动日志里打印的 `Network` 地址(如 `http://192.0.2.188:5173/`)直接访问。

测试使用 vitest + fake-indexeddb,网络与 MCTS 逻辑用小型假模型 / mock 网络验证。
