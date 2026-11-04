import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react()],
    envDir: '../..',
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
      proxy: {
        '/api': { target: env.API_PROXY_TARGET || 'http://127.0.0.1:3001', changeOrigin: true },
      },
    },
    preview: { host: '0.0.0.0', allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'] },
  };
});
