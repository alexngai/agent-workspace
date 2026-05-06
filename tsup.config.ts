import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/protocol/index.ts',
    'src/protocol/task.ts',
    'src/protocol/resource-events.ts',
    'src/protocol/repo.ts',
    'src/kinds/repo/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
