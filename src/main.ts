import './styles.css';
import { BLACK, colOf, idx, rowOf, Stone, WHITE } from './core/board';
import { BoardRenderer, COLUMN_LABELS } from './ui/board-renderer';
import { Game } from './store/game';
import { exportGameSgf, parseSgfToLine } from './store/game-io';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell">
    <h1>围棋 · 本地对弈</h1>
    <div class="toolbar">
      <span id="status" class="status"></span>
      <span id="move-count" class="dim"></span>
      <div class="spacer"></div>
      <button id="btn-save" class="btn">保存棋谱</button>
      <button id="btn-import" class="btn">导入棋谱</button>
      <button id="btn-pass" class="btn">虚着</button>
      <button id="btn-undo" class="btn">悔棋</button>
      <button id="btn-restart" class="btn primary">新对局</button>
      <input id="file-input" type="file" accept=".sgf" class="hidden" />
    </div>
    <div class="board-wrap">
      <canvas id="board"></canvas>
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

document.querySelector('#btn-save')!.addEventListener('click', () => {
  if (game.moveCount === 0) {
    messageEl.textContent = '尚未落子,无法保存';
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
  messageEl.textContent = `已保存 ${game.moveCount} 手棋谱`;
});

const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;
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
