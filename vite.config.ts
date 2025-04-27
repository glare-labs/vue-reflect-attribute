import { defineConfig } from 'vite'
import ts from '@rollup/plugin-typescript'

export default defineConfig({
  build: {
    lib: {
      entry: './lib/vue-reflect-attribute.ts',
      formats: ['es']
    },
    outDir: './build',
    emptyOutDir: false,
    minify: "terser",
    rollupOptions: {
      plugins: [
        ts({ tsconfig: './tsconfig.json' }),
      ],
      external: [
        'vue',
      ],
      output: {
        globals: {
          vue: 'Vue'
        },
      },
    },
  },
})
