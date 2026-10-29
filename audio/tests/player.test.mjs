import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackQueue } from '../js/queue.mjs';
import { AudioPlayer } from '../js/player.mjs';
import { NextTrackBuffer, directURL } from '../js/prefetch.mjs';

const tracks = ['a', 'b', 'c', 'd'].map(name => ({ name, title: name, artist: 'Test', url: `https://example.invalid/${name}.mp3` }));
const tick = () => new Promise(resolve => setImmediate(resolve));
class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 200; this.readyState = 4; this.loop = false; this.src = ''; this.playCalls = 0; this.error = null; }
  load() { this.error = null; this.currentTime = 0; }
  play() { this.playCalls++; this.paused = false; queueMicrotask(() => this.dispatchEvent(new Event('playing'))); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}
const fakeBuffer = () => ({ cancel() {}, take() { return null; }, prepare() { return Promise.resolve(); } });
test('shuffle starts from the selected track and visits every other track exactly once', () => {
  const queue = new TrackQueue(() => .75);
  queue.set(tracks, 'd'); queue.setShuffle(true);
  const visited = [queue.current.name]; while (queue.next()) visited.push(queue.current.name);
  assert.equal(visited[0], 'd'); assert.deepEqual([...visited].sort(), ['a', 'b', 'c', 'd']); assert.equal(queue.nextTrack, null);
});
test('disabling shuffle restores canonical order without changing the current track', () => {
  const queue = new TrackQueue(); queue.shuffle = true; queue.set(tracks, 'b'); queue.setShuffle(false);
  assert.equal(queue.current.name, 'b'); assert.equal(queue.nextTrack.name, 'c');
});
test('changing shuffle or repeat while paused never resumes playback', async () => {
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer() });
  player.start(tracks, 'a'); await tick(); player.pause();
  const calls = audio.playCalls;
  player.setShuffle(true); player.setRepeat(true); player.setRepeat(false);
  assert.equal(audio.paused, true); assert.equal(audio.playCalls, calls); assert.equal(player.status, 'paused');
});
test('seeking on pause leaves the player paused', async () => {
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer() });
  player.start(tracks, 'a'); await tick(); player.pause(); player.seek(50);
  audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(audio.currentTime, 50); assert.equal(player.wantPlay, false); assert.equal(player.status, 'paused');
});
test('ended requests the next track immediately on the same audio element without document visibility', async () => {
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer() });
  player.start(tracks, 'a'); await tick(); const calls = audio.playCalls;
  audio.dispatchEvent(new Event('ended'));
  assert.equal(player.track.name, 'b'); assert.equal(player.audio, audio); assert.equal(audio.playCalls, calls + 1);
  await tick(); assert.equal(player.status, 'playing');
});
test('a buffered next track is used without starting a new network audio URL', async () => {
  const audio = new FakeAudio(); const buffer = fakeBuffer(); buffer.take = id => id === 'b' ? 'blob:prepared-b' : null;
  const player = new AudioPlayer(audio, { buffer }); player.start(tracks, 'a'); await tick();
  audio.dispatchEvent(new Event('ended')); assert.equal(audio.src, 'blob:prepared-b');
});
test('repeat does not advance the queue and end of queue stops cleanly', async () => {
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer() });
  player.start(tracks, 'd'); await tick(); player.setRepeat(true); audio.dispatchEvent(new Event('ended'));
  assert.equal(player.track.name, 'd'); player.setRepeat(false); audio.dispatchEvent(new Event('ended'));
  assert.equal(player.status, 'ended'); assert.equal(player.wantPlay, false);
});
test('direct Dropbox links retain access parameters and other hosts stay unchanged', () => {
  const url = new URL(directURL('https://www.dropbox.com/scl/fi/token/song.mp3?rlkey=key&raw=1'));
  assert.equal(url.hostname, 'dl.dropboxusercontent.com'); assert.equal(url.searchParams.get('rlkey'), 'key');
  assert.equal(directURL(tracks[0].url), tracks[0].url);
});
test('failed direct source falls back once to original URL, then shows an actionable error', async () => {
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer() });
  player.start([{ ...tracks[0], url: 'https://www.dropbox.com/scl/fi/token/a.mp3?rlkey=key' }], 'a'); await tick();
  audio.error = { code: 4 }; audio.dispatchEvent(new Event('error'));
  assert(audio.src.startsWith('https://www.dropbox.com/')); await tick();
  audio.error = { code: 4 }; audio.dispatchEvent(new Event('error'));
  assert.equal(player.status, 'error'); assert.equal(player.wantPlay, false); assert(player.error.includes('Не удалось'));
});
test('a late failed play promise from the previous song cannot break the current song', async () => {
  const audio = new FakeAudio(); let rejectFirst;
  audio.play = () => { audio.playCalls++; return audio.playCalls === 1 ? new Promise((resolve, reject) => { rejectFirst = reject; }) : Promise.resolve(); };
  const player = new AudioPlayer(audio, { buffer: fakeBuffer() }); player.start(tracks, 'a'); player.next();
  rejectFirst(new Error('Late failure')); await tick(); assert.equal(player.track.name, 'b'); assert.notEqual(player.status, 'error');
});
test('cancelled prefetch cannot overwrite a newer next track, and take transfers ownership', async () => {
  const pending = new Map(), revoked = [];
  const buffer = new NextTrackBuffer({ fetcher: url => new Promise(resolve => pending.set(url, resolve)), makeURL: () => 'blob:next', revokeURL: url => revoked.push(url) });
  const a = buffer.prepare(tracks[0]); const b = buffer.prepare(tracks[1]);
  const response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  pending.get(tracks[1].url)(response()); await b;
  pending.get(tracks[0].url)(response()); await a;
  assert.equal(buffer.ready.id, 'b'); assert.equal(buffer.take('b'), 'blob:next'); buffer.cancel(); assert.deepEqual(revoked, []);
});
test('prefetch enforces its memory limit and a failure is non-fatal', async () => {
  const buffer = new NextTrackBuffer({ maxBytes: 2, fetcher: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }) });
  await buffer.prepare(tracks[0]); assert.equal(buffer.ready, null);
  const offline = new NextTrackBuffer({ fetcher: async () => { throw new Error('Offline'); } });
  await offline.prepare(tracks[0]); assert.equal(offline.ready, null);
});
