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
        <div class="model-panel">
          <div class="library-head">
            <h2>AI 模型</h2>
            <div class="library-actions">
              <button id="btn-load-model" class="btn small" title="从网络下载权重">下载</button>
              <button id="btn-import-model" class="btn small" title="从本地文件导入权重">导入</button>
            </div>
          </div>
          <div id="model-status" class="g-empty">检查中…</div>
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

const board = new BoardRenderer(canvas);
const game = new Game();
let ghost: { pos: number; stone: Stone } | null = null;

/** 交互模式:play = 正常对弈;replay = 棋谱回放 */
let mode: 'play' | 'replay' = 'play';
let replay: Replay | null = null;
let autoplayTimer: ReturnType<typeof setInterval> | null = null;

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
  board.setState({ board: displayBoard, lastMove, ghost });

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
  if (game.isFinished && game.result) {
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
}

// 点击落子(仅对弈模式)
canvas.addEventListener('click', (e) => {
  if (mode !== 'play') return;
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
  ghost = null;
  board.setState({ board: game.getBoard(), lastMove: game.getLastPlayPos(), ghost });
});

document.querySelector('#btn-pass')!.addEventListener('click', () => {
  game.pass();
  messageEl.textContent = game.isFinished ? '双方虚着,终局数子' : `${stoneName(game.currentStone)}虚着`;
  refresh();
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
  refresh();
}

document.querySelector('#btn-first')!.addEventListener('click', () => {
  replay?.start();
  refresh();
});
document.querySelector('#btn-prev')!.addEventListener('click', () => {
  replay?.step(-1);
  refresh();
});
document.querySelector('#btn-next')!.addEventListener('click', () => {
  stopAutoplay();
  replay?.step(1);
  refresh();
});
document.querySelector('#btn-last')!.addEventListener('click', () => {
  replay?.end();
  refresh();
});
document.querySelector('#btn-autoplay')!.addEventListener('click', () => {
  if (!replay) return;
  if (autoplayTimer !== null) {
    stopAutoplay();
  } else {
    autoplayTimer = setInterval(() => {
      if (!replay || replay.isAtEnd()) {
        stopAutoplay();
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
  game.undo(1);
  messageEl.textContent = '已悔棋';
  refresh();
});
document.querySelector('#btn-restart')!.addEventListener('click', () => {
  stopAutoplay();
  mode = 'play';
  replay = null;
  game.restart();
  messageEl.textContent = '新对局开始';
  refresh();
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
    setModelStatus(cached ? `就绪 ${mb(cached.byteLength)}` : '未加载');
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
    setModelStatus(`就绪 ${mb(bytes.byteLength)}`);
    messageEl.textContent = `模型「${MODEL_B18.name}」加载完成`;
  } catch (e) {
    setModelStatus('下载失败');
    messageEl.textContent = `模型加载失败:${String(e)}`;
  } finally {
    modelLoading = false;
    setLoadBar(false, 0, '');
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
    setModelStatus(`就绪 ${mb(bytes.byteLength)}`);
    messageEl.textContent = `模型已从 ${file.name} 导入`;
  } catch (e) {
    setModelStatus('导入失败');
    messageEl.textContent = `模型导入失败:${String(e)}`;
  } finally {
    modelLoading = false;
    setLoadBar(false, 0, '');
  }
});

void refreshModelStatus();
