/**
 * 构造 KataGo 模型二进制流的小工具(ASCII token + @BIN@ float32 块),
 * 供 weights/net 测试共用。
 */
export class BinBuilder {
  private parts: Uint8Array[] = [];
  private readonly enc = new TextEncoder();

  tok(s: string): this {
    this.parts.push(this.enc.encode(`${s} `));
    return this;
  }

  int(n: number): this {
    return this.tok(String(n));
  }

  float(n: number): this {
    return this.tok(String(n));
  }

  bin(floats: readonly number[]): this {
    this.parts.push(this.enc.encode('@BIN@'));
    this.parts.push(new Uint8Array(new Float32Array(floats).buffer));
    return this;
  }

  build(): Uint8Array {
    let total = 0;
    for (const p of this.parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

export const zeros = (n: number): number[] => new Array<number>(n).fill(0);

export function bn(b: BinBuilder, channels: number, scale = 1, variance = 3, mean = 0, bias = 0): void {
  b.tok('bn')
    .int(channels)
    .float(1) // epsilon
    .int(1) // hasScale
    .int(1) // hasBias
    .bin(new Array<number>(channels).fill(mean))
    .bin(new Array<number>(channels).fill(variance))
    .bin(new Array<number>(channels).fill(scale))
    .bin(new Array<number>(channels).fill(bias));
}

export function conv(b: BinBuilder, ky: number, kx: number, inC: number, outC: number): void {
  b.tok('conv')
    .int(ky)
    .int(kx)
    .int(inC)
    .int(outC)
    .int(1) // dilationY
    .int(1) // dilationX
    .bin(zeros(ky * kx * inC * outC));
}

export function matmul(b: BinBuilder, inC: number, outC: number): void {
  b.tok('matmul').int(inC).int(outC).bin(zeros(inC * outC));
}

export function matbias(b: BinBuilder, channels: number): void {
  b.tok('matbias').int(channels).bin(zeros(channels));
}

/** v8 最小模型:1 个 ordinary block,22 输入通道,p2 输出 2 通道 */
export function buildV8(): Uint8Array {
  const b = new BinBuilder();
  b.tok('testmodel').int(8).int(22).int(19);
  b.tok('trunk').int(1).int(32).int(32).int(32).int(32).int(32);
  conv(b, 3, 3, 22, 32); // conv1
  matmul(b, 19, 32); // ginput
  b.tok('ordinary_block').tok('block0');
  bn(b, 32);
  b.tok('preAct');
  conv(b, 3, 3, 32, 32); // w1
  bn(b, 32);
  b.tok('midAct');
  conv(b, 3, 3, 32, 32); // w2
  bn(b, 32); // tipBN
  b.tok('tipAct');
  b.tok('policyHead');
  conv(b, 1, 1, 32, 32); // p1
  conv(b, 1, 1, 32, 32); // g1
  bn(b, 32); // g1BN
  b.tok('g1Act');
  matmul(b, 96, 32); // gpoolToBias
  bn(b, 32); // p1BN
  b.tok('p1Act');
  conv(b, 1, 1, 32, 2); // p2(输出 2 通道)
  matmul(b, 96, 2); // passMul
  b.tok('valueHead');
  conv(b, 1, 1, 32, 32); // v1
  bn(b, 32); // v1BN
  b.tok('v1Act');
  matmul(b, 96, 64); // v2
  matbias(b, 64); // v2Bias
  b.tok('v2Act');
  matmul(b, 64, 3); // v3
  matbias(b, 3); // v3Bias
  matmul(b, 64, 6); // sv3
  matbias(b, 6); // sv3Bias
  conv(b, 1, 1, 32, 1); // ownership
  return b.build();
}

/** v15 模型:postProcessParams + metaEncoderVersion + trunkNormKind + pass 头扩展 */
export function buildV15(): Uint8Array {
  const b = new BinBuilder();
  b.tok('testmodel15').int(15).int(22).int(19);
  // postProcessParams(7 个 float)
  b.float(21).float(22).float(23).float(24).float(25).float(0.26).float(31);
  b.int(0); // metaEncoderVersion
  for (let i = 0; i < 7; i++) b.int(0);
  b.tok('trunk').int(1).int(32).int(32).int(32).int(32).int(32);
  b.int(0); // trunkNormKind
  for (let i = 0; i < 5; i++) b.int(0);
  conv(b, 3, 3, 22, 32);
  matmul(b, 19, 32);
  b.tok('ordinary_block').tok('block0');
  bn(b, 32);
  b.tok('preAct').tok('ACTIVATION_RELU');
  conv(b, 3, 3, 32, 32);
  bn(b, 32);
  b.tok('midAct').tok('ACTIVATION_MISH');
  conv(b, 3, 3, 32, 32);
  bn(b, 32);
  b.tok('tipAct').tok('ACTIVATION_MISH');
  b.tok('policyHead');
  conv(b, 1, 1, 32, 32);
  conv(b, 1, 1, 32, 32);
  bn(b, 32);
  b.tok('g1Act').tok('ACTIVATION_RELU');
  matmul(b, 96, 32);
  bn(b, 32);
  b.tok('p1Act').tok('ACTIVATION_RELU');
  conv(b, 1, 1, 32, 2);
  matmul(b, 96, 2);
  matbias(b, 2); // passBias
  b.tok('passAct').tok('ACTIVATION_RELU');
  matmul(b, 2, 2); // passMul2
  b.tok('valueHead');
  conv(b, 1, 1, 32, 32);
  bn(b, 32);
  b.tok('v1Act').tok('ACTIVATION_RELU');
  matmul(b, 96, 64);
  matbias(b, 64);
  b.tok('v2Act').tok('ACTIVATION_RELU');
  matmul(b, 64, 3);
  matbias(b, 3);
  matmul(b, 64, 6);
  matbias(b, 6);
  conv(b, 1, 1, 32, 1);
  return b.build();
}
