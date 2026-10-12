// Builds the static GitHub Pages site into dist/.
// There is no server on Pages, so the page runs the shared core against
// SQLite in the browser (sql.js). Same files, same paths as the Node server.

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'vendor'), { recursive: true });
await cp(path.join(root, 'web'), dist, { recursive: true });
await cp(path.join(root, 'core'), path.join(dist, 'core'), { recursive: true });
for (const file of ['sql-wasm.js', 'sql-wasm.wasm']) {
  await cp(path.join(root, 'node_modules/sql.js/dist', file), path.join(dist, 'vendor', file));
}
await writeFile(path.join(dist, '.nojekyll'), '');
console.log('Built static site in dist/');
