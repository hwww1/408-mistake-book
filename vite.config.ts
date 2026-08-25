import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/408-mistake-book/',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}));
