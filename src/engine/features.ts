/**
 * KataGo v7 输入特征编码(22 spatial + 19 global 通道)。
 * 与 C++ 版 fillRowV7 语义一致;本项目规则固定为中国规则
 * (simple ko、数子、禁自杀),故规则通道多为常量 0。
 */
import { Board, BOARD_SIZE, EMPTY, WHITE, Stone, opponent } from '../core/board';

export const INPUT_SPATIAL_CHANNELS = 22;
export const INPUT_GLOBAL_CHANNELS = 19;

/** 一手棋:pos 为棋盘索引,null 表示虚着 */
export interface EncodedMove {
  stone: Stone;
  pos: number | null;
}

export interface EncodedFeatures {
  /** [19*19, 22] NHWC */
  spatial: Float32Array;
  /** [19] */
  global: Float32Array;
}

export interface EncodeOptions {
  /** 贴目(白为正,与 SGF KM 一致);默认 7.5 */
  komi?: number;
}

/**
 * 编码一个局面为 KataGo v7 输入。
 * recentMoves 须按时间升序,最后一项为最近一手。
 */
export function encodeFeatures(
  board: Board,
  currentPlayer: Stone,
  recentMoves: readonly EncodedMove[],
  options: EncodeOptions = {},
): EncodedFeatures {
  const komi = options.komi ?? 7.5;
  const spatial = new Float32Array(BOARD_SIZE * BOARD_SIZE * INPUT_SPATIAL_CHANNELS);
  const global = new Float32Array(INPUT_GLOBAL_CHANNELS);

  // 通道 0:全 1(在盘上)
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) spatial[i * INPUT_SPATIAL_CHANNELS] = 1;

  // 通道 1/2:当前方 / 对方棋子
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    const v = board.get(i);
    if (v === EMPTY) continue;
    if (v === currentPlayer) spatial[i * INPUT_SPATIAL_CHANNELS + 1] = 1;
    else spatial[i * INPUT_SPATIAL_CHANNELS + 2] = 1;
  }

  // 通道 3/4/5:1/2/3 气的连通块(任意颜色)
  const visited = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    if (visited[i]) continue;
    if (board.get(i) === EMPTY) continue;
    const group = board.groupOf(i);
    for (const p of group) visited[p] = 1;
    const liberties = board.countLiberties(group);
    const plane = liberties === 1 ? 3 : liberties === 2 ? 4 : liberties === 3 ? 5 : -1;
    if (plane >= 0) {
      for (const p of group) spatial[p * INPUT_SPATIAL_CHANNELS + plane] = 1;
    }
  }

  // 通道 9-13:最近 5 手落点(9=最近);global 0-4:最近 5 手是否虚着。
  // 与 KataGo 一致:从当前方视角,交替顺序必须为 [对方, 己方, 对方, 己方, 对方],
  // 顺序不符即停止(例如打劫提回等罕见历史会截断)。
  const expectedPlayers: Stone[] = [opponent(currentPlayer), currentPlayer, opponent(currentPlayer), currentPlayer, opponent(currentPlayer)];
  for (let i = 0; i < 5; i++) {
    const m = recentMoves[recentMoves.length - 1 - i];
    if (!m || m.stone !== expectedPlayers[i]) break;
    if (m.pos === null) {
      global[i] = 1;
    } else {
      spatial[m.pos * INPUT_SPATIAL_CHANNELS + 9 + i] = 1;
    }
  }

  // global 5:selfKomi / 20(白为正)
  const selfKomi = currentPlayer === WHITE ? komi : -komi;
  global[5] = selfKomi / 20;

  // global 6/7:ko 规则(simple → 0/0,默认即 0)
  // global 8:multiStoneSuicideLegal(本项目禁自杀 → 0)
  // global 9:territory scoring(本项目中国规则数子 → 0)
  // global 10/11:tax(无 → 0)
  // global 17:button(无 → 0)

  // global 14:上一手是虚着,则再虚着终局
  const lastMove = recentMoves[recentMoves.length - 1];
  if (lastMove && lastMove.pos === null) global[14] = 1;

  // global 18:komi parity wave(数子规则下总是启用)
  {
    const boardAreaIsEven = (BOARD_SIZE * BOARD_SIZE) % 2 === 0;
    const komiFloor = boardAreaIsEven
      ? Math.floor(selfKomi / 2) * 2
      : Math.floor((selfKomi - 1) / 2) * 2 + 1;
    let delta = selfKomi - komiFloor;
    if (delta < 0) delta = 0;
    if (delta > 2) delta = 2;
    let wave: number;
    if (delta < 0.5) wave = delta;
    else if (delta < 1.5) wave = 1 - delta;
    else wave = delta - 2;
    global[18] = wave;
  }

  return { spatial, global };
}
