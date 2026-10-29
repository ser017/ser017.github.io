const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { parse } = require('node-html-parser');
const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, '_blog', 'assets', 'images');
const CACHE = path.join(ROOT, '.image-cache');
const PREFIX = '/blog/assets/images/';
const WEB = '/blog/assets/optimized/';
const VERSION = 'v1';
let images = new Map();
let active = 0;
const queue = [];
sharp.concurrency(2);
async function limited(task) {
  if (active >= 4) await new Promise(resolve => queue.push(resolve));
  active++;
  try { return await task(); }
  finally { active--; queue.shift()?.(); }
}
function ancestor(node, selector) {
  let parent = node.parentNode;
  while (parent) {
    if (parent.classList && selector.some(name => parent.classList.contains(name))) return parent;
    parent = parent.parentNode;
  }
  return null;
}
function sizes(img) {
  if (img.classList.contains('article-preview__image')) return '(max-width: 600px) 104px, 176px';
  if (ancestor(img, ['figure-sm'])) return '(max-width: 448px) calc(100vw - 48px), 400px';
  const row = ancestor(img, ['images-row']);
  if (row) {
    const count = row.classList.contains('cols-4') ? 4 : row.classList.contains('cols-3') ? 3 : 2;
    return `(max-width: 640px) calc(100vw - 48px), ${Math.floor((740 - 16 * (count - 1)) / count)}px`;
  }
  if (img.classList.contains('article-cover')) return '(max-width: 1440px) calc(100vw - 48px), 1400px';
  if (ancestor(img, ['card'])) return '(max-width: 640px) calc(100vw - 48px), (max-width: 1248px) 55vw, 660px';
  return '(max-width: 788px) calc(100vw - 48px), 740px';
}
async function variants(file) {
  const stat = await fs.promises.stat(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (!images.has(key)) images.set(key, limited(async () => {
    const sourceBuffer = await fs.promises.readFile(file);
    const needsCompatibleFull = /\.(heic|heif)$/i.test(file);
    const isHeic = needsCompatibleFull && sourceBuffer.subarray(4, 8).toString() === 'ftyp';
    let buffer = sourceBuffer;
    if (isHeic) {
      const decoded = await require('heic-decode')({ buffer: sourceBuffer });
      buffer = await sharp(Buffer.from(decoded.data), { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
    }
    const metadata = await sharp(buffer).metadata();
    const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    if (!width || !height) return null;
    // Анимацию не превращаем в неподвижную картинку; маленькие иконки оставляем как есть.
    if ((metadata.pages || 1) > 1 || width < 160) return { width, height, files: [] };
    const quality = metadata.format === 'png' ? 90 : 84;
    const id = crypto.createHash('sha256').update(buffer).update(`${VERSION}:${quality}`).digest('hex').slice(0, 20);
    const widths = [...new Set([320, 640, 960, 1440].filter(w => w < width).concat(Math.min(width, 1440)))];
    await fs.promises.mkdir(CACHE, { recursive: true });
    const files = [];
    for (const w of widths) {
      const name = `${id}-${w}.webp`;
      const cached = path.join(CACHE, name);
      if (!fs.existsSync(cached)) {
        const bytes = await sharp(buffer).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality, effort: 4 }).toBuffer();
        await fs.promises.writeFile(cached, bytes);
      }
      files.push({ width: w, name, cached });
    }
    let full = null;
    if (needsCompatibleFull) {
      const name = `${id}-full.jpg`;
      const cached = path.join(CACHE, name);
      if (!fs.existsSync(cached)) await sharp(buffer).jpeg({ quality: 95 }).toFile(cached);
      full = { name, cached };
    }
    return { width, height, files, full };
  }));
  return images.get(key);
}
async function optimize(content, outputPath) {
  if (!outputPath || !outputPath.endsWith('.html') || !content.includes('<img')) return content;
  // Реальная папка вывода учитывает и npm start (_site), и npm run build (_build).
  const relative = path.relative(ROOT, path.resolve(outputPath));
  const first = relative.split(path.sep)[0];
  if (!first.startsWith('_') || first === '..') throw new Error(`Unexpected image output: ${outputPath}`);
  const destination = path.join(ROOT, first, 'blog', 'assets', 'optimized');
  const document = parse(content, { comment: true });
  const nodes = document.querySelectorAll('img');
  await Promise.all(nodes.map(async (img, index) => {
    const src = img.getAttribute('src') || '';
    if (!src.startsWith(PREFIX) || img.hasAttribute('data-no-optimize') || img.hasAttribute('srcset') || ancestorTag(img, 'PICTURE')) return;
    const suffix = decodeURIComponent(src.slice(PREFIX.length).split(/[?#]/)[0]);
    const file = path.resolve(IMAGES, suffix);
    if (!file.startsWith(IMAGES + path.sep) || !/\.(jpe?g|png|webp|heic|heif|avif)$/i.test(file)) return;
    if (!fs.existsSync(file)) { console.warn(`[images] Not found: ${src}`); return; }
    const result = await variants(file);
    if (!result) return;
    const hero = img.classList.contains('article-cover');
    if (hero || index === 0) {
      img.setAttribute('loading', 'eager');
      img.setAttribute('fetchpriority', 'high');
    } else if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    if (!img.hasAttribute('width') && !img.hasAttribute('height')) {
      img.setAttribute('width', String(result.width));
      img.setAttribute('height', String(result.height));
    }
    if (!result.files.length) return;
    await fs.promises.mkdir(destination, { recursive: true });
    for (const item of result.files.concat(result.full ? [result.full] : [])) {
      const output = path.join(destination, item.name);
      if (!fs.existsSync(output)) await fs.promises.copyFile(item.cached, output);
    }
    // Оригинал нужен только для просмотра крупным планом, он не загружается заранее.
    if (ancestor(img, ['post-body']) && !img.classList.contains('no-zoom')) img.setAttribute('data-full', result.full ? WEB + result.full.name : src);
    const fallback = result.files.find(item => item.width >= 960) || result.files[result.files.length - 1];
    img.setAttribute('src', WEB + fallback.name);
    img.setAttribute('srcset', result.files.map(item => `${WEB}${item.name} ${item.width}w`).join(', '));
    if (!img.hasAttribute('sizes')) img.setAttribute('sizes', sizes(img));
  }));
  return document.toString();
}
function ancestorTag(img, tag) {
  let parent = img.parentNode;
  while (parent) { if (parent.tagName === tag) return true; parent = parent.parentNode; }
  return false;
}
module.exports = optimize;
module.exports.reset = () => { images = new Map(); };