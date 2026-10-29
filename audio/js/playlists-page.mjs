import { getJSON, playlistButton } from './catalog.mjs';
const container = document.getElementById('playlists-list');
async function load() {
  container.textContent = 'Загрузка плейлистов…';
  try {
    const playlists = await getJSON('playlists/playlists.json');
    container.replaceChildren(...playlists.map(playlist => playlistButton(playlist, item => {
      location.href = `../?playlist=${encodeURIComponent(item.list)}`;
    })));
  } catch {
    container.textContent = 'Не удалось загрузить плейлисты. ';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Повторить'; retry.onclick = load; container.append(retry);
  }
}
load();
