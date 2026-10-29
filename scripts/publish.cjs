const { spawnSync } = require('node:child_process');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
function git(args, capture = false) {
  const r = spawnSync('git', args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.status !== 0) {
    if (capture) process.stderr.write(r.stderr || 'Ошибка Git\n');
    process.exit(r.status || 1);
  }
  return (r.stdout || '').trim();
}
git(['rev-parse', '--is-inside-work-tree'], true);
if (git(['diff', '--cached', '--name-only'], true)) {
  console.error('Уже есть подготовленные изменения в Git. Сначала завершите или отмените их подготовку, затем повторите публикацию.');
  process.exit(1);
}
git(['fetch', 'origin']);
const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], true);
const ahead = spawnSync('git', ['merge-base', '--is-ancestor', upstream, 'HEAD']);
if (ahead.status !== 0) {
  console.error('На GitHub появились новые изменения. Сначала сохраните свои изменения и выполните git pull --ff-only. Публикация остановлена.');
  process.exit(1);
}
const build = spawnSync(process.execPath, [path.join(__dirname, 'build.cjs')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);
git(['add', '--', '_blog', '.eleventy.js', 'package.json', 'package-lock.json', 'scripts', 'README-BLOG.md', '.gitignore', '.nojekyll', 'blog', 'me', 'index.html', 'favicon.ico', 'audio', 'store/index.html', '404/index.html', '404.html']);
if (git(['diff', '--cached', '--name-only'], true)) {
  const message = process.argv.slice(2).join(' ') || `Обновление блога ${new Date().toLocaleDateString('sv-SE')}`;
  git(['commit', '-m', message]);
}
git(['push']);
console.log('\nОтправлено на GitHub. Дождитесь завершения публикации GitHub Pages.');
