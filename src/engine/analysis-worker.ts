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
import { initBackend } from './backend';
import { KataGoNet } from './net';
import { parseKataGoModel } from './weights';

let net: KataGoNet | null = null;
/** 任务代际:任何新任务/停止都会递增,旧循环据此退出 */
let generation = 0;

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
        const backend = await initBackend();
        net?.dispose();
        net = new KataGoNet(parseKataGoModel(new Uint8Array(msg.modelBytes)));
        post({ type: 'ready', backend });
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
        const line = await searchVariation(net, requestFromWire(msg.request), msg.startMove, {
          perMovePlayouts: msg.perMovePlayouts,
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
