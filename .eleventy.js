const fs = require('node:fs');
const markdownIt = require('markdown-it');
module.exports = function (config) {
  config.addShortcode('articlePreview', require('./scripts/article-preview.cjs'));
  const excluded = new Set(['node_modules', 'scripts', 'blog', 'me']);
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    if (/^[._]/.test(entry.name) || excluded.has(entry.name)) continue;
    if (entry.isDirectory() || /\.(html|css|js|ico|png|jpg|svg|webp|txt|xml)$/.test(entry.name) || entry.name === 'CNAME') config.addPassthroughCopy({ [entry.name]: entry.name });
  }
  config.addPassthroughCopy({ '_blog/assets': 'blog/assets' });
  for (const name of ['.nojekyll', '.htaccess']) {
    if (fs.existsSync(name)) config.addPassthroughCopy({ [name]: name });
  }
  config.addWatchTarget('_blog/assets');
  config.setServerOptions({ port: 8080, showAllHosts: false });
  config.addGlobalData('baseUrl', 'https://ser017.ru');
  const birth = new Date(1999, 2, 1), now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
  config.addGlobalData('age', age);
  config.addFilter('yearNow', () => new Date().getFullYear());
  config.addFilter('readableDate', d => new Date(d).toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }));
  config.addFilter('htmlDateString', d => new Date(d).toISOString().split('T')[0]);
  config.addFilter('slug', str => String(str || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w\-а-яё]/gi, '').replace(/-+/g, '-'));
  config.addFilter('assetUrl', value => String(value || '').replace(/^\/assets\//, '/blog/assets/'));
  config.addFilter('absurl', value => !value ? '/' : /^(https?:\/\/|\/)/.test(value) ? value : `/${value}`);
  config.addCollection('posts', api => api.getFilteredByGlob('_blog/posts/**/*.md').sort((a, b) => b.date - a.date));
  config.addCollection('tagList', api => {
    const counts = new Map();
    for (const item of api.getAll()) {
      if (item.data.listed === false) continue;
      for (const tag of item.data.tags || []) {
        if (!['all', 'posts'].includes(tag)) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  });
  const md = markdownIt({ html: true, linkify: true, typographer: true });
  const image = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx], src = token.attrGet('src');
    if (src && src.startsWith('/assets/')) token.attrSet('src', `/blog${src}`);
    return image ? image(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
  config.setLibrary('md', md);
  config.addTransform('prefix-assets', (content, outputPath) => {
    if (!outputPath || !outputPath.endsWith('.html')) return content;
    return content.replace(/\b(src|href|poster)=(['"])\/assets\//g, '$1=$2/blog/assets/')
      .replace(/\bsrcset=(['"])(.*?)\1/gs, (_, quote, value) => `srcset=${quote}${value.replace(/(^|,\s*)\/assets\//g, '$1/blog/assets/')}${quote}`);
  });
  return { dir: { input: '_blog', includes: '_includes', data: '_data', output: '_site' }, pathPrefix: '/', markdownTemplateEngine: 'njk', htmlTemplateEngine: 'njk', templateFormats: ['md', 'njk', 'html'] };
};
