import { Catalog, playlistButton } from './catalog.mjs';
import { AudioPlayer } from './player.mjs';

const $ = id => document.getElementById(id);
const audio = $('audio-element');
const player = new AudioPlayer(audio);
const catalog = new Catalog();
let visible = [], filtered = [], playlist = null;
let loadVersion = 0, loadController = null, retryCatalog = null;
let metadataId = null;
const seekDragging = new Set();
const storageKey = 'ser017-audio-volume';
let lastVolume = 1;

function time(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
}
function setStatus(text, retry = null) {
  $('playback-status').textContent = text;
  $('playback-retry').hidden = !retry;
  $('playback-retry').onclick = retry;
}
function trackMessage(text, retry = null) {
  $('track-list').replaceChildren();
  const message = document.createElement('p'); message.className = 'catalog-message'; message.textContent = text;
  message.setAttribute('role', 'status'); $('track-list').append(message);
  if (retry) {
    const button = document.createElement('button'); button.className = 'catalog-retry'; button.textContent = 'Повторить';
    button.type = 'button'; button.onclick = retry; $('track-list').append(button);
  }
}
function renderTracks() {
  const query = $('search-input').value.trim().toLocaleLowerCase();
  filtered = visible.filter(track => `${track.artist} ${track.title}`.toLocaleLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const track of filtered) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'track'; button.dataset.trackId = track.name;
    button.textContent = `${track.artist} — ${track.title}`;
    button.disabled = !track.url;
    if (!track.url) button.title = 'Для этого трека пока нет ссылки';
    button.onclick = () => {
      if (player.track?.name === track.name) player.toggle();
      else player.start(filtered, track.name);
    };
    fragment.append(button);
  }
  $('track-list').replaceChildren(fragment);
  if (!filtered.length) trackMessage(query ? 'По этому запросу ничего не найдено.' : 'В плейлисте пока нет треков.');
  $('shuffle-above-tracks').hidden = filtered.filter(track => track.url).length < 2;
  $('shuffle-above-tracks').style.display = filtered.filter(track => track.url).length < 2 ? 'none' : '';
  highlight();
}
function highlight() {
  document.querySelectorAll('#track-list .track').forEach(button => {
    const active = button.dataset.trackId === player.track?.name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'true' : 'false');
  });
}
async function selectPlaylist(value) {
  const version = ++loadVersion;
  loadController?.abort(); loadController = new AbortController();
  playlist = value; visible = []; filtered = [];
  $('shuffle-above-tracks').style.display = 'none';
  trackMessage('Загрузка плейлиста…');
  document.querySelectorAll('[data-playlist-id]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.playlistId === value.list)));
  try {
    const tracks = await catalog.tracks(value, loadController.signal);
    if (version !== loadVersion) return;
    visible = tracks;
    renderTracks();
  } catch (error) {
    if (version !== loadVersion || error.name === 'AbortError') return;
    trackMessage('Не удалось загрузить плейлист. Проверьте соединение.', () => selectPlaylist(value));
  }
}
async function initialize() {
  trackMessage('Загрузка музыки…');
  try {
    const lists = await catalog.load();
    $('playlists-list').replaceChildren(...lists.slice(0, 7).map(list => {
      const button = playlistButton(list, selectPlaylist); button.dataset.playlistId = list.list; return button;
    }));
    const all = $('show-all-playlists');
    all.style.display = lists.length > 7 ? '' : 'none'; all.onclick = () => { location.href = 'playlists/'; };
    const requested = new URL(location.href).searchParams.get('playlist');
    const initial = lists.find(list => list.list === requested) || lists[0];
    if (initial) await selectPlaylist(initial); else trackMessage('Плейлисты пока не добавлены.');
  } catch {
    trackMessage('Не удалось загрузить каталог музыки. Проверьте соединение.', initialize);
  }
}
function togglePlayback() {
  if (!player.track) player.start(filtered, filtered.find(track => track.url)?.name);
  else player.toggle();
}
function renderPlayer() {
  const track = player.track;
  const title = track ? `${track.artist} — ${track.title}` : '';
  $('now-playing').textContent = title ? `Сейчас играет: ${title}` : 'Сейчас ничего не играет';
  $('bp-title').textContent = title || 'Выберите трек'; $('bp-title').title = title;
  for (const id of ['play-pause', 'bottom-play-pause']) {
    $(id).textContent = player.wantPlay ? '⏸️' : '▶️';
    $(id).setAttribute('aria-label', player.wantPlay ? 'Пауза' : 'Воспроизвести');
  }
  for (const id of ['top-shuffle', 'bottom-shuffle']) {
    $(id).classList.toggle('active', player.queue.shuffle);
    $(id).setAttribute('aria-pressed', String(player.queue.shuffle));
  }
  for (const id of ['top-repeat', 'bottom-repeat']) {
    $(id).classList.toggle('active', player.repeat);
    $(id).setAttribute('aria-pressed', String(player.repeat));
  }
  for (const id of ['next', 'bottom-next']) $(id).disabled = !player.queue.nextTrack;
  for (const id of ['prev', 'bottom-prev']) $(id).disabled = !track;
  if (player.status === 'error') setStatus(player.error, () => player.retry());
  else if (player.status === 'blocked') setStatus(player.error);
  else if (player.status === 'loading') setStatus('Загрузка трека…');
  else if (player.status === 'ended') setStatus('Плейлист закончился.');
  else setStatus('');
  highlight(); syncMediaSession(); updateProgress();
}
function updateProgress() {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const position = Math.max(0, Math.min(audio.currentTime || 0, duration));
  for (const id of ['seekbar', 'bp-seek']) {
    const slider = $(id); slider.disabled = !duration; slider.max = duration || 1;
    if (!seekDragging.has(id)) slider.value = position;
    slider.setAttribute('aria-valuetext', `${time(position)} из ${time(duration)}`);
  }
  $('current-time').textContent = time(position); $('bp-time-left').textContent = time(position);
  $('bp-time-right').textContent = `-${time(Math.max(0, duration - position))}`;
  if ('mediaSession' in navigator && duration) {
    try { navigator.mediaSession.setPositionState?.({ duration, position, playbackRate: audio.playbackRate || 1 }); } catch {}
  }
}
function syncMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    const track = player.track;
    if (track && metadataId !== track.name) {
      metadataId = track.name;
      navigator.mediaSession.metadata = new MediaMetadata({ title: track.title || '', artist: track.artist || '', album: track.album || '', artwork: track.cover ? [{ src: track.cover }] : [] });
    }
    navigator.mediaSession.playbackState = !track ? 'none' : audio.paused ? 'paused' : 'playing';
  } catch {}
}
function volumeChanged() {
  if (audio.volume > 0) lastVolume = audio.volume;
  const muted = audio.muted || audio.volume === 0;
  for (const id of ['volume', 'mobile-volume']) $(id).value = Math.round(audio.volume * 100);
  for (const id of ['volume-mute', 'mobile-volume-mute']) {
    $(id).textContent = muted ? '🔇' : '🔊';
    $(id).setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
    $(id).setAttribute('aria-pressed', String(muted));
  }
  $('mobile-volume-toggle').textContent = muted ? '🔇' : '🔊';
  $('volume-value').textContent = `${Math.round(audio.volume * 100)}%`;
  try { localStorage.setItem(storageKey, JSON.stringify({ volume: audio.volume, muted: audio.muted, lastVolume })); } catch {}
}
try {
  const settings = JSON.parse(localStorage.getItem(storageKey));
  if (settings && Number.isFinite(settings.volume)) {
    audio.volume = Math.max(0, Math.min(1, settings.volume)); audio.muted = settings.muted === true;
    if (Number.isFinite(settings.lastVolume) && settings.lastVolume > 0) lastVolume = Math.min(1, settings.lastVolume);
  }
} catch {}
for (const id of ['volume', 'mobile-volume']) $(id).addEventListener('input', event => {
  audio.volume = Number(event.target.value) / 100; audio.muted = false; volumeChanged();
});
for (const id of ['volume-mute', 'mobile-volume-mute']) $(id).onclick = () => {
  if (audio.muted || !audio.volume) { if (!audio.volume) audio.volume = lastVolume || 1; audio.muted = false; }
  else audio.muted = true;
  volumeChanged();
};
const volumePopup = $('mobile-volume-popup');
function closeVolume() { volumePopup.hidden = true; $('mobile-volume-toggle').setAttribute('aria-expanded', 'false'); }
$('mobile-volume-toggle').onclick = () => {
  volumePopup.hidden = !volumePopup.hidden;
  $('mobile-volume-toggle').setAttribute('aria-expanded', String(!volumePopup.hidden));
};
document.addEventListener('click', event => { if (!event.target.closest('.mobile-volume-control')) closeVolume(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !volumePopup.hidden) { closeVolume(); $('mobile-volume-toggle').focus(); }
  if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest('input,textarea,button,a,select,[contenteditable="true"],[role="button"]')) return;
  event.preventDefault(); togglePlayback();
});
for (const id of ['play-pause', 'bottom-play-pause']) $(id).onclick = togglePlayback;
for (const id of ['prev', 'bottom-prev']) $(id).onclick = () => player.previous();
for (const id of ['next', 'bottom-next']) $(id).onclick = () => player.next();
for (const id of ['top-shuffle', 'bottom-shuffle']) $(id).onclick = () => player.setShuffle(!player.queue.shuffle);
for (const id of ['top-repeat', 'bottom-repeat']) $(id).onclick = () => player.setRepeat(!player.repeat);
$('shuffle-above-tracks').onclick = () => {
  const playable = filtered.filter(track => track.url);
  if (playable.length) player.start(playable, playable[Math.floor(Math.random() * playable.length)].name, { shuffle: true });
};
$('search-input').addEventListener('input', renderTracks);
for (const id of ['seekbar', 'bp-seek']) {
  const slider = $(id);
  slider.addEventListener('input', () => { seekDragging.add(id); player.seek(slider.valueAsNumber); });
  slider.addEventListener('change', () => { seekDragging.delete(id); player.seek(slider.valueAsNumber); });
  slider.addEventListener('blur', () => seekDragging.delete(id));
}
player.addEventListener('state', renderPlayer); player.addEventListener('progress', updateProgress);
player.addEventListener('volume', volumeChanged);
if ('mediaSession' in navigator) {
  const actions = {
    play: () => { if (player.status === 'error') player.retry(); else if (player.track) player.play(); else togglePlayback(); },
    pause: () => player.pause(), previoustrack: () => player.previous(), nexttrack: () => player.next(),
    seekbackward: event => player.seek(audio.currentTime - (event.seekOffset || 10)),
    seekforward: event => player.seek(audio.currentTime + (event.seekOffset || 10)),
    seekto: event => { if (Number.isFinite(event.seekTime)) player.seek(event.seekTime); },
  };
  for (const [action, handler] of Object.entries(actions)) { try { navigator.mediaSession.setActionHandler(action, handler); } catch {} }
}
function panelSpace() {
  const panel = document.querySelector('.bottom-player');
  const height = getComputedStyle(panel).display === 'none' ? 0 : panel.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--audio-panel-height', `${Math.ceil(height)}px`);
}
new ResizeObserver(panelSpace).observe(document.querySelector('.bottom-player'));
window.addEventListener('resize', panelSpace);
volumeChanged(); renderPlayer(); panelSpace(); initialize();
