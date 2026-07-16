import { defineConfig } from 'rolldown';

export default defineConfig({
  input: { editor: 'src/client/editor/main.ts', search: 'src/client/search/main.ts' },
  output: { dir: 'public/build', format: 'esm', sourcemap: true, minify: true },
  platform: 'browser',
});
