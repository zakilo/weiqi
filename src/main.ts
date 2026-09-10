import './styles.css';
import { BLACK, colOf, idx, rowOf, Stone, WHITE } from './core/board';
import { BoardRenderer, COLUMN_LABELS } from './ui/board-renderer';
import { Game } from './store/game';
import { exportGameSgf, exportLineSgf, parseSgfToLine } from './store/game-io';
import { SgfLineMove } from './core/sgf';
import { deleteGame, getGame, listGames, saveGame } from './store/db';
import { Replay } from './store/replay';
import {
  getCachedModelBytes,
  importModelFromFile,
  LoadPhase,
  loadModelBytes,
  MODEL_B18,
} from './engine/model-loader';
import { AiPlayer, levelOf } from './engine/ai-player';
import { AnalysisClient } from './engine/analysis-client';
import { AnalysisSnapshot, AnalysisState } from './engine/analysis-engine';
import { VARIATION_DEPTH, VARIATION_PLAYOUTS } from './engine/analysis-engine';
import { KOMI_AREA } from './core/scoring';
import { PASS } from './engine/mcts';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell">
    <h1>围棋 · 本地对弈</h1>
    <div id="load-bar-wrap" class="load-bar-wrap hidden">
      <div id="load-bar-fill" class="load-bar-fill"></div>
      <span id="load-bar-text" class="load-bar-text"></span>
    </div>
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
        <option value="easy">入门</option>
        <option value="normal" selected>进阶</option>
        <option value="hard">高手</option>
      </select>
      <button id="btn-pass" class="btn">虚着</button>
      <button id="btn-undo" class="btn">悔棋</button>
      <button id="btn-restart" class="btn primary">新对局</button>
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
        <div class="model-panel">
          <div class="library-head">
            <h2>AI 模型</h2>
            <div class="library-actions">
              <button id="btn-load-model" class="btn small" title="从网络下载权重">下载</button>
              <button id="btn-import-model" class="btn small" title="从本地文件导入权重">导入</button>
            </div>
          </div>
          <div id="model-status" class="g-empty">检查中…</div>
          <a id="model-manual-link" class="model-hint" target="_blank" rel="noopener" href="${MODEL_B18.urls[0]}">网络下载受限?点此在浏览器中打开权重文件,再用「导入」加载</a>
          <input id="model-file-input" type="file" accept=".bin,.bin.gz,.gz" class="hidden" />
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
const aiPlayer = new AiPlayer();

/** 回放分析:Worker 客户端与展示状态 */
const analysisClient = new AnalysisClient();
let analysisSnapshot: AnalysisSnapshot | null = null;
let variationLine: number[] = [];
let analysisTimer: ReturnType<typeof setTimeout> | null = null;
let analysisBackend = '';

const analysisPanel = document.querySelector<HTMLDivElement>('#analysis-panel')!;
const analysisStatusEl = document.querySelector<HTMLSpanElement>('#analysis-status')!;
const candidateListEl = document.querySelector<HTMLUListElement>('#candidate-list')!;
const variationListEl = document.querySelector<HTMLDivElement>('#variation-list')!;
/** 是否轮到 AI 行棋(且非回放模式) */
function isAiTurn(): boolean {
  if (mode !== 'play' || game.isFinished) return false;
  if (vsMode === 'ai-black') return game.currentStone === BLACK;
  if (vsMode === 'ai-white') return game.currentStone === WHITE;
  return false;
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

function refresh(): void {
  const displayBoard = mode === 'replay' && replay ? replay.board() : game.getBoard();
  const lastMove = mode === 'replay' && replay ? replay.lastPlayPos() : game.getLastPlayPos();
  const analysis =
    mode === 'replay' && replay
      ? {
          candidates: (analysisSnapshot?.candidates ?? []).map((c) => ({ pos: c.pos, winRate: c.winRate })),
          ...(variationLine.length > 0
            ? {
                variation: {
                  stone: replay.nextStone(),
                  moves: variationLine.map((pos, i) => ({ pos, order: i + 1 })),
                },
              }
            : {}),
        }
      : undefined;
  board.setState({ board: displayBoard, lastMove, ghost, analysis });

  const replayControls = document.querySelector<HTMLDivElement>('#replay-controls')!;
  const playButtons = [
    document.querySelector<HTMLButtonElement>('#btn-pass')!,
    document.querySelector<HTMLButtonElement>('#btn-undo')!,
  ];
  if (mode === 'replay' && replay) {
    replayControls.classList.remove('hidden');
    for (const b of playButtons) b.disabled = true;
    moveCountEl.textContent = `第 ${replay.pos}/${replay.moveCount} 手`;
    statusEl.textContent = '棋谱回放';
    resultPanel.classList.add('hidden');
    updateAutoplayButton();
    return;
  }

  replayControls.classList.add('hidden');
  for (const b of playButtons) b.disabled = false;
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
      <span>白:${r.whiteScore.toFixed(2)} 子(子 ${r.whiteStones} + 空 ${r.whiteTerritory} + 贴 3.75)</span>
      <span class="winner">${r.margin >= 0 ? '黑胜' : '白胜'} ${Math.abs(r.margin).toFixed(2)} 子</span>
    `;
  } else {
    statusEl.textContent = `${stoneName(game.currentStone)}棋落子`;
    resultPanel.classList.add('hidden');
  }
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
  void maybeAiMove();
}

/** 轮到 AI 时驱动思考落子(思考中/未就绪时静默跳过) */
async function maybeAiMove(): Promise<void> {
  if (!isAiTurn() || aiPlayer.thinking) return;
  if (!aiPlayer.isReady) {
    messageEl.textContent = 'AI 模型未加载:请先在侧栏下载或导入模型';
    return;
  }
  const level = levelOf(levelSelect.value);
  try {
    // 先刷新展示“AI 思考中…”(think 阻塞期间状态栏即时反馈)
    refresh();
    const move = await aiPlayer.think(game, level.config);
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
    refresh();
    void maybeAiMove(); // 若 AI 连续行棋(或思考后仍轮到 AI)继续
  }
}

// ---- 回放暂停分析(Worker 持续分析 + 变化线) ----

/** 当前回放视角的分析局面 */
function analysisState(): AnalysisState | null {
  if (!replay) return null;
  const recentMoves = replay.recentMoves(5).map((m) => ({
    stone: m.stone as Stone,
    pos: m.col === null || m.row === null ? null : idx(m.col, m.row),
  }));
  return {
    board: replay.board(),
    stone: replay.nextStone(),
    recentMoves,
    komi: KOMI_AREA,
    prevHash: replay.prevHash(),
  };
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

/** 读取缓存模型并让 Worker 分析当前局面 */
async function startAnalysis(): Promise<void> {
  const state = analysisState();
  if (!state) return;
  try {
    const bytes = await getCachedModelBytes(MODEL_B18.id);
    if (!bytes) {
      analysisStatusEl.textContent = '未缓存模型';
      return;
    }
    analysisStatusEl.textContent = '准备中…';
    const backend = await analysisClient.ensure(bytes);
    analysisBackend = backend;
  } catch (e) {
    analysisStatusEl.textContent = '分析不可用';
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
analysisClient.callbacks.onVariationStep = (move, index) => {
  variationLine[index] = move;
  renderVariationList();
  refresh();
};
analysisClient.callbacks.onVariationDone = (line) => {
  variationLine = line;
  renderVariationList();
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
  const state = analysisState();
  if (!state) return;
  variationLine = [];
  renderVariationList();
  analysisStatusEl.textContent = '变化线展开中…';
  analysisClient.requestVariation(state, pos, VARIATION_DEPTH, VARIATION_PLAYOUTS);
  refresh();
});

// 点击落子(仅对弈模式)
canvas.addEventListener('click', (e) => {
  if (mode !== 'play' || aiPlayer.thinking || isAiTurn()) return;
  const rect = canvas.getBoundingClientRect();
  const pt = board.pixelToPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (!pt) return;
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
  board.setState({ board: game.getBoard(), lastMove: game.getLastPlayPos(), ghost });
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
  void maybeAiMove();
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
  if (aiPlayer.thinking) return;
  game.undo(1);
  messageEl.textContent = '已悔棋';
  refresh();
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
  void maybeAiMove();
});

// 初始渲染与窗口尺寸变化自适应
new ResizeObserver(() => board.resize()).observe(canvas);
board.resize();
refresh();
void renderLibrary();

// ---- 模型加载(下载/缓存/进度) ----
const loadBarWrap = document.querySelector<HTMLDivElement>('#load-bar-wrap')!;
const loadBarFill = document.querySelector<HTMLDivElement>('#load-bar-fill')!;
const loadBarText = document.querySelector<HTMLSpanElement>('#load-bar-text')!;
const modelStatusEl = document.querySelector<HTMLDivElement>('#model-status')!;
const modelFileInput = document.querySelector<HTMLInputElement>('#model-file-input')!;

let modelLoading = false;

const PHASE_TEXT: Record<LoadPhase, string> = {
  download: '下载模型',
  decompress: '解压模型',
};

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setLoadBar(show: boolean, percent: number, text: string): void {
  loadBarWrap.classList.toggle('hidden', !show);
  loadBarFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  loadBarText.textContent = text;
}

function setModelStatus(text: string): void {
  modelStatusEl.textContent = text;
}

async function refreshModelStatus(): Promise<void> {
  try {
    const cached = await getCachedModelBytes(MODEL_B18.id);
    setModelStatus(cached ? `已缓存 ${mb(cached.byteLength)}${aiPlayer.isReady ? ` · ${aiPlayer.backendLabel}` : ' · 未载入内存'}` : '未加载');
  } catch {
    setModelStatus('存储不可用');
  }
}

document.querySelector('#btn-load-model')!.addEventListener('click', async () => {
  if (modelLoading) return;
  modelLoading = true;
  setLoadBar(true, 0, `${PHASE_TEXT.download} 0%`);
  try {
    const bytes = await loadModelBytes(MODEL_B18, (phase, loaded, total) => {
      const percent = total ? (loaded / total) * 100 : 0;
      setLoadBar(true, percent, `${PHASE_TEXT[phase]} ${mb(loaded)}${total ? ` / ${mb(total)}` : ''}`);
    });
    await loadAiModel(bytes);
    messageEl.textContent = `模型「${MODEL_B18.name}」加载完成(${aiPlayer.backendLabel})`;
  } catch (e) {
    setModelStatus('下载失败');
    messageEl.textContent = `模型下载失败:${String(e)}。可点侧栏「手动下载」链接在浏览器中打开权重文件,再用「导入」按钮加载`;
  } finally {
    modelLoading = false;
    setLoadBar(false, 0, '');
    refresh();
    void maybeAiMove();
  }
});

document.querySelector('#btn-import-model')!.addEventListener('click', () => modelFileInput.click());
modelFileInput.addEventListener('change', async () => {
  const file = modelFileInput.files?.[0];
  modelFileInput.value = '';
  if (!file || modelLoading) return;
  modelLoading = true;
  setLoadBar(true, 0, `${PHASE_TEXT.decompress} 0%`);
  try {
    const bytes = await importModelFromFile(MODEL_B18, file, (phase, loaded) => {
      setLoadBar(true, 0, `${PHASE_TEXT[phase]} ${mb(loaded)}`);
    });
    await loadAiModel(bytes);
    messageEl.textContent = `模型已从 ${file.name} 导入(${aiPlayer.backendLabel})`;
  } catch (e) {
    setModelStatus('导入失败');
    messageEl.textContent = `模型导入失败:${String(e)}`;
  } finally {
    modelLoading = false;
    setLoadBar(false, 0, '');
    refresh();
    void maybeAiMove();
  }
});

/** 解析权重建网并更新状态(下载与导入共用) */
async function loadAiModel(bytes: ArrayBuffer): Promise<void> {
  setLoadBar(true, 0, '解析权重与初始化计算后端');
  setModelStatus('解析权重中…');
  await aiPlayer.loadModelBytes(new Uint8Array(bytes));
  setModelStatus(`就绪 ${mb(bytes.byteLength)} · ${aiPlayer.backendLabel} · ${aiPlayer.modelName ?? ''}`);
  scheduleAnalysis(); // 若正在回放暂停,让分析 Worker 也加载模型
}

void refreshModelStatus();
