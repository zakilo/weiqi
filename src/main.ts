import './styles.css';
import { BLACK, colOf, idx, rowOf, Stone, WHITE } from './core/board';
import { BoardRenderer, COLUMN_LABELS } from './ui/board-renderer';
import { Game } from './store/game';
import { exportGameSgf, parseSgfToLine } from './store/game-io';
import { deleteGame, getGame, listGames, saveGame } from './store/db';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell">
    <h1>围棋 · 本地对弈</h1>
    <div class="toolbar">
      <span id="status" class="status"></span>
      <span id="move-count" class="dim"></span>
      <div class="spacer"></div>
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
  board.setState({
    board: game.getBoard(),
    lastMove: game.getLastPlayPos(),
    ghost,
  });
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

// 点击落子
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const pt = board.pixelToPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (!pt) return;
  tryPlay(pt.col, pt.row);
});

// 悬停预览
canvas.addEventListener('mousemove', (e) => {
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

/** 从棋谱库打开并重建对局 */
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
  game.loadMoves(line);
  messageEl.textContent = `已打开「${rec.name}」,共 ${game.moveCount} 手`;
  refresh();
}

// 当前对局存入棋谱库

document.querySelector('#btn-save')!.addEventListener('click', async () => {
  if (game.moveCount === 0) {
    messageEl.textContent = '尚未落子,无法保存';
    return;
  }
  const text = exportGameSgf(game);
  const now = new Date();
  const name = `对局 ${timeText(now.getTime())}`;
  await saveGame({ name, sgfText: text, moveCount: game.moveCount, createdAt: now.getTime() });
  messageEl.textContent = `「${name}」已存入棋谱库`;
  void renderLibrary();
});

// 导出当前对局为 SGF 文件

document.querySelector('#btn-export')!.addEventListener('click', () => {
  if (game.moveCount === 0) {
    messageEl.textContent = '尚未落子,无法导出';
    return;
  }
  const text = exportGameSgf(game);
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
  messageEl.textContent = `已导出 ${game.moveCount} 手棋谱`;
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
    if (!game.loadMoves(line)) {
      messageEl.textContent = '棋谱含非法手,仅加载了部分手顺';
    } else {
      messageEl.textContent = `已导入 ${file.name},共 ${game.moveCount} 手`;
    }
    refresh();
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
  game.restart();
  messageEl.textContent = '新对局开始';
  refresh();
});

// 初始渲染与窗口尺寸变化自适应
new ResizeObserver(() => board.resize()).observe(canvas);
board.resize();
refresh();
void renderLibrary();
