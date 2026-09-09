/**
 * KataGo 网络 TF.js 前向推理。
 * 结构对齐 KataGo C++ eigenbackend(nneval.cpp)与 web-katrain modelV8:
 *  - conv2d 'same' NHWC + BN 合并 scale/bias(已在解析阶段合并)
 *  - gpool:concat(mean, mean*0.5, max)(19 路固定系数 (19-14)*0.1)
 *  - value 池化:concat(mean, mean*0.5, mean*0.15)
 *  - policy logits 取输出通道 0;pass 取 pass 头通道 0
 */
import * as tf from '@tensorflow/tfjs';
import type {
  ActivationKind,
  ParsedBatchNorm,
  ParsedConv2d,
  ParsedKataGoModel,
  ParsedMatBias,
  ParsedMatMul,
  ParsedTrunkBlock,
} from './weights';
import { BOARD_SIZE } from '../core/board';
import type { EncodedFeatures } from './features';

type TfBn = { scale: tf.Tensor4D; bias: tf.Tensor4D };
type TfConv = { filter: tf.Tensor4D; dilationY: number; dilationX: number };
type TfMatMul = { w: tf.Tensor2D };
type TfMatBias = { b: tf.Tensor2D };

type TfTrunkBlock =
  | { kind: 'ordinary'; preBN: TfBn; preActivation: ActivationKind; w1: TfConv; midBN: TfBn; midActivation: ActivationKind; w2: TfConv }
  | { kind: 'gpool'; preBN: TfBn; preActivation: ActivationKind; w1a: TfConv; w1b: TfConv; gpoolBN: TfBn; gpoolActivation: ActivationKind; w1r: TfMatMul; midBN: TfBn; midActivation: ActivationKind; w2: TfConv }
  | { kind: 'nested_bottleneck'; preBN: TfBn; preActivation: ActivationKind; preConv: TfConv; blocks: TfTrunkBlock[]; postBN: TfBn; postActivation: ActivationKind; postConv: TfConv };

/** 一次推理结果(当前行棋方视角) */
export interface NetEval {
  /** 361 个落点 logits(未 softmax),顺序 = 棋盘索引 */
  policyLogits: Float32Array;
  /** pass logit */
  passLogit: number;
  /** 当前行棋方胜率 0..1 */
  winProb: number;
  /** 当前行棋方领先目数(>0 领先) */
  scoreLead: number;
  /** 当前行棋方目数期望(含和棋修正) */
  scoreMean: number;
  /** 和棋(no result)概率 0..1 */
  noResultProb: number;
}

const makeBn = (bn: ParsedBatchNorm): TfBn => ({
  scale: tf.tensor4d(bn.mergedScale, [1, 1, 1, bn.channels]),
  bias: tf.tensor4d(bn.mergedBias, [1, 1, 1, bn.channels]),
});

const makeConv = (conv: ParsedConv2d): TfConv => ({
  filter: tf.tensor4d(conv.weights, [conv.kernelY, conv.kernelX, conv.inChannels, conv.outChannels]),
  dilationY: conv.dilationY,
  dilationX: conv.dilationX,
});

const makeMatMul = (mm: ParsedMatMul): TfMatMul => ({
  w: tf.tensor2d(mm.weights, [mm.inChannels, mm.outChannels]),
});

const makeMatBias = (bias: ParsedMatBias): TfMatBias => ({
  b: tf.tensor2d(bias.weights, [1, bias.channels]),
});

function applyActivation4D(x: tf.Tensor4D, kind: ActivationKind): tf.Tensor4D {
  if (kind === 'identity') return x;
  if (kind === 'relu') return tf.relu(x);
  return tf.mul(x, tf.tanh(tf.softplus(x)));
}

function applyActivation2D(x: tf.Tensor2D, kind: ActivationKind): tf.Tensor2D {
  if (kind === 'identity') return x;
  if (kind === 'relu') return tf.relu(x);
  return tf.mul(x, tf.tanh(tf.softplus(x)));
}

const bnAct = (x: tf.Tensor4D, bn: TfBn, activation: ActivationKind): tf.Tensor4D =>
  applyActivation4D(tf.add(tf.mul(x, bn.scale), bn.bias), activation);

const conv2d = (x: tf.Tensor4D, conv: TfConv): tf.Tensor4D =>
  tf.conv2d(x, conv.filter, 1, 'same', 'NHWC', [conv.dilationY, conv.dilationX]);

/** gpool:concat(mean, mean*(sqrt(area)-14)*0.1, max);19 路系数固定 0.5 */
const poolRowsGPool = (x: tf.Tensor4D): tf.Tensor2D => {
  const mean = tf.mean(x, [1, 2]) as unknown as tf.Tensor2D;
  const max = tf.max(x, [1, 2]) as unknown as tf.Tensor2D;
  return tf.concat([mean, mean.mul(0.5), max], 1) as tf.Tensor2D;
};

/** value 池化:concat(mean, mean*0.5, mean*0.15) */
const poolRowsValueHead = (x: tf.Tensor4D): tf.Tensor2D => {
  const mean = tf.mean(x, [1, 2]) as unknown as tf.Tensor2D;
  return tf.concat([mean, mean.mul(0.5), mean.mul(0.15)], 1) as tf.Tensor2D;
};

export class KataGoNet {
  readonly modelName: string;
  readonly modelVersion: number;
  private readonly postProcess: ParsedKataGoModel['postProcessParams'];

  private readonly trunkConv1: TfConv;
  private readonly trunkGInput: TfMatMul;
  private readonly trunkBlocks: TfTrunkBlock[];
  private readonly trunkTipBN: TfBn;
  private readonly trunkTipActivation: ActivationKind;

  private readonly p1: TfConv;
  private readonly g1: TfConv;
  private readonly g1BN: TfBn;
  private readonly g1Activation: ActivationKind;
  private readonly gpoolToBias: TfMatMul;
  private readonly p1BN: TfBn;
  private readonly p1Activation: ActivationKind;
  private readonly p2: TfConv;
  private readonly passMul: TfMatMul;
  private readonly passBias?: TfMatBias;
  private readonly passActivation?: ActivationKind;
  private readonly passMul2?: TfMatMul;

  private readonly v1: TfConv;
  private readonly v1BN: TfBn;
  private readonly v1Activation: ActivationKind;
  private readonly v2: TfMatMul;
  private readonly v2Bias: TfMatBias;
  private readonly v2Activation: ActivationKind;
  private readonly v3: TfMatMul;
  private readonly v3Bias: TfMatBias;
  private readonly sv3: TfMatMul;
  private readonly sv3Bias: TfMatBias;

  constructor(parsed: ParsedKataGoModel) {
    this.modelName = parsed.modelName;
    this.modelVersion = parsed.modelVersion;
    this.postProcess = parsed.postProcessParams;

    this.trunkConv1 = makeConv(parsed.trunk.conv1);
    this.trunkGInput = makeMatMul(parsed.trunk.ginput);
    this.trunkBlocks = parsed.trunk.blocks.map(toTfBlock);
    this.trunkTipBN = makeBn(parsed.trunk.tipBN);
    this.trunkTipActivation = parsed.trunk.tipActivation;

    this.p1 = makeConv(parsed.policy.p1);
    this.g1 = makeConv(parsed.policy.g1);
    this.g1BN = makeBn(parsed.policy.g1BN);
    this.g1Activation = parsed.policy.g1Activation;
    this.gpoolToBias = makeMatMul(parsed.policy.gpoolToBias);
    this.p1BN = makeBn(parsed.policy.p1BN);
    this.p1Activation = parsed.policy.p1Activation;
    this.p2 = makeConv(parsed.policy.p2);
    this.passMul = makeMatMul(parsed.policy.passMul);
    this.passBias = parsed.policy.passBias ? makeMatBias(parsed.policy.passBias) : undefined;
    this.passActivation = parsed.policy.passActivation;
    this.passMul2 = parsed.policy.passMul2 ? makeMatMul(parsed.policy.passMul2) : undefined;

    this.v1 = makeConv(parsed.value.v1);
    this.v1BN = makeBn(parsed.value.v1BN);
    this.v1Activation = parsed.value.v1Activation;
    this.v2 = makeMatMul(parsed.value.v2);
    this.v2Bias = makeMatBias(parsed.value.v2Bias);
    this.v2Activation = parsed.value.v2Activation;
    this.v3 = makeMatMul(parsed.value.v3);
    this.v3Bias = makeMatBias(parsed.value.v3Bias);
    this.sv3 = makeMatMul(parsed.value.sv3);
    this.sv3Bias = makeMatBias(parsed.value.sv3Bias);
  }

  /** 批量推理(供 MCTS 扩展用);返回顺序与输入一致 */
  async evaluateBatch(inputs: readonly EncodedFeatures[]): Promise<NetEval[]> {
    const first = inputs[0];
    const flatSpatial = new Float32Array(inputs.length * first.spatial.length);
    inputs.forEach((f, b) => flatSpatial.set(f.spatial, b * f.spatial.length));
    const spatial = tf.tensor4d(flatSpatial, [inputs.length, BOARD_SIZE, BOARD_SIZE, first.spatial.length / (BOARD_SIZE * BOARD_SIZE)]);
    const flatGlobal = new Float32Array(inputs.length * first.global.length);
    inputs.forEach((f, b) => flatGlobal.set(f.global, b * f.global.length));
    const global = tf.tensor2d(flatGlobal, [inputs.length, first.global.length]);
    try {
      const raw = tf.tidy(() => {
        const trunk = this.forwardTrunk(spatial, global);

        // policy head
        let p1Out = conv2d(trunk, this.p1);
        const g1Out2 = bnAct(conv2d(trunk, this.g1), this.g1BN, this.g1Activation);
        const g1Concat = poolRowsGPool(g1Out2);
        const g1Bias = tf.matMul(g1Concat, this.gpoolToBias.w);
        p1Out = tf.add(p1Out, g1Bias.reshape([g1Bias.shape[0]!, 1, 1, g1Bias.shape[1]!]));
        const policy = conv2d(bnAct(p1Out, this.p1BN, this.p1Activation), this.p2);

        // pass 头
        let pass = tf.matMul(g1Concat, this.passMul.w);
        if (this.passBias && this.passActivation && this.passMul2) {
          pass = applyActivation2D(tf.add(pass, this.passBias.b), this.passActivation);
          pass = tf.matMul(pass, this.passMul2.w);
        }

        // value head
        const v1Out2 = bnAct(conv2d(trunk, this.v1), this.v1BN, this.v1Activation);
        const v1Mean = poolRowsValueHead(v1Out2);
        let v2Out = applyActivation2D(tf.add(tf.matMul(v1Mean, this.v2.w), this.v2Bias.b), this.v2Activation);
        const value = tf.add(tf.matMul(v2Out, this.v3.w), this.v3Bias.b);
        const scoreValue = tf.add(tf.matMul(v2Out, this.sv3.w), this.sv3Bias.b);

        return { policy, pass, value, scoreValue };
      });

      try {
        const [policyData, passData, valueData, scoreData] = await Promise.all([
          raw.policy.data(),
          raw.pass.data(),
          raw.value.data(),
          raw.scoreValue.data(),
        ]);
        const n = inputs.length;
        const outC = raw.policy.shape[3];
        const results: NetEval[] = [];
        for (let b = 0; b < n; b++) {
          const policyLogits = new Float32Array(BOARD_SIZE * BOARD_SIZE);
          for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
            policyLogits[i] = policyData[b * BOARD_SIZE * BOARD_SIZE * outC + i * outC];
          }
          results.push(
            this.postprocess(
              policyLogits,
              passData[b * outC],
              [valueData[b * 3], valueData[b * 3 + 1], valueData[b * 3 + 2]],
              [scoreData[b * 6], scoreData[b * 6 + 1], scoreData[b * 6 + 2], scoreData[b * 6 + 3], scoreData[b * 6 + 4], scoreData[b * 6 + 5]],
            ),
          );
        }
        return results;
      } finally {
        raw.policy.dispose();
        raw.pass.dispose();
        raw.value.dispose();
        raw.scoreValue.dispose();
      }
    } finally {
      spatial.dispose();
      global.dispose();
    }
  }

  /** 单局面推理 */
  async evaluate(input: EncodedFeatures): Promise<NetEval> {
    return (await this.evaluateBatch([input]))[0];
  }

  private forwardTrunk(spatial: tf.Tensor4D, global: tf.Tensor2D): tf.Tensor4D {
    let trunk = conv2d(spatial, this.trunkConv1);
    const ginput = tf.matMul(global, this.trunkGInput.w);
    trunk = tf.add(trunk, ginput.reshape([ginput.shape[0]!, 1, 1, ginput.shape[1]!]));
    for (const block of this.trunkBlocks) {
      if (block.kind === 'ordinary') {
        const d = conv2d(bnAct(conv2d(bnAct(trunk, block.preBN, block.preActivation), block.w1), block.midBN, block.midActivation), block.w2);
        trunk = tf.add(trunk, d);
      } else if (block.kind === 'gpool') {
        const a = bnAct(trunk, block.preBN, block.preActivation);
        let regularOut = conv2d(a, block.w1a);
        const gpoolOut2 = bnAct(conv2d(a, block.w1b), block.gpoolBN, block.gpoolActivation);
        const gpoolBias = tf.matMul(poolRowsGPool(gpoolOut2), block.w1r.w);
        regularOut = tf.add(regularOut, gpoolBias.reshape([gpoolBias.shape[0]!, 1, 1, gpoolBias.shape[1]!]));
        const d = conv2d(bnAct(regularOut, block.midBN, block.midActivation), block.w2);
        trunk = tf.add(trunk, d);
      } else {
        const a = bnAct(trunk, block.preBN, block.preActivation);
        let mid = conv2d(a, block.preConv);
        for (const inner of block.blocks) {
          if (inner.kind === 'ordinary') {
            const d = conv2d(bnAct(conv2d(bnAct(mid, inner.preBN, inner.preActivation), inner.w1), inner.midBN, inner.midActivation), inner.w2);
            mid = tf.add(mid, d);
          } else if (inner.kind === 'gpool') {
            const ia = bnAct(mid, inner.preBN, inner.preActivation);
            let ireg = conv2d(ia, inner.w1a);
            const ig2 = bnAct(conv2d(ia, inner.w1b), inner.gpoolBN, inner.gpoolActivation);
            const igBias = tf.matMul(poolRowsGPool(ig2), inner.w1r.w);
            ireg = tf.add(ireg, igBias.reshape([igBias.shape[0]!, 1, 1, igBias.shape[1]!]));
            const d = conv2d(bnAct(ireg, inner.midBN, inner.midActivation), inner.w2);
            mid = tf.add(mid, d);
          } else {
            throw new Error('nested_bottleneck 不支持嵌套(nested_bottleneck 内不应再有 nested)');
          }
        }
        const d = conv2d(bnAct(mid, block.postBN, block.postActivation), block.postConv);
        trunk = tf.add(trunk, d);
      }
    }
    return bnAct(trunk, this.trunkTipBN, this.trunkTipActivation);
  }

  private postprocess(
    policyLogits: Float32Array,
    passLogit: number,
    valueLogits: readonly number[],
    scoreValue: readonly number[],
  ): NetEval {
    const pp = this.postProcess;
    const outScale = pp.outputScaleMultiplier;

    // value:3 值 softmax(win/loss/noResult)
    const winL = valueLogits[0] * outScale;
    const lossL = valueLogits[1] * outScale;
    const noResultL = valueLogits[2] * outScale;
    const maxL = Math.max(winL, lossL, noResultL);
    let winProb = Math.exp(winL - maxL);
    let lossProb = Math.exp(lossL - maxL);
    let noResultProb = Math.exp(noResultL - maxL);
    const sum = winProb + lossProb + noResultProb;
    winProb /= sum;
    lossProb /= sum;
    noResultProb /= sum;

    // score:mean/lead(去 noResult 条件化)
    const scoreMean = scoreValue[0] * outScale * pp.scoreMeanMultiplier * (1 - noResultProb);
    const lead = scoreValue[2] * outScale * pp.leadMultiplier * (1 - noResultProb);

    return { policyLogits, passLogit, winProb, scoreLead: lead, scoreMean, noResultProb };
  }

  dispose(): void {
    const tensors: tf.Tensor[] = [];
    const pushBn = (bn: TfBn): void => {
      tensors.push(bn.scale, bn.bias);
    };
    const pushConv = (conv: TfConv): void => {
      tensors.push(conv.filter);
    };
    const pushBlock = (block: TfTrunkBlock): void => {
      pushBn(block.preBN);
      if (block.kind === 'ordinary') {
        pushConv(block.w1);
        pushBn(block.midBN);
        pushConv(block.w2);
      } else if (block.kind === 'gpool') {
        pushConv(block.w1a);
        pushConv(block.w1b);
        pushBn(block.gpoolBN);
        tensors.push(block.w1r.w);
        pushBn(block.midBN);
        pushConv(block.w2);
      } else {
        pushConv(block.preConv);
        for (const inner of block.blocks) pushBlock(inner);
        pushBn(block.postBN);
        pushConv(block.postConv);
      }
    };
    tensors.push(this.trunkConv1.filter, this.trunkGInput.w);
    for (const block of this.trunkBlocks) pushBlock(block);
    pushBn(this.trunkTipBN);
    tensors.push(this.p1.filter, this.g1.filter);
    pushBn(this.g1BN);
    tensors.push(this.gpoolToBias.w);
    pushBn(this.p1BN);
    tensors.push(this.p2.filter, this.passMul.w);
    if (this.passBias) tensors.push(this.passBias.b);
    if (this.passMul2) tensors.push(this.passMul2.w);
    tensors.push(this.v1.filter);
    pushBn(this.v1BN);
    tensors.push(this.v2.w, this.v2Bias.b, this.v3.w, this.v3Bias.b, this.sv3.w, this.sv3Bias.b);
    tf.dispose(tensors);
  }
}

function toTfBlock(block: ParsedTrunkBlock): TfTrunkBlock {
  if (block.kind === 'ordinary') {
    return {
      kind: 'ordinary',
      preBN: makeBn(block.preBN),
      preActivation: block.preActivation,
      w1: makeConv(block.w1),
      midBN: makeBn(block.midBN),
      midActivation: block.midActivation,
      w2: makeConv(block.w2),
    };
  }
  if (block.kind === 'gpool') {
    return {
      kind: 'gpool',
      preBN: makeBn(block.preBN),
      preActivation: block.preActivation,
      w1a: makeConv(block.w1a),
      w1b: makeConv(block.w1b),
      gpoolBN: makeBn(block.gpoolBN),
      gpoolActivation: block.gpoolActivation,
      w1r: makeMatMul(block.w1r),
      midBN: makeBn(block.midBN),
      midActivation: block.midActivation,
      w2: makeConv(block.w2),
    };
  }
  return {
    kind: 'nested_bottleneck',
    preBN: makeBn(block.preBN),
    preActivation: block.preActivation,
    preConv: makeConv(block.preConv),
    blocks: block.blocks.map(toTfBlock),
    postBN: makeBn(block.postBN),
    postActivation: block.postActivation,
    postConv: makeConv(block.postConv),
  };
}
