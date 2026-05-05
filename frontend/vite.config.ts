import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_TARGET || 'http://127.0.0.1:3000';

  return {
    root: '.',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/scrape/stream': { target, changeOrigin: true },
        '/scrape': { target, changeOrigin: true },
        '/health': { target, changeOrigin: true },
      },
    },
  };
});
