import './styles.css';
import { BoardRenderer } from './ui/board-renderer';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell">
    <h1>围棋</h1>
    <div class="board-wrap">
      <canvas id="board"></canvas>
    </div>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const board = new BoardRenderer(canvas);

// 初始渲染与窗口尺寸变化自适应
board.resize();
new ResizeObserver(() => board.resize()).observe(canvas);
