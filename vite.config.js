import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Use relative paths for assets
  build: {
    outDir: 'dist', // Build to a dist folder in the current directory
    emptyOutDir: true
  }
});
