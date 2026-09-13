import { Stone } from './board';

/** SGF 节点:属性表 + 子节点(手顺/分支) */
export interface SgfNode {
  properties: Record<string, string[]>;
  children: SgfNode[];
}

/** 主线一手(回放用) */
export interface SgfLineMove {
  stone: Stone;
  /** null 表示虚着(pass) */
  col: number | null;
  row: number | null;
  comment?: string;
}

/** 生成棋谱时的元数据 */
export interface SgfGameMeta {
  blackName?: string;
  whiteName?: string;
  /** 结果,如 "B+3.5"、"W+R" */
  result?: string;
  /** 贴目(标准 SGF 用目数) */
  komi?: number;
  /** 让子数 */
  handicap?: number;
}

/** SGF 坐标 "aa"~"ss" 转棋盘点 */
export function sgfToPoint(s: string): { col: number; row: number } | null {
  if (s.length < 2) return null;
  const col = s.charCodeAt(0) - 97;
  const row = s.charCodeAt(1) - 97;
  if (col < 0 || col >= 19 || row < 0 || row >= 19) return null;
  return { col, row };
}

/** 棋盘点转 SGF 坐标 */
export function pointToSgf(col: number, row: number): string {
  return String.fromCharCode(97 + col) + String.fromCharCode(97 + row);
}

/** 解析 SGF 文本为节点树;非法文本返回 null */
export function parseSgf(text: string): SgfNode | null {
  let pos = 0;

  const skipWs = (): void => {
    while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  };

  /** 解析 ";AB[cd]B[dd]" 为一个节点(不含分号后的子节点连接) */
  const parseNode = (): SgfNode | null => {
    skipWs();
    if (text[pos] !== ';') return null;
    pos++;
    const properties: Record<string, string[]> = {};
    for (;;) {
      skipWs();
      const ch = text[pos];
      if (ch === undefined || ch === ';' || ch === '(' || ch === ')') break;
      // 属性名:大写字母
      if (!/[A-Z]/.test(ch)) {
        pos++;
        continue;
      }
      let name = '';
      while (pos < text.length && /[A-Z]/.test(text[pos]!)) {
        name += text[pos];
        pos++;
      }
      skipWs();
      const values: string[] = [];
      while (text[pos] === '[') {
        pos++;
        let value = '';
        while (pos < text.length && text[pos] !== ']') {
          if (text[pos] === '\\' && pos + 1 < text.length) {
            pos++;
            value += text[pos];
          } else {
            value += text[pos];
          }
          pos++;
        }
        if (text[pos] === ']') pos++;
        values.push(value);
      }
      if (values.length > 0) properties[name] = values;
    }
    return { properties, children: [] };
  };

  /** 解析节点序列(分号链),分支以 (...) 子序列挂到当前序列最后一个节点 */
  const parseSequence = (): SgfNode[] => {
    const nodes: SgfNode[] = [];
    for (;;) {
      skipWs();
      if (text[pos] === ';') {
        const node = parseNode();
        if (node) nodes.push(node);
      } else if (text[pos] === '(') {
        // parseTree 内部自行消费 '(' 与 ')'
        const child = parseTree();
        if (child && nodes.length > 0) {
          nodes[nodes.length - 1]!.children.push(child);
        }
      } else {
        break;
      }
    }
    return nodes;
  };

  /** 解析 "(;...)" 完整树 */
  const parseTree = (): SgfNode | null => {
    skipWs();
    if (text[pos] !== '(') return null;
    pos++;
    const seq = parseSequence();
    if (text[pos] === ')') pos++;
    if (seq.length === 0) return null;
    for (let i = 1; i < seq.length; i++) {
      seq[i - 1]!.children.push(seq[i]!);
    }
    return seq[0]!;
  };

  return parseTree();
}

/** 序列化节点树为 SGF 文本(主线平铺,分支加括号) */
export function serializeSgf(root: SgfNode): string {
  const parts: string[] = [];

  const write = (node: SgfNode, isBranch: boolean): void => {
    if (isBranch) parts.push('(');
    parts.push(';');
    for (const [name, values] of Object.entries(node.properties)) {
      for (const v of values) {
        const escaped = v.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        parts.push(`${name}[${escaped}]`);
      }
    }
    // 仅当恰好 1 个孩子时才平铺为 SGF 序列;多孩子时全部加括号,
    // 否则紧跟平铺子节点后的分支会被解析器挂到该子节点而非本节点
    const flat = node.children.length === 1;
    node.children.forEach((child, i) => write(child, !flat || i > 0));
    if (isBranch) parts.push(')');
  };

  write(root, false);
  return '(' + parts.join('') + ')';
}

/** 提取主线手顺(含注释与虚着) */
export function extractMainLine(root: SgfNode): SgfLineMove[] {
  const moves: SgfLineMove[] = [];
  let node: SgfNode = root;
  for (;;) {
    const black = node.properties['B']?.[0];
    const white = node.properties['W']?.[0];
    const comment = node.properties['C']?.[0];
    if (black !== undefined) {
      const pt = black === '' ? null : sgfToPoint(black);
      moves.push({
        stone: 1,
        col: pt?.col ?? null,
        row: pt?.row ?? null,
        ...(comment ? { comment } : {}),
      });
    }
    if (white !== undefined) {
      const pt = white === '' ? null : sgfToPoint(white);
      moves.push({
        stone: 2,
        col: pt?.col ?? null,
        row: pt?.row ?? null,
        ...(comment ? { comment } : {}),
      });
    }
    if (node.children.length === 0) break;
    node = node.children[0]!;
  }
  return moves;
}

/** 由手顺与元数据构建 SGF 节点树(可直接序列化) */
export function buildSgfDoc(moves: readonly SgfLineMove[], meta: SgfGameMeta = {}): SgfNode {
  const root: SgfNode = {
    properties: {
      GM: ['1'],
      FF: ['4'],
      SZ: ['19'],
      KM: [String(meta.komi ?? 7.5)],
      ...(meta.blackName ? { PB: [meta.blackName] } : {}),
      ...(meta.whiteName ? { PW: [meta.whiteName] } : {}),
      ...(meta.result ? { RE: [meta.result] } : {}),
      ...(meta.handicap ? { HA: [String(meta.handicap)] } : {}),
    },
    children: [],
  };
  let current = root;
  for (const m of moves) {
    const key = m.stone === 1 ? 'B' : 'W';
    const value = m.col === null || m.row === null ? '' : pointToSgf(m.col, m.row);
    const props: Record<string, string[]> = {
      [key]: [value],
      ...(m.comment ? { C: [m.comment] } : {}),
    };
    const node: SgfNode = { properties: props, children: [] };
    current.children.push(node);
    current = node;
  }
  return root;
}
