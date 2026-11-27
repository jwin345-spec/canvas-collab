import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // The shared package ships TypeScript source ("internal package"), so it must be bundled.
  // Everything else, notably yjs, stays external so there is exactly one Yjs instance.
  noExternal: ['@canvas-collab/shared'],
});
