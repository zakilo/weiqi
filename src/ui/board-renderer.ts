import { BOARD_SIZE } from '../core/board';

/** 标准 19 路星位(0 起始,列, 行) */
export const STAR_POINTS: ReadonlyArray<readonly [number, number]> = [
  [3, 3],
  [3, 9],
  [3, 15],
  [9, 3],
  [9, 9],
  [9, 15],
  [15, 3],
  [15, 9],
  [15, 15],
];

/** 列坐标字母(跳过 I,共 19 个) */
export const COLUMN_LABELS = 'ABCDEFGHJKLMNOPQRST';

/** Canvas 棋盘渲染器:木纹盘面、网格线、星位、坐标标注 */
export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  /** 显示尺寸(px,正方形) */
  private viewSize = 0;
  /** 线间距(px) */
  private cell = 0;
  /** 边缘留白(px,覆盖坐标标注) */
  private padding = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
    this.ctx = ctx;
  }

  /** 依据当前 canvas 显示尺寸重算布局,并适配高分屏 */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const view = Math.max(rect.width, 1);
    const dpr = window.devicePixelRatio || 1;
    this.viewSize = view;
    this.canvas.width = Math.round(view * dpr);
    this.canvas.height = Math.round(view * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 19 条线 18 个间隔;首尾各留半格给外圈与坐标,再各留一格给标注区
    this.cell = view / (BOARD_SIZE + 1);
    this.padding = this.cell;
    this.render();
  }

  /** 网格点(列, 行)对应的像素坐标 */
  pointToPixel(col: number, row: number): [number, number] {
    return [this.padding + col * this.cell, this.padding + row * this.cell];
  }

  /** 渲染完整盘面(空棋盘) */
  render(): void {
    const { ctx, viewSize, cell, padding } = this;
    ctx.clearRect(0, 0, viewSize, viewSize);

    this.drawWood();
    this.drawGrid();
    this.drawStars();
    this.drawCoordinates();

    // 木纹区域略超出最外圈线,收边
    const inner = padding - cell / 2;
    const span = cell * (BOARD_SIZE - 1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8a6a3b';
    ctx.strokeRect(inner, inner, span + cell, span + cell);
  }

  /** 木纹底色 */
  private drawWood(): void {
    const { ctx, viewSize, cell, padding } = this;
    const half = cell / 2;
    const grad = ctx.createLinearGradient(0, 0, viewSize, viewSize);
    grad.addColorStop(0, '#e9c47e');
    grad.addColorStop(1, '#d3a253');
    ctx.fillStyle = grad;
    ctx.fillRect(
      padding - half,
      padding - half,
      cell * (BOARD_SIZE - 1) + cell,
      cell * (BOARD_SIZE - 1) + cell,
    );
  }

  /** 网格线:19 横 19 纵,外圈线加粗 */
  private drawGrid(): void {
    const { ctx, cell, padding } = this;
    const span = cell * (BOARD_SIZE - 1);
    ctx.strokeStyle = '#4a3b28';
    for (let i = 0; i < BOARD_SIZE; i++) {
      const pos = padding + i * cell;
      // 外圈线略粗
      ctx.lineWidth = i === 0 || i === BOARD_SIZE - 1 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(padding, pos);
      ctx.lineTo(padding + span, pos);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pos, padding);
      ctx.lineTo(pos, padding + span);
      ctx.stroke();
    }
  }

  /** 星位:9 个实心圆 */
  private drawStars(): void {
    const { ctx } = this;
    ctx.fillStyle = '#4a3b28';
    for (const [col, row] of STAR_POINTS) {
      const [x, y] = this.pointToPixel(col, row);
      ctx.beginPath();
      ctx.arc(x, y, this.cell * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 坐标标注:上下边标列字母,左右边标行数字(从上到下 1-19) */
  private drawCoordinates(): void {
    const { ctx, cell, padding } = this;
    ctx.fillStyle = '#6b5636';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fontSize = Math.max(cell * 0.32, 8);
    ctx.font = `${fontSize}px sans-serif`;
    for (let i = 0; i < BOARD_SIZE; i++) {
      const label = COLUMN_LABELS[i];
      const rowLabel = String(i + 1);
      const topY = padding - cell;
      const bottomY = padding + cell * (BOARD_SIZE - 1) + cell;
      const leftX = padding - cell;
      const rightX = padding + cell * (BOARD_SIZE - 1) + cell;
      const x = padding + i * cell;
      ctx.fillText(label, x, topY);
      ctx.fillText(label, x, bottomY);
      ctx.fillText(rowLabel, leftX, padding + i * cell);
      ctx.fillText(rowLabel, rightX, padding + i * cell);
    }
  }
}
