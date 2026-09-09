import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径资源,便于任意静态托管与本地打开
  base: './',
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
  },
});
