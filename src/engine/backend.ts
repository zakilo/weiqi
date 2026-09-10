/**
 * TF.js 计算后端初始化:webgpu → wasm → cpu 逐级回退。
 */
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
import '@tensorflow/tfjs-backend-wasm';

export type BackendKind = 'webgpu' | 'wasm' | 'cpu';

export const BACKEND_LABEL: Record<BackendKind, string> = {
  webgpu: 'WebGPU',
  wasm: 'WASM',
  cpu: 'CPU',
};

let currentBackend: BackendKind | null = null;

/** 当前已初始化的后端(未初始化返回 null) */
export function getBackend(): BackendKind | null {
  return currentBackend;
}

/**
 * 依次尝试 webgpu → wasm → cpu,返回实际使用的后端。
 * wasm 后端依赖 wasm 二进制路径(由 tfjs-backend-wasm 提供)。
 * @param allowWebgpu 是否允许 WebGPU。个别驱动在多实例 GPU 后端
 * 并发时会不稳定,必要时可传 false 强制走 wasm → cpu。
 */
export async function initBackend(allowWebgpu = true): Promise<BackendKind> {
  const candidates: Array<[BackendKind, () => Promise<boolean>]> = [
    [
      'webgpu',
      async () => {
        if (!('gpu' in navigator)) return false;
        try {
          await tf.setBackend('webgpu');
          await tf.ready();
          return true;
        } catch {
          return false;
        }
      },
    ],
    [
      'wasm',
      async () => {
        try {
          const wasm = await import('@tensorflow/tfjs-backend-wasm');
          wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@latest/dist/');
          await tf.setBackend('wasm');
          await tf.ready();
          return true;
        } catch {
          return false;
        }
      },
    ],
    [
      'cpu',
      async () => {
        try {
          await tf.setBackend('cpu');
          await tf.ready();
          return true;
        } catch {
          return false;
        }
      },
    ],
  ];

  if (!allowWebgpu) candidates.shift();

  for (const [kind, tryInit] of candidates) {
    if (await tryInit()) {
      currentBackend = kind;
      return kind;
    }
  }
  throw new Error('无法初始化任何 TF.js 后端(webgpu/wasm/cpu 均失败)');
}
