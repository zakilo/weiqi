/**
 * 形势判断:分析快照根评估的视角换算与文案(纯函数,可单测)。
 * KataGo rootInfo.winrate/scoreLead 均为行棋方视角,展示统一换算为黑方视角。
 */
import type { AnalyzeSnapshot } from './protocol';

/** 黑方视角的形势评估 */
export interface BlackEval {
  /** 黑方胜率(0..1) */
  blackWinRate: number;
  /** 黑方目差(正 = 黑领先,单位:子) */
  blackLead: number;
}

/** 行棋方视角的根评估 → 黑方视角 */
export function blackEvalOf(
  snapshot: Pick<AnalyzeSnapshot, 'rootValue' | 'rootScoreLead'>,
  toMove: 'B' | 'W',
): BlackEval {
  if (toMove === 'B') {
    return { blackWinRate: snapshot.rootValue, blackLead: snapshot.rootScoreLead };
  }
  return { blackWinRate: 1 - snapshot.rootValue, blackLead: -snapshot.rootScoreLead };
}

/** 目差文案:"形势接近"(1 子内)/ "黑领先 4.5 子" / "白领先 2.0 子" */
export function leadText(blackLead: number): string {
  const value = Math.abs(blackLead);
  if (value < 1) return '形势接近';
  return `${blackLead > 0 ? '黑' : '白'}领先 ${value.toFixed(1)} 子`;
}
