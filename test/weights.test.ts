import { describe, expect, it } from 'vitest';
import { parseKataGoModel } from '../src/engine/weights';
import { BinBuilder, bn, buildV15, buildV8, conv, matmul, matbias } from './helpers/model-builder';

describe('parseKataGoModel', () => {
  it('解析 v8 最小模型', () => {
    const m = parseKataGoModel(buildV8());
    expect(m.modelName).toBe('testmodel');
    expect(m.modelVersion).toBe(8);
    expect(m.numInputChannels).toBe(22);
    expect(m.numInputGlobalChannels).toBe(19);
    expect(m.metaEncoderVersion).toBe(0);
    expect(m.trunk.numBlocks).toBe(1);
    expect(m.trunk.conv1.kernelY).toBe(3);
    expect(m.trunk.conv1.inChannels).toBe(22);
    expect(m.trunk.conv1.outChannels).toBe(32);
    expect(m.trunk.blocks[0]?.kind).toBe('ordinary');
    expect(m.policyOutChannels).toBe(2);
    expect(m.scoreValueChannels).toBe(6);
    // v8 无 postProcessParams → 默认值
    expect(m.postProcessParams.scoreMeanMultiplier).toBe(20);
    expect(m.postProcessParams.varianceTimeMultiplier).toBe(40);
    expect(m.postProcessParams.outputScaleMultiplier).toBe(1);
    // v8 无 pass 头扩展
    expect(m.policy.passBias).toBeUndefined();
  });

  it('BN 合并 scale/sqrt(var+eps) 与 bias', () => {
    const b = new BinBuilder();
    b.tok('test').int(8).int(22).int(19);
    b.tok('trunk').int(0).int(32).int(32).int(32).int(32).int(32);
    conv(b, 3, 3, 22, 32);
    matmul(b, 19, 32);
    // 专门的 BN:scale=2,var=3,eps=1,mean=1,bias=5 → ms=1,bias'=4
    b.tok('tipbn').int(32).float(1).int(1).int(1)
      .bin(new Array<number>(32).fill(1))
      .bin(new Array<number>(32).fill(3))
      .bin(new Array<number>(32).fill(2))
      .bin(new Array<number>(32).fill(5));
    b.tok('tipAct');
    b.tok('policyHead');
    conv(b, 1, 1, 32, 32);
    conv(b, 1, 1, 32, 32);
    bn(b, 32);
    b.tok('g1Act');
    matmul(b, 96, 32);
    bn(b, 32);
    b.tok('p1Act');
    conv(b, 1, 1, 32, 2);
    matmul(b, 96, 2);
    b.tok('valueHead');
    conv(b, 1, 1, 32, 32);
    bn(b, 32);
    b.tok('v1Act');
    matmul(b, 96, 64);
    matbias(b, 64);
    b.tok('v2Act');
    matmul(b, 64, 3);
    matbias(b, 3);
    matmul(b, 64, 6);
    matbias(b, 6);
    conv(b, 1, 1, 32, 1);

    const m = parseKataGoModel(b.build());
    expect(m.trunk.tipBN.mergedScale[0]).toBeCloseTo(1); // 2/sqrt(3+1)
    expect(m.trunk.tipBN.mergedBias[0]).toBeCloseTo(4); // 5 - 1*1
  });

  it('解析 v15 模型(postProcessParams、pass 头扩展、激活类型)', () => {
    const m = parseKataGoModel(buildV15());
    expect(m.modelVersion).toBe(15);
    expect(m.postProcessParams.tdScoreMultiplier).toBe(21);
    expect(m.postProcessParams.scoreMeanMultiplier).toBe(22);
    expect(m.postProcessParams.shorttermScoreErrorMultiplier).toBe(31);
    expect(m.policy.passBias?.channels).toBe(2);
    expect(m.policy.passActivation).toBe('relu');
    expect(m.policy.passMul2?.inChannels).toBe(2);
    const block = m.trunk.blocks[0];
    expect(block?.kind).toBe('ordinary');
    if (block?.kind === 'ordinary') {
      expect(block.preActivation).toBe('relu');
      expect(block.midActivation).toBe('mish');
    }
    expect(m.trunk.tipActivation).toBe('mish');
  });

  it('拒绝不支持的 modelVersion', () => {
    const b = new BinBuilder();
    b.tok('test').int(7);
    expect(() => parseKataGoModel(b.build())).toThrow(/Unsupported modelVersion/);
  });

  it('拒绝 metaEncoderVersion != 0', () => {
    const b = new BinBuilder();
    b.tok('test').int(15).int(22).int(19);
    b.float(20).float(20).float(20).float(20).float(40).float(0.25).float(30);
    b.int(1); // 不支持的 meta encoder
    expect(() => parseKataGoModel(b.build())).toThrow(/metaEncoderVersion/);
  });

  it('拒绝 trunkNormKind != 0', () => {
    const b = new BinBuilder();
    b.tok('test').int(15).int(22).int(19);
    b.float(20).float(20).float(20).float(20).float(40).float(0.25).float(30);
    b.int(0);
    for (let i = 0; i < 7; i++) b.int(0);
    b.tok('trunk').int(0).int(32).int(32).int(32).int(32).int(32);
    b.int(1); // 不支持的 norm kind
    expect(() => parseKataGoModel(b.build())).toThrow(/trunk norm kind/);
  });

  it('缺 @BIN@ 标记时抛错', () => {
    const b = new BinBuilder();
    b.tok('test').int(8).int(22).int(19);
    b.tok('trunk').int(0).int(32).int(32).int(32).int(32).int(32);
    b.tok('conv').int(3).int(3).int(22).int(32).int(1).int(1);
    b.tok('NOTBIN'); // 缺少 @BIN@
    expect(() => parseKataGoModel(b.build())).toThrow(/@BIN@/);
  });
});
