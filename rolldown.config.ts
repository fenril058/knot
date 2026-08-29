import { defineConfig } from 'rolldown';

export default defineConfig({
  input: {
    editor: 'src/client/editor/main.ts',
    'project-index': 'src/client/projectIndex/main.ts',
    search: 'src/client/search/main.ts',
    'page-menu': 'src/client/pageMenu/main.ts',
  },
  output: { dir: 'public/build', format: 'esm', sourcemap: true, minify: true },
  platform: 'browser',
});
