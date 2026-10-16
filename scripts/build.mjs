import { mkdir, copyFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'style.css', 'core.mjs', 'viewer.mjs', '.nojekyll']) {
  await copyFile(file, `dist/${file}`);
}
console.log('Built static site in dist/ (no dependencies required)');
