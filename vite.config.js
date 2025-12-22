import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl']
        }
      }
    }
  },
  optimizeDeps: {
    include: ['maplibre-gl']
  }
});
