import { colOf, rowOf } from '../core/board';
import {
  buildSgfDoc,
  extractMainLine,
  parseSgf,
  SgfGameMeta,
  SgfLineMove,
  serializeSgf,
} from '../core/sgf';
import { Game } from './game';

/** 对局手顺转 SGF 主线手顺(虚着 col/row 为 null) */
export function gameToLineMoves(game: Game): SgfLineMove[] {
  return game.getMoves().map((m) =>
    m.kind === 'play'
      ? { stone: m.stone, col: colOf(m.pos), row: rowOf(m.pos) }
      : { stone: m.stone, col: null, row: null },
  );
}

/** 对局导出为 SGF 文本;终局时写入结果(如 B+3.75) */
export function exportGameSgf(game: Game): string {
  const meta: SgfGameMeta = {
    blackName: '黑方',
    whiteName: '白方',
  };
  if (game.result) {
    const r = game.result;
    meta.result = r.margin >= 0 ? `B+${r.margin.toFixed(2)}` : `W+${(-r.margin).toFixed(2)}`;
  }
  return serializeSgf(buildSgfDoc(gameToLineMoves(game), meta));
}

/** SGF 文本解析为主线手顺;非法文本返回 null */
export function parseSgfToLine(text: string): SgfLineMove[] | null {
  const root = parseSgf(text);
  if (!root) return null;
  return extractMainLine(root);
}
