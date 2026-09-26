// Bundles the API into dist/ (dependencies stay external and come from node_modules).
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/main.ts', migrate: 'src/migrate-cli.ts', admin: 'src/admin-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
