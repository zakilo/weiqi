/**
 * 分析 Worker:持有独立 TF.js 后端与 KataGoNet,
 * 持续分析局面并周期性回报候选快照;按候选着法展开变化线。
 * 新任务到达自动作废旧任务,stop 取消一切进行中的任务。
 */
import {
  ANALYSIS_PROGRESS_EVERY,
  AnalysisTask,
  requestFromWire,
  searchVariation,
  WorkerIn,
  WorkerOut,
} from './analysis-engine';
import { BACKEND_LABEL, BackendKind, initBackend } from './backend';
import { KataGoNet } from './net';
import { parseKataGoModel } from './weights';

let net: KataGoNet | null = null;
/** 当前计算后端(init 后设置) */
let backendKind: BackendKind | null = null;
/** 任务代际:任何新任务/停止都会递增,旧循环据此退出 */
let generation = 0;

/** 非 WebGPU 后端每步变化线推理次数封顶(cpu 前向慢,防止变化线等待过久) */
const SLOW_BACKEND_VARIATION_CAP = 24;

const post = (msg: WorkerOut): void => {
  (self as unknown as { postMessage(msg: WorkerOut): void }).postMessage(msg);
};

const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  void handle(e.data);
};

async function handle(msg: WorkerIn): Promise<void> {
  switch (msg.type) {
    case 'init': {
      try {
        // WebGPU 优先:分析在独立 Worker 中跑,GPU 空闲时与主线程不冲突;
        // 不可用自动回退 wasm/cpu(回退后端变化线推理次数封顶,见 variation 分支)
        backendKind = await initBackend();
        net?.dispose();
        net = new KataGoNet(parseKataGoModel(new Uint8Array(msg.modelBytes)));
        post({ type: 'ready', backend: BACKEND_LABEL[backendKind] });
      } catch (err) {
        post({ type: 'error', id: null, message: String(err) });
      }
      break;
    }
    case 'analyze': {
      if (!net) {
        post({ type: 'error', id: msg.id, message: '模型未初始化' });
        break;
      }
      const gen = ++generation;
      const task = new AnalysisTask(net);
      try {
        await task.start(requestFromWire(msg.request));
        for await (const snap of task.iterate(ANALYSIS_PROGRESS_EVERY)) {
          if (generation !== gen) break;
          post({ type: 'snapshot', id: msg.id, snapshot: snap });
          await yieldToMain();
        }
      } catch (err) {
        if (generation === gen) post({ type: 'error', id: msg.id, message: String(err) });
      }
      break;
    }
    case 'variation': {
      if (!net) {
        post({ type: 'error', id: msg.id, message: '模型未初始化' });
        break;
      }
      const gen = ++generation;
      try {
        // 慢后端(cpu/wasm)下降低每步推理次数,避免 15 步变化线等待过久
        const perMove =
          backendKind === 'webgpu'
            ? msg.perMovePlayouts
            : Math.min(msg.perMovePlayouts, SLOW_BACKEND_VARIATION_CAP);
        const line = await searchVariation(net, requestFromWire(msg.request), msg.startMove, {
          perMovePlayouts: perMove,
          depth: msg.depth,
          isCancelled: () => generation !== gen,
          onStep: (move, index) => {
            if (generation === gen) post({ type: 'variation-step', id: msg.id, move, index });
          },
        });
        if (generation === gen) post({ type: 'variation-done', id: msg.id, line });
      } catch (err) {
        if (generation === gen) post({ type: 'error', id: msg.id, message: String(err) });
      }
      break;
    }
    case 'stop': {
      generation++;
      break;
    }
  }
}
