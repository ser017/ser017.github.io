const escape = value => String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const normalize = value => {
  const url = String(value || '').replace(/^https?:\/\/ser017\.ru(?=\/|$)/i, '').split(/[?#]/)[0];
  return url.replace(/\/index\.html$/, '/').replace(/\/*$/, '/');
};
module.exports = function articlePreview(url, description = '') {
  const posts = this.ctx?.collections?.posts || [];
  const target = normalize(url);
  const post = posts.find(item => normalize(item.url) === target);
  if (!post) throw new Error(`articlePreview: статья ${url} не найдена. Укажите её адрес, например /blog/howtochina/.`);
  const title = escape(post.data.title);
  const summary = escape(description || post.data.excerpt);
  const cover = post.data.cover && String(post.data.cover).replace(/^\/assets\//, '/blog/assets/');
  const image = cover ? `<img class="article-preview__image no-zoom" src="${escape(cover)}" alt="" loading="lazy" decoding="async">` : '';
  return `<a class="article-preview${cover ? '' : ' article-preview--text'}" href="${escape(post.url)}" target="_blank" rel="noopener noreferrer">${image}<span class="article-preview__content"><span class="article-preview__title">${title}</span>${summary ? `<span class="article-preview__summary">${summary}</span>` : ''}</span></a>`;
};