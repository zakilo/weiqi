import './styles.css';
import { BLACK, BOARD_SIZE, colOf, EMPTY, idx, PASS, rowOf, Stone, WHITE } from './core/board';
import { BoardRenderer, COLUMN_LABELS, type RenderState } from './ui/board-renderer';
import { Game } from './store/game';
import { exportGameSgf, exportLineSgf, parseSgfToLine } from './store/game-io';
import { SgfLineMove } from './core/sgf';
import { deleteGame, getGame, listGames, saveGame } from './store/db';
import { Replay } from './store/replay';
import { KOMI_AREA, scoreGame } from './core/scoring';
import { ServiceClient } from './engine/remote/service-client';
import {
  RemoteAiPlayer,
  REMOTE_AI_DEFAULT_LEVEL_ID,
  REMOTE_AI_LEVELS,
  remoteLevelOf,
} from './engine/remote/remote-ai-player';
import { RemoteAnalysisClient, type RemoteAnalysisState } from './engine/remote/remote-analysis';
import { blackEvalOf, leadText } from './engine/remote/eval';
import type {
  AnalyzeSnapshot,
  EngineStatus,
  ModelInfo,
  ServiceStatus,
} from './engine/remote/protocol';

const app = document.querySelector<HTMLDivElement>('#app')!;

const levelOptions = REMOTE_AI_LEVELS.map(
  (l) => `<option value="${l.id}"${l.id === REMOTE_AI_DEFAULT_LEVEL_ID ? ' selected' : ''}>${l.label}</option>`,
).join('');

app.innerHTML = `
  <div class="shell">
    <h1>围棋 · 本地对弈</h1>
    <div class="toolbar">
      <span id="status" class="status"></span>
      <span id="move-count" class="dim"></span>
      <div class="spacer"></div>
      <div id="replay-controls" class="replay-controls hidden">
        <button id="btn-first" class="btn" title="回到首手">⏮</button>
        <button id="btn-prev" class="btn" title="上一手">◀</button>
        <button id="btn-autoplay" class="btn" title="自动播放">播放</button>
        <button id="btn-next" class="btn" title="下一手">▶</button>
        <button id="btn-last" class="btn" title="跳到末手">⏭</button>
        <button id="btn-resume" class="btn primary">继续对弈</button>
      </div>
      <select id="vs-select" class="btn" title="对弈模式">
        <option value="human">双人对弈</option>
        <option value="ai-white">人机·AI 执白</option>
        <option value="ai-black">人机·AI 执黑</option>
      </select>
      <select id="level-select" class="btn" title="AI 难度">
        ${levelOptions}
      </select>
      <button id="btn-pass" class="btn">虚着</button>
      <button id="btn-undo" class="btn">悔棋</button>
      <button id="btn-resign" class="btn" title="认输结束对局">认输</button>
      <button id="btn-count" class="btn" title="点目(标记死子并结算)">点目</button>
      <button id="btn-eval" class="btn" title="形势判断(实时评估)">形势</button>
      <button id="btn-hint" class="btn" title="AI 提示(显示推荐候选点)">提示</button>
      <button id="btn-restart" class="btn primary">新对局</button>
    </div>
    <div id="eval-bar" class="eval-bar hidden"></div>
    <div id="count-panel" class="count-panel hidden">
      <div class="count-title">点目 · AI 自动标记死子(虚线半透明)</div>
      <div id="count-result" class="count-result"></div>
      <div class="count-actions">
        <button id="btn-count-confirm" class="btn primary">确认以此结果结束</button>
        <button id="btn-count-cancel" class="btn">取消</button>
      </div>
    </div>
    <div class="layout">
      <div class="board-wrap">
        <canvas id="board"></canvas>
      </div>
      <aside class="library">
        <div class="library-head">
          <h2>棋谱库</h2>
          <div class="library-actions">
            <button id="btn-save" class="btn small" title="当前对局存入棋谱库">保存</button>
            <button id="btn-import" class="btn small" title="从 SGF 文件导入">导入</button>
            <button id="btn-export" class="btn small" title="导出当前对局为 SGF 文件">导出</button>
            <button id="btn-panel-toggle" class="btn small panel-toggle">收起面板</button>
          </div>
        </div>
        <ul id="game-list" class="game-list"></ul>
        <input id="file-input" type="file" accept=".sgf" class="hidden" />
        <div id="analysis-panel" class="analysis-panel hidden">
          <div class="library-head">
            <h2>AI 分析</h2>
            <span id="analysis-status" class="dim"></span>
          </div>
          <ul id="candidate-list" class="candidate-list"></ul>
          <div id="variation-list" class="variation-list"></div>
        </div>
        <div class="service-panel">
          <div class="library-head">
            <h2>AI 服务</h2>
            <span id="service-conn" class="badge">检查中…</span>
          </div>
          <div id="service-paths" class="service-paths"></div>
          <ul id="service-models" class="service-models"></ul>
        </div>
      </aside>
    </div>
    <div id="message" class="message"></div>
    <div id="result-panel" class="result-panel hidden"></div>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const statusEl = document.querySelector<HTMLSpanElement>('#status')!;
const moveCountEl = document.querySelector<HTMLSpanElement>('#move-count')!;
const messageEl = document.querySelector<HTMLDivElement>('#message')!;
const resultPanel = document.querySelector<HTMLDivElement>('#result-panel')!;
const vsSelect = document.querySelector<HTMLSelectElement>('#vs-select')!;
const levelSelect = document.querySelector<HTMLSelectElement>('#level-select')!;

const board = new BoardRenderer(canvas);
const game = new Game();
let ghost: { pos: number; stone: Stone } | null = null;

/** 交互模式:play = 正常对弈;replay = 棋谱回放 */
let mode: 'play' | 'replay' = 'play';
let replay: Replay | null = null;
let autoplayTimer: ReturnType<typeof setInterval> | null = null;

/** 对弈模式:双人 / AI 执白 / AI 执黑 */
let vsMode: 'human' | 'ai-white' | 'ai-black' = 'human';
const serviceClient = new ServiceClient();
const aiPlayer = new RemoteAiPlayer(serviceClient);

/** 点击候选项展开的变化线步数 */
const VARIATION_DEPTH = 15;

/** 盘面最多展示的候选点数(候选已按访问量降序,侧栏候选列表不受限) */
const BOARD_CANDIDATE_LIMIT = 10;

/** 回放分析:远端服务客户端与展示状态 */
const analysisClient = new RemoteAnalysisClient(serviceClient);
let analysisSnapshot: AnalyzeSnapshot | null = null;
let variationLine: number[] = [];
let analysisTimer: ReturnType<typeof setTimeout> | null = null;
let analysisBackend = '';

const analysisPanel = document.querySelector<HTMLDivElement>('#analysis-panel')!;
const analysisStatusEl = document.querySelector<HTMLSpanElement>('#analysis-status')!;
const candidateListEl = document.querySelector<HTMLUListElement>('#candidate-list')!;
const variationListEl = document.querySelector<HTMLDivElement>('#variation-list')!;

/** 对局评估流:形势判断评估条与 AI 提示候选点共享同一流与快照(回放模式复用 analysisSnapshot) */
const evalClient = new RemoteAnalysisClient(serviceClient);
let evalEnabled = false;
/** AI 提示开关:在盘面显示推荐候选点 */
let hintEnabled = false;
let evalSnapshot: AnalyzeSnapshot | null = null;
/** 评估快照对应的局面签名(手数 + 最后一手);与当前不一致时视为过期 */
let evalFor: string | null = null;
let evalTimer: ReturnType<typeof setTimeout> | null = null;
/** AI 思考中:评估暂停,保留上次数值 */
let evalPaused = false;
const evalBarEl = document.querySelector<HTMLDivElement>('#eval-bar')!;
const evalButtonEl = document.querySelector<HTMLButtonElement>('#btn-eval')!;
const hintButtonEl = document.querySelector<HTMLButtonElement>('#btn-hint')!;

/** 点目模式:标记死子并预览结算,确认后以此结果结束对局 */
let countingMode = false;
const deadStones = new Set<number>();
const countButtonEl = document.querySelector<HTMLButtonElement>('#btn-count')!;
const countPanelEl = document.querySelector<HTMLDivElement>('#count-panel')!;
const countResultEl = document.querySelector<HTMLDivElement>('#count-result')!;

/** 点目分析流:请求 ownership 以自动判定死子 */
const countClient = new RemoteAnalysisClient(serviceClient);
let countSnapshot: AnalyzeSnapshot | null = null;
let countTimer: ReturnType<typeof setTimeout> | null = null;

/** 点目请求(从空盘起的完整手顺 + komi + ownership) */
function countState(): RemoteAnalysisState {
  const moves = game.getMoves().map((m) => ({
    stone: m.stone === BLACK ? ('B' as const) : ('W' as const),
    pos: m.kind === 'play' ? m.pos : null,
  }));
  return { moves, komi: KOMI_AREA, includeOwnership: true };
}

/** 停止点目分析流并清空快照 */
function stopCount(): void {
  if (countTimer !== null) {
    clearTimeout(countTimer);
    countTimer = null;
  }
  countClient.stop();
  countSnapshot = null;
}

/** 延迟启动点目分析(防抖) */
function scheduleCount(): void {
  if (!countingMode || mode !== 'play' || game.isFinished) return;
  if (countTimer !== null) clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    countTimer = null;
    void startCount();
  }, 200);
}

/** 连接服务并分析当前局面(带 ownership) */
async function startCount(): Promise<void> {
  if (!countingMode || mode !== 'play' || game.isFinished) return;
  try {
    await countClient.ensure();
  } catch {
    messageEl.textContent = 'AI 服务不可用,无法自动点目';
    return;
  }
  if (!countingMode || mode !== 'play' || game.isFinished) return;
  countClient.analyze(countState());
}

/** 依据 ownership 自动判定死子:棋子颜色与该点归属相反即视为死子 */
function computeDeadStones(ownership: number[] | undefined): number[] {
  if (!ownership) return [];
  const boardNow = game.getBoard();
  const THRESHOLD = 0.3;
  const dead: number[] = [];
  for (let pos = 0; pos < BOARD_SIZE * BOARD_SIZE; pos++) {
    const v = boardNow.get(pos);
    if (v === EMPTY) continue;
    const own = ownership[pos] ?? 0;
    if (v === BLACK && own < -THRESHOLD) dead.push(pos);
    else if (v === WHITE && own > THRESHOLD) dead.push(pos);
  }
  return dead;
}

countClient.callbacks.onSnapshot = (snap) => {
  countSnapshot = snap;
  deadStones.clear();
  for (const p of computeDeadStones(snap.ownership)) deadStones.add(p);
  refresh();
};
countClient.callbacks.onError = (message) => {
  messageEl.textContent = `点目分析失败:${message}`;
};
/** 是否轮到 AI 行棋(且非回放模式) */
function isAiTurn(): boolean {
  if (mode !== 'play' || game.isFinished) return false;
  if (vsMode === 'ai-black') return game.currentStone === BLACK;
  if (vsMode === 'ai-white') return game.currentStone === WHITE;
  return false;
}

/** 人类执子(双人对弈时为 null) */
function humanStone(): Stone | null {
  if (vsMode === 'ai-white') return BLACK;
  if (vsMode === 'ai-black') return WHITE;
  return null;
}

/** 棋盘坐标文本,如 "Q16" */
function coordText(col: number, row: number): string {
  return `${COLUMN_LABELS[col]}${row + 1}`;
}

function stoneName(stone: Stone): string {
  return stone === BLACK ? '黑' : '白';
}

const REASONS: Record<string, string> = {
  occupied: '此处已有棋子',
  suicide: '禁止自杀',
  ko: '打劫:需先在他处行棋',
  'game-over': '对局已结束',
};

/** 当前盘面叠加(最多 BOARD_CANDIDATE_LIMIT 个候选):回放=分析流候选+变化线;对局=提示开关下的评估候选(最佳手标记) */
function boardAnalysis(): RenderState['analysis'] {
  if (mode === 'replay' && replay) {
    return {
      candidates: (analysisSnapshot?.candidates ?? []).slice(0, BOARD_CANDIDATE_LIMIT).map((c) => ({ pos: c.pos, winRate: c.winRate })),
      ...(variationLine.length > 0
        ? {
            variation: {
              stone: replay.nextStone(),
              moves: variationLine.map((pos, i) => ({ pos, order: i + 1 })),
            },
          }
        : {}),
    };
  }
  if (!hintEnabled || game.isFinished || evalPaused) return undefined;
  const snapshot = evalSnapshot;
  if (evalFor !== evalSignature() || !snapshot) return undefined;
  return {
    candidates: snapshot.candidates.slice(0, BOARD_CANDIDATE_LIMIT).map((c) => ({
      pos: c.pos,
      winRate: c.winRate,
      best: c.pos === snapshot.bestMove,
    })),
  };
}

function refresh(): void {
  // 终局时自动退出点目模式
  if (game.isFinished && countingMode) {
    countingMode = false;
    deadStones.clear();
    countButtonEl.classList.remove('active');
    stopCount();
  }
  const displayBoard = mode === 'replay' && replay ? replay.board() : game.getBoard();
  const lastMove = mode === 'replay' && replay ? replay.lastPlayPos() : game.getLastPlayPos();
  board.setState({
    board: displayBoard,
    lastMove,
    ghost,
    analysis: boardAnalysis(),
    deadStones: countingMode ? [...deadStones] : undefined,
  });

  const replayControls = document.querySelector<HTMLDivElement>('#replay-controls')!;
  const playButtons = [
    document.querySelector<HTMLButtonElement>('#btn-pass')!,
    document.querySelector<HTMLButtonElement>('#btn-undo')!,
    document.querySelector<HTMLButtonElement>('#btn-resign')!,
    hintButtonEl, // AI 提示仅在窗口期可用(回放候选由回放分析流驱动)
  ];
  if (mode === 'replay' && replay) {
    replayControls.classList.remove('hidden');
    for (const b of playButtons) b.disabled = true;
    countButtonEl.disabled = true; // 回放中点目无效,禁用避免困惑
    moveCountEl.textContent = `第 ${replay.pos}/${replay.moveCount} 手`;
    statusEl.textContent = '棋谱回放';
    resultPanel.classList.add('hidden');
    updateAutoplayButton();
    renderEvalBar();
    renderCountPanel();
    return;
  }

  replayControls.classList.add('hidden');
  for (const b of playButtons) b.disabled = false;
  countButtonEl.disabled = false;
  if (countingMode) for (const b of playButtons) b.disabled = true; // 点目中禁止落子等操作
  moveCountEl.textContent = `手数:${game.moveCount}`;
  if (aiPlayer.thinking) {
    statusEl.textContent = 'AI 思考中…';
  } else if (game.isFinished && game.result) {
    statusEl.textContent = '对局结束';
    const r = game.result;
    resultPanel.classList.remove('hidden');
    resultPanel.innerHTML = `
      <strong>对局结束</strong>
      <span>黑:${r.blackScore.toFixed(2)} 子(子 ${r.blackStones} + 空 ${r.blackTerritory})</span>
      <span>白:${r.whiteScore.toFixed(2)} 子(子 ${r.whiteStones} + 空 ${r.whiteTerritory} + 贴 ${KOMI_AREA})</span>
      <span class="winner">${r.margin >= 0 ? '黑胜' : '白胜'} ${Math.abs(r.margin).toFixed(2)} 子</span>
    `;
    if (evalWanted()) stopEval(); // 终局:停流并清空展示(结果面板已有实际数子)
  } else {
    statusEl.textContent = countingMode ? '点目中' : `${stoneName(game.currentStone)}棋落子`;
    resultPanel.classList.add('hidden');
  }

  renderEvalBar();
  renderCountPanel();
}

/** 渲染点目面板:实时结算预览(含死子) */
function renderCountPanel(): void {
  if (!countingMode || mode !== 'play') {
    countPanelEl.classList.add('hidden');
    return;
  }
  countPanelEl.classList.remove('hidden');
  if (!countSnapshot?.ownership) {
    countResultEl.innerHTML = `<span class="dim">AI 正在计算死子与归属…</span>`;
    return;
  }
  const result = scoreGame(game.getBoard(), [...deadStones], KOMI_AREA);
  const winnerText = result.margin >= 0 ? '黑胜' : '白胜';
  countResultEl.innerHTML = `
    <span>黑:${result.blackScore.toFixed(2)} 子</span>
    <span>白:${result.whiteScore.toFixed(2)} 子</span>
    <span class="winner">${winnerText} ${Math.abs(result.margin).toFixed(2)} 子</span>
    <span class="dim">自动判定死子 ${deadStones.size} 枚</span>
  `;
}

function stopAutoplay(): void {
  if (autoplayTimer !== null) {
    clearInterval(autoplayTimer);
    autoplayTimer = null;
  }
}

function updateAutoplayButton(): void {
  const btn = document.querySelector<HTMLButtonElement>('#btn-autoplay')!;
  btn.textContent = autoplayTimer !== null ? '暂停' : '播放';
}

function tryPlay(col: number, row: number): void {
  const outcome = game.play(col, row);
  if (!outcome.ok) {
    messageEl.textContent = REASONS[outcome.reason ?? ''] ?? '非法落子';
  } else {
    const last = game.getLastPlayPos();
    messageEl.textContent = last !== null
      ? `${stoneName(game.currentStone === BLACK ? WHITE : BLACK)} ${coordText(colOf(last), rowOf(last))}`
      : '';
  }
  refresh();
  if (evalWanted()) scheduleEval();
  void maybeAiMove();
}

/** 轮到 AI 时驱动思考落子(思考中/未就绪时静默跳过) */
async function maybeAiMove(): Promise<void> {
  if (!isAiTurn() || aiPlayer.thinking) return;
  if (!aiPlayer.isReady) {
    messageEl.textContent = 'AI 服务未连接:请确认本机后端已启动并加载模型';
    return;
  }
  const level = remoteLevelOf(levelSelect.value);
  // AI 思考前停止评估流:释放引擎槽位,避免思考请求排队等待分析结束
  evalPaused = true;
  evalClient.stop();
  try {
    // 先刷新展示“AI 思考中…”(think 阻塞期间状态栏即时反馈)
    refresh();
    const move = await aiPlayer.think(game, level);
    if (mode !== 'play') return;
    if (move.kind === 'pass') {
      game.pass();
      messageEl.textContent = `AI 虚着${game.isFinished ? ',双方虚着终局' : ''}`;
    } else {
      const outcome = game.play(move.col, move.row);
      if (!outcome.ok) {
        messageEl.textContent = `AI 尝试非法落子(${REASONS[outcome.reason ?? ''] ?? outcome.reason}),已放弃`;
        return;
      }
      messageEl.textContent = `AI ${coordText(move.col, move.row)}`;
    }
  } catch (e) {
    messageEl.textContent = `AI 思考失败:${String(e)}`;
  } finally {
    evalPaused = false;
    refresh();
    if (evalWanted()) scheduleEval(); // AI 落子后恢复评估(此时通常轮到我方)
    void maybeAiMove(); // 若 AI 连续行棋(或思考后仍轮到 AI)继续
  }
}

// ---- 回放暂停分析(Worker 持续分析 + 变化线) ----

/** 当前回放视角的分析请求(从空盘起的完整手顺 + komi) */
function analysisState(): RemoteAnalysisState | null {
  if (!replay) return null;
  const moves = replay.lineMoves().slice(0, replay.pos).map((m) => ({
    stone: m.stone === BLACK ? ('B' as const) : ('W' as const),
    pos: m.col === null || m.row === null ? null : idx(m.col, m.row),
  }));
  return { moves, komi: KOMI_AREA };
}

/** 停止分析并清空展示 */
function stopAnalysis(): void {
  if (analysisTimer !== null) {
    clearTimeout(analysisTimer);
    analysisTimer = null;
  }
  analysisClient.stop();
  analysisSnapshot = null;
  variationLine = [];
  analysisStatusEl.textContent = '';
  candidateListEl.innerHTML = '';
  variationListEl.innerHTML = '';
}

/** 延迟启动分析(跳步连续触发时防抖) */
function scheduleAnalysis(): void {
  if (!replay) return;
  if (analysisTimer !== null) clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => {
    analysisTimer = null;
    void startAnalysis();
  }, 250);
}

/** 连接服务并分析当前回放局面 */
async function startAnalysis(): Promise<void> {
  const state = analysisState();
  if (!state) return;
  try {
    analysisStatusEl.textContent = '连接服务中…';
    const backend = await analysisClient.ensure();
    analysisBackend = backend;
  } catch {
    analysisStatusEl.textContent = 'AI 服务不可用';
    return;
  }
  // 若期间已离开回放/跳步,放弃
  if (!replay) return;
  analysisClient.analyze(state);
}

analysisClient.callbacks.onSnapshot = (snap) => {
  analysisSnapshot = snap;
  renderCandidateList();
  refresh();
};
analysisClient.callbacks.onError = (message) => {
  analysisStatusEl.textContent = `失败:${message}`;
};

function renderCandidateList(): void {
  candidateListEl.innerHTML = '';
  if (!analysisSnapshot) return;
  analysisStatusEl.textContent = `${analysisSnapshot.playouts} 次推理 · ${analysisBackend}`;
  for (const c of analysisSnapshot.candidates) {
    const li = document.createElement('li');
    li.dataset.pos = String(c.pos);
    li.title = '点击查看 15 步变化';
    const name = c.pos === PASS ? '虚着' : coordText(colOf(c.pos), rowOf(c.pos));
    li.innerHTML = `<span class="c-pos">${name}</span><span class="c-rate">${(c.winRate * 100).toFixed(1)}%</span><span class="c-visits">${c.visits}</span>`;
    candidateListEl.appendChild(li);
  }
}

function renderVariationList(): void {
  variationListEl.innerHTML = '';
  if (variationLine.length === 0) return;
  const head = document.createElement('div');
  head.className = 'v-head';
  head.textContent = `变化(${variationLine.length} 手)`;
  variationListEl.appendChild(head);
  for (let i = 0; i < variationLine.length; i++) {
    const pos = variationLine[i]!;
    const span = document.createElement('span');
    span.className = 'v-move';
    span.textContent = pos === PASS ? '虚着' : coordText(colOf(pos), rowOf(pos));
    variationListEl.appendChild(span);
  }
}

/** 点击候选着法 → 展开 15 步变化线 */
candidateListEl.addEventListener('click', (e) => {
  if (!replay || mode !== 'replay') return;
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-pos]');
  if (!li) return;
  const pos = Number(li.dataset.pos);
  if (!Number.isInteger(pos)) return;
  const candidate = analysisSnapshot?.candidates.find((c) => c.pos === pos);
  variationLine = candidate ? candidate.pv.slice(0, VARIATION_DEPTH) : [];
  renderVariationList();
  refresh();
});

// ---- 对局评估流(形势判断评估条 + AI 提示候选点) ----

/** 是否需要对局评估流(任一开关开启即需要;两开关共享同一流与快照) */
function evalWanted(): boolean {
  return evalEnabled || hintEnabled;
}

/** 评估错误反馈:评估条开启时写条内,否则提示到消息栏 */
function evalError(message: string): void {
  if (evalEnabled) {
    evalBarEl.classList.remove('hidden');
    evalBarEl.textContent = message;
  } else {
    messageEl.textContent = message;
  }
}

/** 当前对局局面的评估请求(从空盘起的完整手顺 + komi) */
function evalState(): RemoteAnalysisState {
  const moves = game.getMoves().map((m) => ({
    stone: m.stone === BLACK ? ('B' as const) : ('W' as const),
    pos: m.kind === 'play' ? m.pos : null,
  }));
  return { moves, komi: KOMI_AREA };
}

/** 停止对局评估流并清空快照(幂等) */
function stopEval(): void {
  if (evalTimer !== null) {
    clearTimeout(evalTimer);
    evalTimer = null;
  }
  evalClient.stop();
  evalSnapshot = null;
  evalFor = null;
  evalPaused = false;
}

/** 当前对局局面的签名(手数 + 最后一手),用于判断评估快照是否过期 */
function evalSignature(): string {
  return `${game.moveCount}:${game.getLastPlayPos() ?? -1}`;
}

/** 延迟启动对局评估(连续落子防抖) */
function scheduleEval(): void {
  if (!evalWanted() || mode !== 'play' || game.isFinished) return;
  if (evalTimer !== null) clearTimeout(evalTimer);
  evalTimer = setTimeout(() => {
    evalTimer = null;
    void startEval();
  }, 250);
}

/** 连接服务并评估当前对局局面 */
async function startEval(): Promise<void> {
  if (!evalWanted() || mode !== 'play' || game.isFinished || aiPlayer.thinking) return;
  try {
    await evalClient.ensure();
  } catch {
    evalError('AI 服务不可用');
    return;
  }
  // 期间状态可能已变化(切回放/终局/AI 开始思考),放弃本次
  if (!evalWanted() || mode !== 'play' || game.isFinished || aiPlayer.thinking) return;
  evalFor = evalSignature();
  // 签名已切到当前局面:立即丢弃旧快照,避免新结果返回前把上一局面的候选/数值当成当前局面展示
  evalSnapshot = null;
  evalClient.analyze(evalState());
}

evalClient.callbacks.onSnapshot = (snap) => {
  evalSnapshot = snap;
  refresh();
};
evalClient.callbacks.onError = (message) => {
  evalError(`对局分析失败:${message}`);
};

/** 渲染评估条:对局读 evalSnapshot,回放读回放分析流 analysisSnapshot */
function renderEvalBar(): void {
  const inPlay = mode === 'play';
  if (!evalEnabled || (inPlay && game.isFinished)) {
    evalBarEl.classList.add('hidden');
    return;
  }
  evalBarEl.classList.remove('hidden');
  const snapshot = inPlay ? (evalFor === evalSignature() ? evalSnapshot : null) : analysisSnapshot;
  let toMove: 'B' | 'W' | null = null;
  if (inPlay) {
    toMove = game.currentStone === BLACK ? 'B' : 'W';
  } else if (replay) {
    toMove = replay.nextStone() === BLACK ? 'B' : 'W';
  }
  const paused = inPlay && evalPaused ? ' · AI 思考中' : '';
  if (!snapshot || toMove === null) {
    evalBarEl.textContent = `形势判断中…${paused}`;
    return;
  }
  const { blackWinRate, blackLead } = blackEvalOf(snapshot, toMove);
  const percent = (blackWinRate * 100).toFixed(1);
  evalBarEl.innerHTML =
    `<div class="eval-track" title="黑胜率 ${percent}%"><span class="eval-black" style="width:${(blackWinRate * 100).toFixed(2)}%"></span></div>` +
    `<span class="eval-text">黑 ${percent}% · ${leadText(blackLead)} · ${snapshot.playouts} 次推理${paused}</span>`;
}

// 点击落子(仅对弈模式)
canvas.addEventListener('click', (e) => {
  if (countingMode) return; // 点目模式不接受落子(死子由 AI 自动判定)
  const rect = canvas.getBoundingClientRect();
  const pt = board.pixelToPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (!pt) return;
  if (mode !== 'play' || aiPlayer.thinking || isAiTurn()) return;
  tryPlay(pt.col, pt.row);
});

// 悬停预览(仅对弈模式)
canvas.addEventListener('mousemove', (e) => {
  if (mode !== 'play') return;
  const rect = canvas.getBoundingClientRect();
  const pt = board.pixelToPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (pt && game.getBoard().get(idx(pt.col, pt.row)) === 0 && !game.isFinished) {
    ghost = { pos: idx(pt.col, pt.row), stone: game.currentStone };
  } else {
    ghost = null;
  }
  board.setState({ board: game.getBoard(), lastMove: game.getLastPlayPos(), ghost, analysis: boardAnalysis() });
});
canvas.addEventListener('mouseleave', () => {
  if (mode !== 'play') return;
  ghost = null;
  refresh();
});

document.querySelector('#btn-pass')!.addEventListener('click', () => {
  if (aiPlayer.thinking || isAiTurn()) return;
  // 点击时刻 currentStone 即虚着方(pass 后会切换)
  const passer = game.currentStone;
  game.pass();
  messageEl.textContent = game.isFinished ? '双方虚着,终局数子' : `${stoneName(passer)}虚着`;
  refresh();
  if (evalWanted()) scheduleEval();
  void maybeAiMove();
});

// 认输
document.querySelector('#btn-resign')!.addEventListener('click', () => {
  if (game.isFinished) return;
  if (aiPlayer.thinking) {
    messageEl.textContent = 'AI 思考中,请稍候';
    return;
  }
  const resigner = game.currentStone;
  const { winner } = game.resign();
  messageEl.textContent = `${stoneName(resigner)}认输,${stoneName(winner)}胜`;
  stopEval();
  refresh();
});

// ---- 点目(AI 自动判定死子 + 归属 + 结算预览 + 确认结束) ----
countButtonEl.addEventListener('click', () => {
  if (mode !== 'play' || game.isFinished) return;
  countingMode = !countingMode;
  deadStones.clear();
  countButtonEl.classList.toggle('active', countingMode);
  if (countingMode) {
    stopEval(); // 点目时停评估流,避免干扰
    messageEl.textContent = '点目模式:AI 正在自动判定死子与归属,请稍候';
    scheduleCount(); // 启动带 ownership 的分析流
  } else {
    messageEl.textContent = '已退出点目模式';
    stopCount();
    if (evalWanted()) scheduleEval();
  }
  refresh();
});

document.querySelector('#btn-count-confirm')!.addEventListener('click', () => {
  if (!countingMode) return;
  game.finishWithScore([...deadStones]);
  countingMode = false;
  deadStones.clear();
  countButtonEl.classList.remove('active');
  messageEl.textContent = '已按点目结果结束对局';
  stopEval();
  stopCount();
  refresh();
});

document.querySelector('#btn-count-cancel')!.addEventListener('click', () => {
  countingMode = false;
  deadStones.clear();
  countButtonEl.classList.remove('active');
  messageEl.textContent = '已取消点目';
  stopCount();
  refresh();
  if (evalWanted()) scheduleEval();
});

// ---- 对弈模式与难度 ----
vsSelect.addEventListener('change', () => {
  vsMode = vsSelect.value as 'human' | 'ai-white' | 'ai-black';
  messageEl.textContent = `对弈模式:${vsSelect.options[vsSelect.selectedIndex]?.text ?? ''}`;
  refresh();
  void maybeAiMove();
});
levelSelect.addEventListener('change', () => {
  messageEl.textContent = `AI 难度:${levelSelect.options[levelSelect.selectedIndex]?.text ?? ''}`;
});

// ---- 形势判断 / AI 提示开关 ----
evalButtonEl.addEventListener('click', () => {
  evalEnabled = !evalEnabled;
  evalButtonEl.classList.toggle('active', evalEnabled);
  messageEl.textContent = `形势判断:${evalEnabled ? '开' : '关'}`;
  if (!evalWanted()) stopEval(); // 另一开关仍开启时保留评估流
  refresh();
  if (evalWanted()) scheduleEval(); // 回放模式无需请求(复用回放分析流)
});
hintButtonEl.addEventListener('click', () => {
  hintEnabled = !hintEnabled;
  hintButtonEl.classList.toggle('active', hintEnabled);
  messageEl.textContent = `AI 提示:${hintEnabled ? '开' : '关'}`;
  if (!evalWanted()) stopEval();
  refresh();
  if (evalWanted()) scheduleEval();
});

// ---- 回放控制 ----
function enterReplay(line: readonly SgfLineMove[], truncated = false): void {
  stopAutoplay();
  replay = Replay.fromMoves(line);
  mode = 'replay';
  if (replay.moveCount === 0) {
    messageEl.textContent = '棋谱没有有效手数';
  } else if (truncated || replay.moveCount < line.length) {
    messageEl.textContent = `棋谱含非法手,仅回放前 ${replay.moveCount} 手`;
  } else {
    messageEl.textContent = '进入回放模式,可逐步查看';
  }
  stopAnalysis();
  stopEval(); // 对局评估停流;回放条改由 analysisSnapshot 驱动
  analysisPanel.classList.remove('hidden');
  refresh();
  scheduleAnalysis(); // 暂停态开始分析
}

document.querySelector('#btn-first')!.addEventListener('click', () => {
  replay?.start();
  refresh();
  stopAnalysis();
  scheduleAnalysis();
});
document.querySelector('#btn-prev')!.addEventListener('click', () => {
  replay?.step(-1);
  refresh();
  stopAnalysis();
  scheduleAnalysis();
});
document.querySelector('#btn-next')!.addEventListener('click', () => {
  stopAutoplay();
  replay?.step(1);
  refresh();
  stopAnalysis();
  scheduleAnalysis();
});
document.querySelector('#btn-last')!.addEventListener('click', () => {
  replay?.end();
  refresh();
  stopAnalysis();
  scheduleAnalysis();
});
document.querySelector('#btn-autoplay')!.addEventListener('click', () => {
  if (!replay) return;
  if (autoplayTimer !== null) {
    stopAutoplay();
    scheduleAnalysis(); // 暂停即分析
  } else {
    stopAnalysis();
    autoplayTimer = setInterval(() => {
      if (!replay || replay.isAtEnd()) {
        stopAutoplay();
        scheduleAnalysis(); // 播到末手暂停并分析
      } else {
        replay.step(1);
      }
      refresh();
    }, 900);
  }
  refresh();
});
document.querySelector('#btn-resume')!.addEventListener('click', () => {
  if (!replay) return;
  const resumePos = replay.pos;
  stopAutoplay();
  stopAnalysis();
  analysisPanel.classList.add('hidden');
  game.loadMoves(replay.lineMoves().slice(0, resumePos));
  mode = 'play';
  replay = null;
  messageEl.textContent = `已从第 ${resumePos} 手继续对弈`;
  refresh();
  if (evalWanted()) scheduleEval();
});

// ---- 棋谱库(IndexedDB) ----
const gameListEl = document.querySelector<HTMLUListElement>('#game-list')!;
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function timeText(ts: number): string {
  const d = new Date(ts);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

async function renderLibrary(): Promise<void> {
  const rows = await listGames();
  gameListEl.innerHTML = '';
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'g-empty';
    li.textContent = '暂无棋谱';
    gameListEl.appendChild(li);
    return;
  }
  for (const g of rows) {
    const li = document.createElement('li');
    li.className = 'g-item';
    const nameEl = document.createElement('span');
    nameEl.className = 'g-name';
    nameEl.textContent = g.name;
    nameEl.title = g.name;
    const metaEl = document.createElement('span');
    metaEl.className = 'g-meta';
    metaEl.textContent = `${g.moveCount} 手 · ${timeText(g.createdAt)}`;
    const delBtn = document.createElement('button');
    delBtn.className = 'g-del';
    delBtn.title = '删除';
    delBtn.textContent = '×';

    nameEl.addEventListener('click', () => {
      void openSavedGame(g.id);
    });
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteGame(g.id);
      messageEl.textContent = `已删除「${g.name}」`;
      void renderLibrary();
    });

    li.append(nameEl, metaEl, delBtn);
    gameListEl.appendChild(li);
  }
}

/** 从棋谱库打开并进入回放 */
async function openSavedGame(id: number): Promise<void> {
  const rec = await getGame(id);
  if (!rec) {
    messageEl.textContent = '棋谱不存在,可能已被删除';
    return;
  }
  const line = parseSgfToLine(rec.sgfText);
  if (!line) {
    messageEl.textContent = '棋谱损坏:无法解析';
    return;
  }
  enterReplay(line);
  messageEl.textContent = `已打开「${rec.name}」,${messageEl.textContent}`;
}

// 当前对局存入棋谱库

document.querySelector('#btn-save')!.addEventListener('click', async () => {
  const isReplay = mode === 'replay' && replay !== null;
  const lineMoves = isReplay ? replay!.lineMoves() : null;
  if (isReplay && lineMoves!.length === 0) {
    messageEl.textContent = '棋谱没有有效手数,无法保存';
    return;
  }
  if (!isReplay && game.moveCount === 0) {
    messageEl.textContent = '尚未落子,无法保存';
    return;
  }
  const text = isReplay ? exportLineSgf(lineMoves!) : exportGameSgf(game);
  const count = isReplay ? lineMoves!.length : game.moveCount;
  const now = new Date();
  const name = `对局 ${timeText(now.getTime())}`;
  await saveGame({ name, sgfText: text, moveCount: count, createdAt: now.getTime() });
  messageEl.textContent = `「${name}」(${count} 手)已存入棋谱库`;
  void renderLibrary();
});

// 导出当前对局为 SGF 文件

document.querySelector('#btn-export')!.addEventListener('click', () => {
  const isReplay = mode === 'replay' && replay !== null;
  const lineMoves = isReplay ? replay!.lineMoves() : null;
  if (isReplay && lineMoves!.length === 0) {
    messageEl.textContent = '棋谱没有有效手数,无法导出';
    return;
  }
  if (!isReplay && game.moveCount === 0) {
    messageEl.textContent = '尚未落子,无法导出';
    return;
  }
  const text = isReplay ? exportLineSgf(lineMoves!) : exportGameSgf(game);
  const count = isReplay ? lineMoves!.length : game.moveCount;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const blob = new Blob([text], { type: 'application/x-go-sgf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `weiqi-${stamp}.sgf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  messageEl.textContent = `已导出 ${count} 手棋谱`;
});

// 从 SGF 文件导入

document.querySelector('#btn-import')!.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const line = parseSgfToLine(String(reader.result ?? ''));
    if (!line) {
      messageEl.textContent = '棋谱解析失败:不是合法的 SGF 文本';
      return;
    }
    enterReplay(line);
    messageEl.textContent = `已导入 ${file.name},${messageEl.textContent}`;
  };
  reader.onerror = () => {
    messageEl.textContent = '读取文件失败';
  };
  reader.readAsText(file);
});

document.querySelector('#btn-undo')!.addEventListener('click', () => {
  if (aiPlayer.thinking) {
    messageEl.textContent = 'AI 思考中,请稍候';
    return;
  }
  const stone = humanStone();
  let steps = 0;
  if (stone !== null) {
    // 人机:退回到人类上一手之前,一并撤销 AI 已走的应手
    steps = game.undoSince(stone);
  } else if (game.moveCount > 0) {
    game.undo(1);
    steps = 1;
  }
  if (steps === 0) {
    messageEl.textContent = '没有可悔棋的手';
    return;
  }
  messageEl.textContent = `已悔棋(退回 ${steps} 手)`;
  refresh();
  if (evalWanted()) scheduleEval();
  void maybeAiMove();
});
document.querySelector('#btn-restart')!.addEventListener('click', () => {
  stopAutoplay();
  stopAnalysis();
  analysisPanel.classList.add('hidden');
  mode = 'play';
  replay = null;
  game.restart();
  messageEl.textContent = '新对局开始';
  refresh();
  if (evalWanted()) scheduleEval();
  void maybeAiMove();
});

// 初始渲染与窗口尺寸变化自适应
new ResizeObserver(() => board.resize()).observe(canvas);
board.resize();
refresh();
void renderLibrary();

// ---- 面板折叠(移动端) ----
const panelToggleBtn = document.querySelector<HTMLButtonElement>('#btn-panel-toggle')!;
const libraryEl = document.querySelector<HTMLElement>('.library')!;
panelToggleBtn.addEventListener('click', () => {
  libraryEl.classList.toggle('collapsed');
  panelToggleBtn.textContent = libraryEl.classList.contains('collapsed') ? '展开面板' : '收起面板';
  // 折叠为即时布局变化,立即重算棋盘
  board.resize();
});

// ---- AI 服务面板(远端模型管理与状态) ----
const serviceConnEl = document.querySelector<HTMLSpanElement>('#service-conn')!;
const servicePathsEl = document.querySelector<HTMLDivElement>('#service-paths')!;
const serviceModelsEl = document.querySelector<HTMLUListElement>('#service-models')!;

let serviceStatus: ServiceStatus | null = null;
let serviceModelList: ModelInfo[] = [];

const ENGINE_STATE_TEXT: Record<EngineStatus['state'], string> = {
  starting: '启动中',
  ready: '就绪',
  busy: '忙碌',
  error: '错误',
  stopped: '未运行',
};

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 轮询服务状态并刷新面板 */
async function refreshService(): Promise<void> {
  try {
    const [models, status] = await Promise.all([serviceClient.models(), serviceClient.status()]);
    serviceModelList = models.models;
    serviceStatus = status;
    aiPlayer.setReady(true);
    serviceConnEl.textContent = '已连接';
    serviceConnEl.classList.add('badge-ok');
    serviceConnEl.classList.remove('badge-err');
  } catch {
    serviceStatus = null;
    serviceModelList = [];
    aiPlayer.setReady(false);
    serviceConnEl.textContent = '未连接';
    serviceConnEl.classList.add('badge-err');
    serviceConnEl.classList.remove('badge-ok');
  }
  renderServicePanel();
}

function renderServicePanel(): void {
  serviceModelsEl.innerHTML = '';
  if (!serviceStatus) {
    servicePathsEl.textContent = '';
    const li = document.createElement('li');
    li.className = 'g-empty';
    li.textContent = 'AI 服务不可用:请先启动后端(node server/index.ts)并配置 ai.config.json';
    serviceModelsEl.appendChild(li);
    return;
  }

  const { katagoPath, modelDir, humanModelPath, humanModelExists } = serviceStatus.config;
  // Human-SL 人类风格模型:缺失时 AI 对局自动回退普通搜索档位(visits/温度)
  const humanLabel = humanModelExists ? '已加载' : humanModelPath ? '文件缺失,回退普通搜索' : '未配置';
  const humanTitle = humanModelPath ?? '未配置(AI_HUMAN_MODEL / ai.config.json humanModelFile)';
  servicePathsEl.innerHTML =
    `<span title="${escapeHtml(katagoPath)}">KataGo:${escapeHtml(katagoPath)}</span>` +
    `<span title="${escapeHtml(modelDir)}">模型目录:${escapeHtml(modelDir)}</span>` +
    `<span title="${escapeHtml(humanTitle)}"${humanModelExists ? '' : ' class="svc-warn"'}>Human-SL:${humanLabel}</span>`;

  if (serviceModelList.length === 0) {
    const li = document.createElement('li');
    li.className = 'g-empty';
    li.textContent = '未配置模型:请在 ai.config.json 的 models 中登记';
    serviceModelsEl.appendChild(li);
    return;
  }

  const engineByModel = new Map(serviceStatus.engines.map((e) => [e.modelId, e]));
  for (const m of serviceModelList) {
    const engine = engineByModel.get(m.id);
    const isActive = serviceStatus.active === m.id;
    const state = engine?.state ?? 'stopped';

    const li = document.createElement('li');
    li.className = 'svc-item';

    const head = document.createElement('div');
    head.className = 'svc-head';
    const nameEl = document.createElement('span');
    nameEl.className = 'svc-name';
    nameEl.textContent = m.name;
    nameEl.title = m.name;
    const stateBadge = document.createElement('span');
    stateBadge.className = `badge badge-${state}`;
    stateBadge.textContent = ENGINE_STATE_TEXT[state];
    head.append(nameEl, stateBadge);
    if (isActive) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'badge badge-active';
      activeBadge.textContent = '默认';
      head.appendChild(activeBadge);
    }

    const meta = document.createElement('div');
    meta.className = 'svc-meta';
    const sizeText = m.sizeBytes === null ? '文件缺失' : mb(m.sizeBytes);
    const runText = engine
      ? `pid ${engine.pid ?? '-'} · 进行 ${engine.inFlight} · 排队 ${engine.queued} · 累计 ${engine.totalRequests}`
      : '未运行';
    meta.textContent = `${sizeText} · ${runText}`;
    if (engine?.lastError) {
      meta.title = engine.lastError;
      meta.classList.add('svc-error');
    }

    const actions = document.createElement('div');
    actions.className = 'svc-actions';
    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn small';
    loadBtn.textContent = '加载';
    loadBtn.disabled = state === 'starting' || state === 'ready' || state === 'busy';
    loadBtn.addEventListener('click', () => void serviceAction('load', m.id));
    const unloadBtn = document.createElement('button');
    unloadBtn.className = 'btn small';
    unloadBtn.textContent = '卸载';
    unloadBtn.disabled = !engine;
    unloadBtn.addEventListener('click', () => void serviceAction('unload', m.id));
    const activateBtn = document.createElement('button');
    activateBtn.className = 'btn small primary';
    activateBtn.textContent = '设为默认';
    activateBtn.disabled = isActive;
    activateBtn.addEventListener('click', () => void serviceAction('activate', m.id));
    actions.append(loadBtn, unloadBtn, activateBtn);

    li.append(head, meta, actions);
    serviceModelsEl.appendChild(li);
  }
}

/** 加载 / 卸载 / 设为默认 */
async function serviceAction(
  action: 'load' | 'unload' | 'activate',
  id: string,
): Promise<void> {
  const verb = action === 'load' ? '加载' : action === 'unload' ? '卸载' : '设为默认';
  try {
    if (action === 'load') await serviceClient.loadModel(id);
    else if (action === 'unload') await serviceClient.unloadModel(id);
    else await serviceClient.activateModel(id);
    messageEl.textContent = `模型「${id}」${verb}完成`;
  } catch (e) {
    messageEl.textContent = `${verb}失败:${e instanceof Error ? e.message : String(e)}`;
  }
  await refreshService();
  void maybeAiMove();
}

void refreshService();
window.setInterval(() => void refreshService(), 2000);
