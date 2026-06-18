/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base on build so the bundle works at any GitHub Pages path
// (https://<user>.github.io/<repo>/) without hardcoding the repo name.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
  },
}));
