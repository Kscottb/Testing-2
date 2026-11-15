import { defineConfig } from 'vite';

// Stable, hash-free output names so the build can be repackaged (e.g. as a single inline page).
export default defineConfig({
  base: './',
  cacheDir: process.env.SH_VITE_CACHE ?? 'node_modules/.vite',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/game.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
        inlineDynamicImports: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
