import { mkdir, copyFile, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'style.css', 'core.mjs', 'viewer.mjs', '.nojekyll']) {
  await copyFile(file, `dist/${file}`);
}
await cp('assets', 'dist/assets', { recursive: true });
// HTML revalidation should always load a matching set of CSS/modules, even
// when a work browser still has the previous interface cached for ten minutes.
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
const core = await readFile('core.mjs', 'utf8');
const coreName = `core-${digest(core)}.mjs`;
const viewer = (await readFile('viewer.mjs', 'utf8')).replace("'./core.mjs'", `'./${coreName}'`);
const viewerName = `viewer-${digest(viewer)}.mjs`;
const style = await readFile('style.css', 'utf8');
const styleName = `style-${digest(style)}.css`;
await writeFile(`dist/${coreName}`, core);
await writeFile(`dist/${viewerName}`, viewer);
await writeFile(`dist/${styleName}`, style);
const html = (await readFile('index.html', 'utf8')).replace('./viewer.mjs', `./${viewerName}`).replace('./style.css', `./${styleName}`);
await writeFile('dist/index.html', html);
console.log('Built static site in dist/ (no dependencies required)');
