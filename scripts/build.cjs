const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const output = path.join(root, '_site');
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('_site must not be a symlink');
fs.rmSync(output, { recursive: true, force: true });
const result = spawnSync(process.execPath, [require.resolve('@11ty/eleventy/cmd.js')], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
for (const name of ['blog', 'me']) {
  if (fs.existsSync(path.join(root, name)) && fs.lstatSync(path.join(root, name)).isSymbolicLink()) throw new Error(`${name} must not be a symlink`);
  fs.cpSync(path.join(output, name), path.join(root, name), { recursive: true });
}
console.log('\nГотово: blog/ и me/ обновлены. Для отправки на GitHub: npm run publish');
