import { BLACK, Board, BOARD_SIZE, colOf, EMPTY, opponent, rowOf, Stone } from '../core/board';

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

/** 渲染状态:盘面、最后一手、悬停预览、分析标记 */
export interface RenderState {
  board: Board;
  lastMove: number | null;
  ghost: { pos: number; stone: Stone } | null;
  /** AI 分析标记(回放分析与对局提示共用) */
  analysis?: {
    /** 候选着法(0..360 落点,361=虚着)与行棋方视角胜率;best 高亮推荐的最佳手 */
    candidates: { pos: number; winRate: number; best?: boolean }[];
    /** 变化线(含首手),与行棋方起始颜色 */
    variation?: { stone: Stone; moves: { pos: number; order: number }[] };
  };
  /** 点目模式:标记为死子的位置(盘上画 X) */
  deadStones?: number[];
}

/** 盘面布局度量(纯函数,便于对窄屏做单测断言) */
export interface BoardMetrics {
  /** 网格间距(px) */
  cell: number;
  /** 最外圈网格线到画布边缘的距离(px) */
  padding: number;
  /** 收边线到边缘的距离(px) */
  border: number;
  /** 坐标文字中心到边缘的距离(px) */
  labelEdge: number;
  /** 坐标字号(px) */
  labelFont: number;
}

/**
 * 19 条线 18 个间隔,首尾各留 2 格:
 * 外圈坐标带(padding 以外的环)里,文字居中于 labelEdge,收边线在更内侧,
 * 保证任何画布宽度下都不会出现“线压字 / 字被裁切”。
 */
export function boardMetrics(view: number): BoardMetrics {
  const cell = view / (BOARD_SIZE - 1 + 4);
  const padding = cell * 2;
  // 字号随画布缩放(小屏下限同样按比例,保证文字永远落在坐标带内)
  const labelFont = Math.max(cell * 0.32, Math.min(8, view / 44));
  return {
    cell,
    padding,
    border: padding - cell * 0.95,
    labelEdge: cell * 0.45,
    labelFont,
  };
}

/** Canvas 棋盘渲染器:木纹盘面、网格线、星位、坐标标注 */
export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  /** 显示尺寸(px,正方形) */
  private viewSize = 0;
  /** 线间距(px) */
  private cell = 0;
  /** 边缘留白(px,覆盖坐标标注) */
  private padding = 0;
  /** 收边线到边缘的距离(px) */
  private borderInset = 0;
  /** 坐标文字中心到边缘的距离(px) */
  private labelEdge = 0;
  /** 坐标字号(px) */
  private labelFont = 0;
  /** 当前渲染状态(棋盘棋子等动态内容) */
  private state: RenderState | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
    this.ctx = ctx;
  }

  /** 更新动态内容并重绘 */
  setState(state: RenderState): void {
    this.state = state;
    this.render();
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
    // 布局度量集中在 boardMetrics(),保证坐标与外框线互不遮挡
    const m = boardMetrics(view);
    this.cell = m.cell;
    this.padding = m.padding;
    this.borderInset = m.border;
    this.labelEdge = m.labelEdge;
    this.labelFont = m.labelFont;
    this.render();
  }

  /** 网格点(列, 行)对应的像素坐标 */
  pointToPixel(col: number, row: number): [number, number] {
    return [this.padding + col * this.cell, this.padding + row * this.cell];
  }

  /** 像素坐标反查最近的网格点;距交点过远时返回 null */
  pixelToPoint(px: number, py: number): { col: number; row: number } | null {
    const col = Math.round((px - this.padding) / this.cell);
    const row = Math.round((py - this.padding) / this.cell);
    if (col < 0 || col >= BOARD_SIZE || row < 0 || row >= BOARD_SIZE) return null;
    const [x, y] = this.pointToPixel(col, row);
    if (Math.hypot(px - x, py - y) > this.cell * 0.55) return null;
    return { col, row };
  }

  /** 渲染完整盘面(空棋盘) */
  render(): void {
    const { ctx, viewSize, cell, padding } = this;
    ctx.clearRect(0, 0, viewSize, viewSize);

    this.drawWood();
    this.drawGrid();
    this.drawStars();
    this.drawCoordinates();
    if (this.state) {
      this.drawState(this.state);
      if (this.state.analysis) this.drawAnalysis(this.state.analysis);
    }

    // 收边线:位于坐标标注与最外圈网格线之间
    const span = cell * (BOARD_SIZE - 1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8a6a3b';
    ctx.strokeRect(this.borderInset, this.borderInset, span + (padding - this.borderInset) * 2, span + (padding - this.borderInset) * 2);
  }

  /** 棋子、最后一手标记、悬停预览 */
  private drawState(state: RenderState): void {
    const { board, lastMove, ghost } = state;
    const dead = new Set(state.deadStones ?? []);
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const pos = row * BOARD_SIZE + col;
        const v = board.get(pos);
        if (v === EMPTY) continue;
        const [x, y] = this.pointToPixel(col, row);
        const isDead = dead.has(pos);
        this.drawStone(x, y, v as Stone, isDead ? 0.42 : 1, isDead);
      }
    }
    if (lastMove !== null) {
      const [x, y] = this.pointToPixel(colOf(lastMove), rowOf(lastMove));
      const v = board.get(lastMove);
      this.ctx.fillStyle = v === BLACK ? '#f5f5f5' : '#222';
      this.ctx.beginPath();
      this.ctx.arc(x, y, this.cell * 0.14, 0, Math.PI * 2);
      this.ctx.fill();
    }
    if (ghost && board.get(ghost.pos) === EMPTY) {
      const [x, y] = this.pointToPixel(colOf(ghost.pos), rowOf(ghost.pos));
      this.drawStone(x, y, ghost.stone, 0.55);
    }
  }

  /** 分析标记:候选点胜率圆标 + 变化线半透明棋子与编号 */
  private drawAnalysis(a: NonNullable<RenderState['analysis']>): void {
    const { ctx, cell } = this;
    // 候选点:圆标 + 胜率百分比(最佳手金色高亮,其余蓝色;虚着不画在盘上)
    for (const c of a.candidates) {
      if (c.pos === BOARD_SIZE * BOARD_SIZE) continue;
      const [x, y] = this.pointToPixel(colOf(c.pos), rowOf(c.pos));
      ctx.beginPath();
      ctx.arc(x, y, cell * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = c.best ? 'rgba(214, 158, 34, 0.42)' : 'rgba(30, 110, 190, 0.28)';
      ctx.fill();
      ctx.strokeStyle = c.best ? '#a06f10' : '#1b5fa8';
      ctx.lineWidth = c.best ? 2 : 1.5;
      ctx.stroke();
      ctx.fillStyle = c.best ? '#6d4708' : '#0e3d70';
      ctx.font = `bold ${Math.max(cell * 0.3, 9)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(c.winRate * 100)}`, x, y);
    }
    // 变化线:半透明棋子 + 步序编号(虚着不画在盘上)
    const variation = a.variation;
    if (!variation) return;
    for (const { pos, order } of variation.moves) {
      if (pos >= BOARD_SIZE * BOARD_SIZE) continue;
      const stone: Stone = order % 2 === 1 ? variation.stone : opponent(variation.stone);
      const [x, y] = this.pointToPixel(colOf(pos), rowOf(pos));
      this.drawStone(x, y, stone, 0.62);
      ctx.beginPath();
      ctx.arc(x + cell * 0.24, y - cell * 0.24, cell * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#333333';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#222222';
      ctx.font = `bold ${Math.max(cell * 0.24, 8)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(order), x + cell * 0.24, y - cell * 0.24);
    }
  }

  /** 单枚棋子(径向渐变 + 描边);alpha 用于悬停预览/死子半透明,dashed 用于死子虚线描边 */
  private drawStone(x: number, y: number, stone: Stone, alpha = 1, dashed = false): void {
    const { ctx, cell } = this;
    const r = cell * 0.46;
    ctx.save();
    ctx.globalAlpha = alpha;
    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    if (stone === BLACK) {
      grad.addColorStop(0, '#5a5a5a');
      grad.addColorStop(1, '#0a0a0a');
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, '#c8c8c8');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (dashed) {
      ctx.setLineDash([cell * 0.14, cell * 0.1]);
      ctx.strokeStyle = stone === BLACK ? 'rgba(255, 255, 255, 0.95)' : 'rgba(50, 50, 50, 0.95)';
      ctx.lineWidth = Math.max(cell * 0.07, 1.5);
    } else {
      ctx.strokeStyle = stone === BLACK ? '#000' : '#9a9a9a';
      ctx.lineWidth = 1;
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 木纹底色 */
  private drawWood(): void {
    const { ctx, viewSize } = this;
    const grad = ctx.createLinearGradient(0, 0, viewSize, viewSize);
    grad.addColorStop(0, '#e9c47e');
    grad.addColorStop(1, '#d3a253');
    ctx.fillStyle = grad;
    // 木纹铺满画布,坐标标注带也在木纹上
    ctx.fillRect(0, 0, viewSize, viewSize);
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
    const { ctx, cell, padding, viewSize } = this;
    ctx.fillStyle = '#6b5636';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${this.labelFont}px sans-serif`;
    // 坐标中心线:内缩到画布边缘以内,且始终位于收边线外侧
    const edge = this.labelEdge;
    for (let i = 0; i < BOARD_SIZE; i++) {
      const label = COLUMN_LABELS[i];
      const rowLabel = String(i + 1);
      const topY = edge;
      const bottomY = viewSize - edge;
      const leftX = edge;
      const rightX = viewSize - edge;
      const x = padding + i * cell;
      ctx.fillText(label, x, topY);
      ctx.fillText(label, x, bottomY);
      ctx.fillText(rowLabel, leftX, padding + i * cell);
      ctx.fillText(rowLabel, rightX, padding + i * cell);
    }
  }
}
