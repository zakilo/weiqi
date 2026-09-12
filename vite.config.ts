import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 相对路径资源,便于任意静态托管与本地打开
  base: './',
  server: {
    // 监听所有网卡,允许局域网内其他设备访问
    host: true,
    port: 5173,
    strictPort: false,
    // 放行 Bonjour/mDNS 主机名(xxx.local),否则会被 Vite 的 Host 校验拦成 403
    allowedHosts: ['.local'],
    // 前端经此代理访问本机 AI 服务(node server/index.ts,:8080)
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: ['.local'],
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
