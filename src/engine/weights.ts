/**
 * KataGo 权重文件(v8-v16)解析。
 * 格式:ASCII 头 + @BIN@ 标记的 float32 块(与 C++ 版 modelio 一致)。
 */

export class KataGoBinParser {
  private readonly data: Uint8Array;
  private idx = 0;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(data: Uint8Array) {
    this.data = data;
  }

  private skipWhitespace(): void {
    while (this.idx < this.data.length) {
      const b = this.data[this.idx]!;
      if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) {
        this.idx++;
        continue;
      }
      break;
    }
  }

  readToken(): string {
    this.skipWhitespace();
    const start = this.idx;
    while (this.idx < this.data.length) {
      const b = this.data[this.idx]!;
      if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) break;
      this.idx++;
    }
    if (this.idx <= start) throw new Error('Unexpected EOF while reading token');
    return this.decoder.decode(this.data.subarray(start, this.idx));
  }

  readInt(): number {
    const value = Number.parseInt(this.readToken(), 10);
    if (!Number.isFinite(value)) throw new Error('Invalid int token');
    return value;
  }

  readFloatAscii(): number {
    const value = Number.parseFloat(this.readToken());
    if (!Number.isFinite(value)) throw new Error('Invalid float token');
    return value;
  }

  /** 读取 @BIN@ 标记后的 count 个 float32 */
  readBinaryFloats(count: number): Float32Array {
    this.skipWhitespace();
    const marker = this.data.subarray(this.idx, this.idx + 5);
    if (
      marker.length !== 5 ||
      marker[0] !== 0x40 || marker[1] !== 0x42 || marker[2] !== 0x49 ||
      marker[3] !== 0x4e || marker[4] !== 0x40
    ) {
      throw new Error('Expected @BIN@ marker');
    }
    this.idx += 5;

    const byteLen = count * 4;
    const absStart = this.data.byteOffset + this.idx;
    const absEnd = absStart + byteLen;
    if (absEnd > this.data.buffer.byteLength) throw new Error('Unexpected EOF in binary floats');

    const buf = this.data.buffer.slice(absStart, absEnd);
    this.idx += byteLen;
    this.skipWhitespace();
    return new Float32Array(buf);
  }
}

export interface ParsedBatchNorm {
  channels: number;
  /** 已合并 scale:scale/sqrt(var+eps) */
  mergedScale: Float32Array;
  /** 已合并 bias:bias - mergedScale*mean */
  mergedBias: Float32Array;
}

export interface ParsedConv2d {
  kernelY: number;
  kernelX: number;
  inChannels: number;
  outChannels: number;
  dilationY: number;
  dilationX: number;
  /** [kY, kX, inC, outC] */
  weights: Float32Array;
}

export interface ParsedMatMul {
  inChannels: number;
  outChannels: number;
  /** [inC, outC] */
  weights: Float32Array;
}

export interface ParsedMatBias {
  channels: number;
  /** [channels] */
  weights: Float32Array;
}

export type ActivationKind = 'identity' | 'relu' | 'mish';

export function parseBatchNorm(p: KataGoBinParser): ParsedBatchNorm {
  p.readToken(); // name
  const channels = p.readInt();
  const epsilon = p.readFloatAscii();
  const hasScale = p.readInt() !== 0;
  const hasBias = p.readInt() !== 0;

  const mean = p.readBinaryFloats(channels);
  const variance = p.readBinaryFloats(channels);
  const scale = hasScale ? p.readBinaryFloats(channels) : new Float32Array(channels).fill(1);
  const bias = hasBias ? p.readBinaryFloats(channels) : new Float32Array(channels).fill(0);

  const mergedScale = new Float32Array(channels);
  const mergedBias = new Float32Array(channels);
  for (let i = 0; i < channels; i++) {
    const ms = scale[i]! / Math.sqrt(variance[i]! + epsilon);
    mergedScale[i] = ms;
    mergedBias[i] = bias[i]! - ms * mean[i]!;
  }
  return { channels, mergedScale, mergedBias };
}

export function parseActivationKind(p: KataGoBinParser, modelVersion: number): ActivationKind {
  p.readToken(); // name
  if (modelVersion < 11) return 'relu';
  const kind = p.readToken();
  if (kind === 'ACTIVATION_IDENTITY') return 'identity';
  if (kind === 'ACTIVATION_RELU') return 'relu';
  if (kind === 'ACTIVATION_MISH') return 'mish';
  throw new Error(`Unsupported activation: ${kind}`);
}

export function parseConv2d(p: KataGoBinParser): ParsedConv2d {
  p.readToken(); // name
  const kernelY = p.readInt();
  const kernelX = p.readInt();
  const inChannels = p.readInt();
  const outChannels = p.readInt();
  const dilationY = p.readInt();
  const dilationX = p.readInt();
  const weights = p.readBinaryFloats(kernelY * kernelX * inChannels * outChannels);
  return { kernelY, kernelX, inChannels, outChannels, dilationY, dilationX, weights };
}

export function parseMatMul(p: KataGoBinParser): ParsedMatMul {
  p.readToken(); // name
  const inChannels = p.readInt();
  const outChannels = p.readInt();
  const weights = p.readBinaryFloats(inChannels * outChannels);
  return { inChannels, outChannels, weights };
}

export function parseMatBias(p: KataGoBinParser): ParsedMatBias {
  p.readToken(); // name
  const channels = p.readInt();
  const weights = p.readBinaryFloats(channels);
  return { channels, weights };
}

export type ParsedTrunkBlock =
  | { kind: 'ordinary'; preBN: ParsedBatchNorm; preActivation: ActivationKind; w1: ParsedConv2d; midBN: ParsedBatchNorm; midActivation: ActivationKind; w2: ParsedConv2d }
  | { kind: 'gpool'; preBN: ParsedBatchNorm; preActivation: ActivationKind; w1a: ParsedConv2d; w1b: ParsedConv2d; gpoolBN: ParsedBatchNorm; gpoolActivation: ActivationKind; w1r: ParsedMatMul; midBN: ParsedBatchNorm; midActivation: ActivationKind; w2: ParsedConv2d }
  | { kind: 'nested_bottleneck'; numBlocks: number; preBN: ParsedBatchNorm; preActivation: ActivationKind; preConv: ParsedConv2d; blocks: ParsedTrunkBlock[]; postBN: ParsedBatchNorm; postActivation: ActivationKind; postConv: ParsedConv2d };

export interface ParsedPostProcess {
  tdScoreMultiplier: number;
  scoreMeanMultiplier: number;
  scoreStdevMultiplier: number;
  leadMultiplier: number;
  varianceTimeMultiplier: number;
  shorttermValueErrorMultiplier: number;
  shorttermScoreErrorMultiplier: number;
  outputScaleMultiplier: number;
}

export interface ParsedKataGoModel {
  modelName: string;
  modelVersion: number;
  numInputChannels: number;
  numInputGlobalChannels: number;
  metaEncoderVersion: number;
  postProcessParams: ParsedPostProcess;
  policyOutChannels: number;
  scoreValueChannels: number;
  trunk: {
    numBlocks: number;
    trunkNumChannels: number;
    midNumChannels: number;
    regularNumChannels: number;
    gpoolNumChannels: number;
    conv1: ParsedConv2d;
    ginput: ParsedMatMul;
    blocks: ParsedTrunkBlock[];
    tipBN: ParsedBatchNorm;
    tipActivation: ActivationKind;
  };
  policy: {
    p1: ParsedConv2d;
    g1: ParsedConv2d;
    g1BN: ParsedBatchNorm;
    g1Activation: ActivationKind;
    gpoolToBias: ParsedMatMul;
    p1BN: ParsedBatchNorm;
    p1Activation: ActivationKind;
    p2: ParsedConv2d;
    passMul: ParsedMatMul;
    /** v15+ */
    passBias?: ParsedMatBias;
    passActivation?: ActivationKind;
    passMul2?: ParsedMatMul;
  };
  value: {
    v1: ParsedConv2d;
    v1BN: ParsedBatchNorm;
    v1Activation: ActivationKind;
    v2: ParsedMatMul;
    v2Bias: ParsedMatBias;
    v2Activation: ActivationKind;
    v3: ParsedMatMul;
    v3Bias: ParsedMatBias;
    sv3: ParsedMatMul;
    sv3Bias: ParsedMatBias;
    ownership: ParsedConv2d;
  };
}

const DEFAULT_POST_PROCESS: ParsedPostProcess = {
  tdScoreMultiplier: 20.0,
  scoreMeanMultiplier: 20.0,
  scoreStdevMultiplier: 20.0,
  leadMultiplier: 20.0,
  varianceTimeMultiplier: 40.0,
  shorttermValueErrorMultiplier: 0.25,
  shorttermScoreErrorMultiplier: 30.0,
  outputScaleMultiplier: 1.0,
};

/** 解析 KataGo 模型文件(v8-v16);不支持的结构抛出异常 */
export function parseKataGoModel(data: Uint8Array): ParsedKataGoModel {
  const p = new KataGoBinParser(data);

  const modelName = p.readToken();
  const modelVersion = p.readInt();
  if (modelVersion < 8 || modelVersion > 16) {
    throw new Error(`Unsupported modelVersion ${modelVersion}(支持 8..16)`);
  }
  const numInputChannels = p.readInt();
  const numInputGlobalChannels = p.readInt();

  const postProcessParams =
    modelVersion >= 13
      ? {
          tdScoreMultiplier: p.readFloatAscii(),
          scoreMeanMultiplier: p.readFloatAscii(),
          scoreStdevMultiplier: p.readFloatAscii(),
          leadMultiplier: p.readFloatAscii(),
          varianceTimeMultiplier: p.readFloatAscii(),
          shorttermValueErrorMultiplier: p.readFloatAscii(),
          shorttermScoreErrorMultiplier: p.readFloatAscii(),
          outputScaleMultiplier: 1.0,
        }
      : { ...DEFAULT_POST_PROCESS };

  const metaEncoderVersion = modelVersion >= 15 ? p.readInt() : 0;
  if (metaEncoderVersion !== 0) {
    // SGF 元数据编码器(human SL 网络)暂不支持
    throw new Error(`Unsupported metaEncoderVersion ${metaEncoderVersion}`);
  }
  if (modelVersion >= 15) {
    for (let i = 0; i < 7; i++) p.readInt();
  }

  p.readToken(); // trunk name
  const numBlocks = p.readInt();
  const trunkNumChannels = p.readInt();
  const midNumChannels = p.readInt();
  const regularNumChannels = p.readInt();
  p.readInt();
  const gpoolNumChannels = p.readInt();
  if (modelVersion >= 15) {
    const trunkNormKind = p.readInt();
    if (trunkNormKind !== 0) throw new Error(`Unsupported trunk norm kind ${trunkNormKind}`);
    for (let i = 0; i < 5; i++) p.readInt();
  }

  const conv1 = parseConv2d(p);
  const ginput = parseMatMul(p);

  const parseResidualBlock = (): ParsedTrunkBlock => {
    const kindTok = p.readToken();
    if (kindTok === 'ordinary_block') {
      p.readToken(); // name
      return {
        kind: 'ordinary',
        preBN: parseBatchNorm(p),
        preActivation: parseActivationKind(p, modelVersion),
        w1: parseConv2d(p),
        midBN: parseBatchNorm(p),
        midActivation: parseActivationKind(p, modelVersion),
        w2: parseConv2d(p),
      };
    }
    if (kindTok === 'gpool_block') {
      p.readToken();
      return {
        kind: 'gpool',
        preBN: parseBatchNorm(p),
        preActivation: parseActivationKind(p, modelVersion),
        w1a: parseConv2d(p),
        w1b: parseConv2d(p),
        gpoolBN: parseBatchNorm(p),
        gpoolActivation: parseActivationKind(p, modelVersion),
        w1r: parseMatMul(p),
        midBN: parseBatchNorm(p),
        midActivation: parseActivationKind(p, modelVersion),
        w2: parseConv2d(p),
      };
    }
    if (kindTok === 'nested_bottleneck_block') {
      p.readToken();
      const numInnerBlocks = p.readInt();
      const preBN = parseBatchNorm(p);
      const preActivation = parseActivationKind(p, modelVersion);
      const preConv = parseConv2d(p);
      const blocks: ParsedTrunkBlock[] = [];
      for (let i = 0; i < numInnerBlocks; i++) blocks.push(parseResidualBlock());
      const postBN = parseBatchNorm(p);
      const postActivation = parseActivationKind(p, modelVersion);
      const postConv = parseConv2d(p);
      return { kind: 'nested_bottleneck', numBlocks: numInnerBlocks, preBN, preActivation, preConv, blocks, postBN, postActivation, postConv };
    }
    throw new Error(`Unsupported trunk block: ${kindTok}`);
  };

  const blocks: ParsedTrunkBlock[] = [];
  for (let i = 0; i < numBlocks; i++) blocks.push(parseResidualBlock());

  const tipBN = parseBatchNorm(p);
  const tipActivation = parseActivationKind(p, modelVersion);

  // policy head
  p.readToken();
  const p1 = parseConv2d(p);
  const g1 = parseConv2d(p);
  const g1BN = parseBatchNorm(p);
  const g1Activation = parseActivationKind(p, modelVersion);
  const gpoolToBias = parseMatMul(p);
  const p1BN = parseBatchNorm(p);
  const p1Activation = parseActivationKind(p, modelVersion);
  const p2 = parseConv2d(p);
  const passMul = parseMatMul(p);
  const passBias = modelVersion >= 15 ? parseMatBias(p) : undefined;
  const passActivation = modelVersion >= 15 ? parseActivationKind(p, modelVersion) : undefined;
  const passMul2 = modelVersion >= 15 ? parseMatMul(p) : undefined;

  // value head
  p.readToken();
  const v1 = parseConv2d(p);
  const v1BN = parseBatchNorm(p);
  const v1Activation = parseActivationKind(p, modelVersion);
  const v2 = parseMatMul(p);
  const v2Bias = parseMatBias(p);
  const v2Activation = parseActivationKind(p, modelVersion);
  const v3 = parseMatMul(p);
  const v3Bias = parseMatBias(p);
  const sv3 = parseMatMul(p);
  const sv3Bias = parseMatBias(p);
  const ownership = parseConv2d(p);

  return {
    modelName,
    modelVersion,
    numInputChannels,
    numInputGlobalChannels,
    metaEncoderVersion,
    postProcessParams,
    policyOutChannels: p2.outChannels,
    scoreValueChannels: sv3.outChannels,
    trunk: { numBlocks, trunkNumChannels, midNumChannels, regularNumChannels, gpoolNumChannels, conv1, ginput, blocks, tipBN, tipActivation },
    policy: { p1, g1, g1BN, g1Activation, gpoolToBias, p1BN, p1Activation, p2, passMul, passBias, passActivation, passMul2 },
    value: { v1, v1BN, v1Activation, v2, v2Bias, v2Activation, v3, v3Bias, sv3, sv3Bias, ownership },
  };
}
