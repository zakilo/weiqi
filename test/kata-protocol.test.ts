import { describe, expect, it } from 'vitest';
import {
  buildAnalysisQuery,
  parseAnalysis,
  parseHumanThink,
  parseThink,
  pickMoveByPolicy,
  pickMoveByTemperature,
  sanitizeKomi,
  toSnapshot,
  type AnalysisResponse,
} from '../server/engine/protocol.ts';
import { PASS, kataGoToPos } from '../server/engine/coords.ts';
import type { AiMoveRequest, CandidateWire } from '../src/engine/remote/protocol.ts';

/** 棋盘索引:pos = row*19 + col(row 0 在上) */
const idx = (col: number, row: number): number => row * 19 + col;

const REQUEST: AiMoveRequest = {
  moves: [
    { stone: 'B', pos: idx(3, 15) },
    { stone: 'W', pos: null },
  ],
  komi: 3.75,
  rules: 'chinese',
};

describe('buildAnalysisQuery', () => {
  it('手顺与坐标转换,固定 19x19', () => {
    const q = buildAnalysisQuery(REQUEST);
    // idx(3,15): col=3 → 'D',num=19-15=4 → D4;虚着 → 'pass'
    expect(q.moves).toEqual([
      ['B', 'D4'],
      ['W', 'pass'],
    ]);
    expect(q.rules).toBe('chinese');
    // KataGo 不接受 3.75,buildAnalysisQuery 就近取半 → 4.0
    expect(q.komi).toBe(4);
    expect(q.boardXSize).toBe(19);
    expect(q.boardYSize).toBe(19);
    expect('maxVisits' in q).toBe(false);
    expect('reportDuringSearchEvery' in q).toBe(false);
  });

  it('可选字段仅在为正数时写入(向下取整)', () => {
    const q = buildAnalysisQuery(REQUEST, { maxVisits: 200.9, reportDuringSearchEvery: 40 });
    expect(q.maxVisits).toBe(200);
    expect(q.reportDuringSearchEvery).toBe(40);
  });

  it('非正数的可选字段被忽略', () => {
    const q = buildAnalysisQuery(REQUEST, { maxVisits: 0, reportDuringSearchEvery: -1 });
    expect(q.maxVisits).toBeUndefined();
    expect(q.reportDuringSearchEvery).toBeUndefined();
  });

  it('includePolicy 与 overrideSettings 按需透传', () => {
    const q = buildAnalysisQuery(REQUEST, {
      maxVisits: 50,
      includePolicy: true,
      overrideSettings: { humanSLProfile: 'rank_5k', ignorePreRootHistory: false },
    });
    expect(q.includePolicy).toBe(true);
    expect(q.overrideSettings).toEqual({ humanSLProfile: 'rank_5k', ignorePreRootHistory: false });
  });

  it('缺省不写 includePolicy/overrideSettings', () => {
    const q = buildAnalysisQuery(REQUEST);
    expect('includePolicy' in q).toBe(false);
    expect('overrideSettings' in q).toBe(false);
  });
});

describe('sanitizeKomi', () => {
  it('就近取半,已是半整数则不变', () => {
    expect(sanitizeKomi(3.75)).toBe(4);
    expect(sanitizeKomi(3.25)).toBe(3.5);
    expect(sanitizeKomi(7.5)).toBe(7.5);
    expect(sanitizeKomi(6)).toBe(6);
    // Math.round 对 .5 向 +∞ 取整:-3.75 → -3.5
    expect(sanitizeKomi(-3.75)).toBe(-3.5);
  });
  it('越界夹到 [-400,400],非数值回退 0', () => {
    expect(sanitizeKomi(500)).toBe(400);
    expect(sanitizeKomi(-500)).toBe(-400);
    expect(sanitizeKomi(Number.NaN)).toBe(0);
  });
});

describe('parseAnalysis', () => {
  it('按访问次数降序,忽略非法着法,pv 转索引', () => {
    const response: AnalysisResponse = {
      moveInfos: [
        { move: 'pass', visits: 5, winrate: 0.4, scoreLead: -1, prior: 0.05, pv: ['pass'] },
        { move: 'D4', visits: 10, winrate: 0.5, scoreLead: 1.2, prior: 0.1, pv: ['D4', 'Q16', 'pass'] },
        { move: 'I5', visits: 99 }, // 非法列(跳过 I)
        { move: 'ZZ', visits: 88 }, // 非法
      ],
      rootInfo: { winrate: 0.6, scoreLead: 2.5, visits: 15 },
    };
    const parsed = parseAnalysis(response);

    expect(parsed.candidates.map((c) => c.pos)).toEqual([idx(3, 15), PASS]);
    expect(parsed.candidates[0]!.visits).toBe(10);
    expect(parsed.candidates[0]!.pv).toEqual([idx(3, 15), kataGoToPos('Q16')!, PASS]);
    expect(parsed.bestMove).toBe(idx(3, 15));
    expect(parsed.rootWinrate).toBe(0.6);
    expect(parsed.rootScoreLead).toBe(2.5);
    expect(parsed.visits).toBe(15);
  });

  it('空响应 → 无候选,最佳为虚着,访问为 0', () => {
    const parsed = parseAnalysis({});
    expect(parsed.candidates).toEqual([]);
    expect(parsed.bestMove).toBe(PASS);
    expect(parsed.visits).toBe(0);
    expect(parsed.rootWinrate).toBe(0);
  });

  it('无 rootInfo.visits 时以候选访问数求和兜底', () => {
    const parsed = parseAnalysis({
      moveInfos: [
        { move: 'D4', visits: 7 },
        { move: 'pass', visits: 3 },
      ],
    });
    expect(parsed.visits).toBe(10);
  });

  it('缺失数值字段按 0 处理', () => {
    const parsed = parseAnalysis({ moveInfos: [{ move: 'D4' }] });
    expect(parsed.candidates[0]).toMatchObject({
      pos: idx(3, 15),
      visits: 0,
      winRate: 0,
      scoreLead: 0,
      prior: 0,
      pv: [],
    });
  });
});

describe('pickMoveByTemperature', () => {
  const cands: CandidateWire[] = [
    { pos: idx(3, 15), visits: 10, winRate: 0, scoreLead: 0, prior: 0, pv: [] },
    { pos: idx(15, 3), visits: 5, winRate: 0, scoreLead: 0, prior: 0, pv: [] },
  ];

  it('空候选 → 虚着', () => {
    expect(pickMoveByTemperature([], 1)).toBe(PASS);
  });

  it('温度 <= 0 → 取最优(访问最多)', () => {
    expect(pickMoveByTemperature(cands, 0)).toBe(idx(3, 15));
    expect(pickMoveByTemperature(cands, -1)).toBe(idx(3, 15));
  });

  it('温度 > 0 时按 rng 采样,可复现', () => {
    expect(pickMoveByTemperature(cands, 1, () => 0)).toBe(idx(3, 15));
    expect(pickMoveByTemperature(cands, 1, () => 0.999999)).toBe(idx(15, 3));
  });

  it('权重全为零时退化为取最优', () => {
    const zeros: CandidateWire[] = [
      { pos: 1, visits: 0, winRate: 0, scoreLead: 0, prior: 0, pv: [] },
      { pos: 2, visits: 0, winRate: 0, scoreLead: 0, prior: 0, pv: [] },
    ];
    expect(pickMoveByTemperature(zeros, 1, () => 0.9)).toBe(1);
  });
});

describe('pickMoveByPolicy', () => {
  /** 构造 362 长策略数组:指定落点权重,其余 -1(非法);末位为虚着位 */
  function makePolicy(entries: [number, number][], pass = 0): number[] {
    const policy = new Array<number>(362).fill(-1);
    for (const [i, w] of entries) policy[i] = w;
    policy[361] = pass;
    return policy;
  }

  it('按权重比例采样,可复现', () => {
    const policy = makePolicy([
      [10, 3],
      [20, 1],
    ]);
    expect(pickMoveByPolicy(policy, () => 0)).toBe(10);
    expect(pickMoveByPolicy(policy, () => 0.74)).toBe(10);
    expect(pickMoveByPolicy(policy, () => 0.76)).toBe(20);
    expect(pickMoveByPolicy(policy, () => 0.999999)).toBe(20);
  });

  it('非法点(-1)、零权重与虚着位不参与采样', () => {
    const onlyPass = makePolicy([], 1);
    expect(pickMoveByPolicy(onlyPass, () => 0)).toBeNull();

    const withPass = makePolicy([[7, 1]], 0.5);
    expect(pickMoveByPolicy(withPass, () => 0.99)).toBe(7);
  });

  it('空策略或无有效权重返回 null', () => {
    expect(pickMoveByPolicy(undefined)).toBeNull();
    expect(pickMoveByPolicy([])).toBeNull();
    expect(pickMoveByPolicy(makePolicy([]))).toBeNull();
  });
});

describe('parseHumanThink', () => {
  /** 策略:pos=100 权重 1,pos=200 权重 3 */
  function policy(): number[] {
    const arr = new Array<number>(362).fill(-1);
    arr[100] = 1;
    arr[200] = 3;
    arr[361] = 0;
    return arr;
  }

  it('搜索最佳(order:0)为虚着 → 虚着', () => {
    const result = parseHumanThink(
      {
        moveInfos: [
          { move: 'pass', visits: 30, order: 0 },
          { move: 'D4', visits: 20, order: 1 },
        ],
        humanPolicy: policy(),
        rootInfo: { winrate: 0.5, scoreLead: 0, visits: 50 },
      },
      () => 0.1,
    );
    expect(result.move).toBe(PASS);
  });

  it('非虚着时按 humanPolicy 比例采样并回填数值', () => {
    const result = parseHumanThink(
      {
        moveInfos: [{ move: 'D4', visits: 30, winrate: 0.5, scoreLead: 1, order: 0 }],
        humanPolicy: policy(),
        rootInfo: { winrate: 0.55, scoreLead: 2, visits: 50 },
      },
      () => 0.5,
    );
    expect(result.move).toBe(200);
    expect(result.visits).toBe(50);
    // 采样点不在 moveInfos 中 → 回退根节点数值
    expect(result.winRate).toBe(0.55);
    expect(result.scoreLead).toBe(2);
  });

  it('humanPolicy 缺失或全非法时回退搜索最佳', () => {
    const response: AnalysisResponse = {
      moveInfos: [{ move: 'D4', visits: 30, winrate: 0.5, scoreLead: 1, order: 0 }],
    };
    expect(parseHumanThink(response, () => 0.5).move).toBe(idx(3, 15));

    const allIllegal = new Array<number>(362).fill(-1);
    expect(parseHumanThink({ ...response, humanPolicy: allIllegal }, () => 0.5).move).toBe(
      idx(3, 15),
    );
  });

  it('无 order 字段时以访问次数最多者为搜索最佳', () => {
    const result = parseHumanThink(
      {
        moveInfos: [
          { move: 'pass', visits: 30 },
          { move: 'D4', visits: 5 },
        ],
        humanPolicy: policy(),
        rootInfo: { visits: 35 },
      },
      () => 0.1,
    );
    expect(result.move).toBe(PASS);
  });
});

describe('parseThink', () => {
  const response: AnalysisResponse = {
    moveInfos: [
      { move: 'D4', visits: 10, winrate: 0.5, scoreLead: 1 },
      { move: 'pass', visits: 5, winrate: 0.4, scoreLead: -1 },
    ],
    rootInfo: { winrate: 0.6, scoreLead: 2, visits: 15 },
  };

  it('温度 0 取最优,并回填该候选胜率/目差', () => {
    const result = parseThink(response, 0);
    expect(result.move).toBe(idx(3, 15));
    expect(result.winRate).toBe(0.5);
    expect(result.scoreLead).toBe(1);
    expect(result.visits).toBe(15);
  });

  it('空响应 → 虚着且数值为 0', () => {
    const result = parseThink({}, 0);
    expect(result.move).toBe(PASS);
    expect(result.winRate).toBe(0);
    expect(result.scoreLead).toBe(0);
    expect(result.visits).toBe(0);
  });
});

describe('toSnapshot', () => {
  it('映射为分析快照', () => {
    const snap = toSnapshot({
      moveInfos: [{ move: 'D4', visits: 10, winrate: 0.5, scoreLead: 1, pv: ['D4'] }],
      rootInfo: { winrate: 0.6, scoreLead: 2, visits: 15 },
    });
    expect(snap.playouts).toBe(15);
    expect(snap.rootValue).toBe(0.6);
    expect(snap.bestMove).toBe(idx(3, 15));
    expect(snap.candidates).toHaveLength(1);
  });
});
