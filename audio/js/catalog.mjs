const base = new URL('../', import.meta.url);
export async function getJSON(relative, signal) {
  const response = await fetch(new URL(relative, base), { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid catalog');
  return data;
}
export class Catalog {
  constructor() { this.playlists = []; this.links = new Map(); this.cache = new Map(); }
  async load() {
    const [links, playlists] = await Promise.all([getJSON('links.json'), getJSON('playlists/playlists.json')]);
    this.links = new Map(links.filter(item => /^https?:\/\//i.test(item.link)).map(item => [item.name, item.link]));
    this.playlists = playlists.filter(item => /^[\w-]+$/.test(item.list));
    return this.playlists;
  }
  async tracks(playlist, signal) {
    if (!this.cache.has(playlist.list)) {
      const rows = await getJSON(`playlists/${playlist.list}/tracks.json`, signal);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const unique = new Map();
      for (const row of rows) if (row.name && !unique.has(row.name)) unique.set(row.name, {
        ...row, url: this.links.get(row.name) || null,
        cover: new URL(playlist.cover || 'favicon.png', base).href,
        album: playlist.title || '',
      });
      this.cache.set(playlist.list, [...unique.values()]);
    }
    return this.cache.get(playlist.list);
  }
}
export function playlistButton(playlist, onSelect) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'playlist-card';
  const image = document.createElement('img');
  image.src = new URL(playlist.cover || 'favicon.png', base).href;
  image.alt = ''; image.className = 'playlist-cover'; image.loading = 'lazy';
  button.append(image);
  for (const [className, value] of [['playlist-title', playlist.title], ['playlist-author', playlist.author || '']]) {
    const text = document.createElement('span'); text.className = className; text.textContent = value;
    button.append(text);
  }
  button.addEventListener('click', () => onSelect(playlist));
  return button;
}
