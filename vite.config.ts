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
      // changeOrigin 必须为 false:改写 Host 会让后端的同源(CSRF)校验把
      // 手机发来的 Origin(192.168.x.x:5173)判成跨站,所有 POST 直接 403
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: ['.local'],
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
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
