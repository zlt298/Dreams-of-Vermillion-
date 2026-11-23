import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    // the app and lancer-data chunks are deliberate (~0.5–0.6 MB each); Three.js loads with the first battle
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // long-lived vendor chunks: the 3D engine (loaded with the first battle) and the LANCER data
        manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : id.includes('@massif/lancer-data') ? 'lancer-data' : undefined),
      },
    },
  },
  server: { fs: { allow: ['..'] } },
  test: { environment: 'node' },
} as any)
