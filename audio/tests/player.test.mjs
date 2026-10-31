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
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), retryDelays: [] });
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
  const a = buffer.prepare(tracks[0]); await tick(); const b = buffer.prepare(tracks[1]); await tick();
  const response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  pending.get(tracks[1].url)(response()); await b;
  pending.get(tracks[0].url)(response()); await a;
  assert.equal(buffer.ready.id, 'b'); assert.equal(buffer.take('b'), 'blob:next'); buffer.cancel(); assert.deepEqual(revoked, []);
});
test('prefetch enforces its memory limit and a failure is non-fatal', async () => {
  const buffer = new NextTrackBuffer({ maxBytes: 2, fetcher: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }) });
  await buffer.prepare(tracks[0]); assert.equal(buffer.ready, null);
  const offline = new NextTrackBuffer({ retryDelays: [], fetcher: async () => { throw new Error('Offline'); } });
  await offline.prepare(tracks[0]); assert.equal(offline.ready, null);
});

test('editing upcoming tracks changes playback order and cannot remove the current track', async () => {
  const audio = new FakeAudio(), buffer = fakeBuffer(); let cancelled = 0, prepared = [];
  buffer.cancel = () => cancelled++; buffer.prepare = async track => { prepared.push(track.name); };
  const player = new AudioPlayer(audio, { buffer }); player.start(tracks, 'a'); await tick();
  audio.currentTime = 5; player.prepareNext();
  player.moveUpcoming(2, 0);
  assert.deepEqual(player.queue.upcoming.map(t => t.name), ['d', 'b', 'c']);
  assert.equal(prepared.at(-1), 'd');
  player.removeUpcoming(0);
  assert.deepEqual(player.queue.upcoming.map(t => t.name), ['b', 'c']);
  assert.equal(prepared.at(-1), 'b'); assert.equal(player.track.name, 'a');
  assert(cancelled >= 3); audio.dispatchEvent(new Event('ended')); assert.equal(player.track.name, 'b');
  player.setShuffle(true); assert(!player.queue.items.some(t => t.name === 'd'));
});

test('prefetch starts as soon as the current song plays, without waiting three seconds', async () => {
  const audio = new FakeAudio(), prepared = [], buffer = fakeBuffer();
  buffer.prepare = async track => prepared.push(track.name);
  const player = new AudioPlayer(audio, { buffer }); player.start(tracks, 'a'); await tick();
  assert.equal(audio.currentTime, 0); assert.deepEqual(prepared, ['b']);
});

test('prefetch retries temporary failures and retains the fully downloaded next song', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0; const log = [];
  const buffer = new NextTrackBuffer({ retryDelays: [10, 20], makeURL: () => 'blob:complete', report: (event, details) => log.push({ event, ...details }), fetcher: async () => {
    calls++; if (calls === 1) throw new TypeError('Failed to fetch');
    if (calls === 2) return new Response('', { status: 503 });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  const done = buffer.prepare(tracks[1]); await tick();
  t.mock.timers.tick(10); await tick(); t.mock.timers.tick(20); await done;
  assert.equal(calls, 3); assert.equal(buffer.take('b'), 'blob:complete');
  assert.equal(log.filter(x => x.event === 'prefetch-failed').length, 2);
  assert.equal(log.at(-1).bytes, 3);
});

test('cancelling prefetch during a retry delay prevents any further fetch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
  const buffer = new NextTrackBuffer({ retryDelays: [10, 20], fetcher: async () => { calls++; throw new Error('offline'); } });
  const done = buffer.prepare(tracks[1]); await tick(); buffer.cancel();
  t.mock.timers.tick(100); await done;
  assert.equal(calls, 1); assert.equal(buffer.ready, null);
});

test('prefetch timeout is recorded and retried only within its attempt limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0; const log = [];
  const buffer = new NextTrackBuffer({ timeoutMs: 40, retryDelays: [10], report: (event, details) => log.push({ event, ...details }), fetcher: (url, { signal }) => {
    calls++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true }));
  } });
  const done = buffer.prepare(tracks[1]); await tick(); t.mock.timers.tick(40); await tick();
  t.mock.timers.tick(10); await tick(); t.mock.timers.tick(40); await done;
  assert.equal(calls, 2); assert.equal(buffer.ready, null);
  assert(log.filter(x => x.event === 'prefetch-failed').every(x => x.timedOut));
});

test('failed background transition retries the same song and keeps queue position', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), originalPlay = audio.play.bind(audio); let fail = true;
  audio.play = () => { if (audio.src === tracks[1].url && fail) { fail = false; return Promise.reject(new TypeError('network')); } return originalPlay(); };
  const player = new AudioPlayer(audio, { buffer: fakeBuffer(), retryDelays: [10] });
  player.start(tracks, 'a'); await tick(); audio.dispatchEvent(new Event('ended')); await tick();
  assert.equal(player.status, 'recovering'); assert.equal(player.track.name, 'b');
  t.mock.timers.tick(10); await tick();
  assert.equal(player.status, 'playing'); assert.equal(player.queue.current.name, 'b'); assert.equal(player.queue.nextTrack.name, 'c');
});

test('automatic retries are bounded and do not skip the failed song', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(); audio.play = () => { audio.playCalls++; return Promise.reject(new Error('offline')); };
  const player = new AudioPlayer(audio, { buffer: fakeBuffer(), retryDelays: [10, 20, 30] });
  player.start(tracks, 'a'); await tick();
  for (const delay of [10, 20, 30]) { t.mock.timers.tick(delay); await tick(); }
  assert.equal(audio.playCalls, 4); assert.equal(player.status, 'error'); assert.equal(player.wantPlay, false);
  assert.equal(player.track.name, 'a'); t.mock.timers.tick(10000); await tick(); assert.equal(audio.playCalls, 4);
});

test('manual pause cancels automatic recovery and a late failure cannot resume it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(); audio.play = () => { audio.playCalls++; return Promise.reject(new Error('offline')); };
  const player = new AudioPlayer(audio, { buffer: fakeBuffer(), retryDelays: [10] });
  player.start(tracks, 'a'); await tick(); assert.equal(player.status, 'recovering');
  player.pause(); const calls = audio.playCalls; t.mock.timers.tick(100); await tick();
  assert.equal(audio.playCalls, calls); assert.equal(player.status, 'paused'); assert.equal(player.wantPlay, false);
});

test('switching songs cancels recovery of the previous song', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), originalPlay = audio.play.bind(audio);
  audio.play = () => audio.src === tracks[0].url ? Promise.reject(new Error('offline')) : originalPlay();
  const player = new AudioPlayer(audio, { buffer: fakeBuffer(), retryDelays: [10] });
  player.start(tracks, 'a'); await tick(); player.next(); await tick(); const calls = audio.playCalls;
  t.mock.timers.tick(100); await tick(); assert.equal(player.track.name, 'b'); assert.equal(audio.playCalls, calls);
});

test('autoplay denial requests user interaction instead of retrying forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const log = [];
  const audio = new FakeAudio(); audio.play = () => { audio.playCalls++; return Promise.reject(new DOMException('User gesture required', 'NotAllowedError')); };
  const player = new AudioPlayer(audio, { buffer: fakeBuffer(), retryDelays: [10], report: (event, details) => log.push({ event, ...details }) });
  player.start(tracks, 'a'); await tick(); t.mock.timers.tick(100); await tick();
  assert.equal(player.status, 'blocked'); assert.equal(audio.playCalls, 1);
  assert(log.some(x => x.event === 'play-blocked' && x.errorName === 'NotAllowedError'));
});

test('retrying a network error preserves the position within the same song', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const audio = new FakeAudio();
  const player = new AudioPlayer(audio, { buffer: fakeBuffer(), retryDelays: [10] });
  player.start(tracks, 'a'); await tick(); audio.currentTime = 35; audio.error = { code: 2, message: 'network error' }; audio.dispatchEvent(new Event('error'));
  t.mock.timers.tick(10); audio.dispatchEvent(new Event('loadedmetadata')); await tick();
  assert.equal(player.track.name, 'a'); assert.equal(audio.currentTime, 35); assert.equal(player.status, 'playing');
});

test('diagnostic report is bounded and strips shared URLs from errors', async () => {
  const { recordAudioEvent, audioReport, errorDetails } = await import('../js/diagnostics.mjs');
  const details = errorDetails(new Error('Failed https://www.dropbox.com/s/token?rlkey=secret'));
  assert(!details.errorMessage.includes('secret')); assert(details.errorMessage.includes('[URL]'));
  for (let i = 0; i < 250; i++) recordAudioEvent('bounded-test', { index: i });
  const report = audioReport(); assert.equal(report.events.length, 240); assert.equal(report.events.at(-1).index, 249);
});

test('default prefetch calls browser fetch with its global receiver', async t => {
  t.mock.method(globalThis, 'fetch', function () {
    assert.equal(this, globalThis, 'native fetch requires its Window receiver');
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }));
  });
  const buffer = new NextTrackBuffer({ retryDelays: [], makeURL: () => 'blob:browser-fetch' });
  assert.equal(await buffer.prepare(tracks[1]), true); assert.equal(buffer.take('b'), 'blob:browser-fetch');
});
import { AudioFileCache } from '../js/audio-cache.mjs';
import { PlaybackBuffer } from '../js/reserve.mjs';

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async match(key) { const r = this.entries.get(String(key)); return r ? new Response(r.bytes, { status: r.status, headers: r.headers }) : undefined; }
  async put(key, response) { const bytes = new Uint8Array(await response.arrayBuffer()); this.entries.set(String(key), { bytes, status: response.status, headers: [...response.headers] }); }
  async delete(key) { return this.entries.delete(String(key)); }
}
const audioResponse = (size = 3) => new Response(new Uint8Array(size), { headers: { 'content-type': 'audio/mpeg', 'content-length': String(size) } });
const noCache = { get: async () => null, open: async () => null };
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

test('full audio files persist across cache instances without refetching', async () => {
  const disk = new MemoryCache(), storage = { open: async () => disk };
  const cache = new AudioFileCache({ storage }); const log = []; let calls = 0;
  const buffer = new NextTrackBuffer({ cache, memoryBytes: 2, maxBytes: 20, retryDelays: [], makeURL: b => `blob:${b.size}`, report: (event, details) => log.push({ event, ...details }), fetcher: async () => { calls++; return audioResponse(12); } });
  assert.equal(await buffer.prepare(tracks[1]), true); assert.equal(buffer.take('b'), 'blob:12');
  const restored = new NextTrackBuffer({ cache: new AudioFileCache({ storage }), retryDelays: [], makeURL: b => `blob:${b.size}`, fetcher: async () => { throw new Error('must not fetch cached file'); } });
  assert.equal(await restored.prepare(tracks[1]), true); assert.equal(restored.take('b'), 'blob:12'); assert.equal(calls, 1);
});

test('cache byte budget removes the oldest audio files while keeping newer ones', async () => {
  const disk = new MemoryCache(), cache = new AudioFileCache({ storage: { open: async () => disk }, maxBytes: 6 });
  for (const track of tracks.slice(0, 3)) await cache.put(track, audioResponse(3), { maxBytes: 10 });
  assert.equal(await cache.get(tracks[0]), null);
  assert.equal((await cache.get(tracks[1])).size, 3); assert.equal((await cache.get(tracks[2])).size, 3);
});

test('partial or truncated responses never become cached playable files', async () => {
  const disk = new MemoryCache(), cache = new AudioFileCache({ storage: { open: async () => disk } });
  const response = new Response(new Uint8Array(3), { headers: { 'content-type': 'audio/mpeg', 'content-length': '12' } });
  await assert.rejects(cache.put(tracks[1], response, { maxBytes: 20 }), /Incomplete/);
  assert.equal(await cache.get(tracks[1]), null);
});

test('unavailable persistent storage still supports small in-memory tracks', async () => {
  const cache = new AudioFileCache({ storage: { open: async () => { throw new DOMException('disabled', 'SecurityError'); } } });
  const buffer = new NextTrackBuffer({ cache, retryDelays: [], makeURL: () => 'blob:fallback', fetcher: async () => audioResponse(3) });
  assert.equal(await buffer.prepare(tracks[1]), true); assert.equal(buffer.take('b'), 'blob:fallback');
});

test('reserve downloads five future tracks with at most two concurrent requests', async () => {
  const many = ['a','b','c','d','e','f','g'].map(name => ({ name, url: `https://example.invalid/${name}` }));
  let running = 0, peak = 0, calls = 0;
  const reserve = new PlaybackBuffer({ cache: noCache, createBuffer: options => new NextTrackBuffer({ ...options, retryDelays: [], makeURL: () => 'blob:ready', fetcher: async () => {
    calls++; running++; peak = Math.max(peak, running); await tick(); running--; return audioResponse();
  } }) });
  reserve.prepareQueue(many); await settle();
  assert.equal(reserve.state.ready, 5); assert.equal(calls, 5); assert(peak <= 2); reserve.cancel();
});

test('moving or consuming a reserved track preserves the other prepared files', async () => {
  let calls = 0; const revoked = [];
  const reserve = new PlaybackBuffer({ cache: noCache, createBuffer: options => new NextTrackBuffer({ ...options, retryDelays: [], makeURL: () => `blob:${++calls}`, revokeURL: url => revoked.push(url), fetcher: async () => audioResponse() }) });
  reserve.prepareQueue(tracks.slice(1)); await settle(); assert.equal(reserve.state.ready, 3);
  reserve.prepareQueue([tracks[3], tracks[1], tracks[2]]); await settle(); assert.equal(calls, 3); assert.equal(revoked.length, 0);
  const url = reserve.take('d'); assert(url.startsWith('blob:'));
  reserve.prepareQueue(tracks.slice(1, 3)); await settle(); assert.equal(reserve.state.ready, 2); assert.equal(calls, 3); assert(!revoked.includes(url)); reserve.cancel();
});

test('temporary reserve failures are retried after the initial attempts run out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); let calls = 0;
  const reserve = new PlaybackBuffer({ cache: noCache, retryMs: 30, createBuffer: options => new NextTrackBuffer({ ...options, retryDelays: [], makeURL: () => 'blob:retry', fetcher: async () => {
    calls++; if (calls === 1) throw new Error('offline'); return audioResponse();
  } }) });
  reserve.prepareQueue([tracks[1]]); await settle(); assert.equal(reserve.state.ready, 0);
  t.mock.timers.tick(30); await settle(); assert.equal(calls, 2); assert.equal(reserve.state.ready, 1); reserve.cancel();
});

test('manual pause stops reserve retries without discarding prepared files', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); let calls = 0;
  const reserve = new PlaybackBuffer({ cache: noCache, retryMs: 30, createBuffer: options => new NextTrackBuffer({ ...options, retryDelays: [], makeURL: () => 'blob:good', fetcher: async url => {
    calls++; if (url === tracks[2].url) throw new Error('offline'); return audioResponse();
  } }) });
  reserve.prepareQueue(tracks.slice(1, 3)); await settle(); reserve.suspend(); const before = calls;
  t.mock.timers.tick(300); await settle(); assert.equal(calls, before); assert.equal(reserve.state.ready, 1);
  reserve.prepareQueue([tracks[1]]); await settle(); assert.equal(reserve.state.ready, 1); reserve.cancel();
});

test('reserve limits the total bytes retained as object URLs', async () => {
  const reserve = new PlaybackBuffer({ cache: noCache, maxReadyBytes: 5, createBuffer: options => new NextTrackBuffer({ ...options, retryDelays: [], makeURL: () => 'blob:limit', revokeURL: () => {}, fetcher: async () => audioResponse(3) }) });
  reserve.prepareQueue(tracks.slice(1)); await settle(); assert(reserve.state.bytes <= 5); assert.equal(reserve.state.ready, 1); reserve.cancel();
});

test('startup watchdog recovers a request that never reports playing or error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const audio = new FakeAudio(); audio.play = () => new Promise(() => {});
  const player = new AudioPlayer(audio, { buffer: fakeBuffer(), startupTimeoutMs: 10, retryDelays: [20] });
  player.start(tracks, 'a'); t.mock.timers.tick(10); await tick();
  assert.equal(player.status, 'recovering'); assert.equal(player.track.name, 'a'); player.pause();
});

test('a late disk-cache lookup cannot resume playback after manual pause', async () => {
  const audio = new FakeAudio(), revoked = []; audio.play = () => new Promise(() => {});
  let resolveCache; const buffer = fakeBuffer(); buffer.restore = () => new Promise(resolve => { resolveCache = resolve; });
  const player = new AudioPlayer(audio, { buffer, revokeURL: url => revoked.push(url) });
  player.start(tracks, 'a'); player.pause(); resolveCache('blob:late'); await tick();
  assert.equal(player.wantPlay, false); assert.notEqual(audio.src, 'blob:late'); assert.deepEqual(revoked, ['blob:late']);
});

test('a full cache keeps existing files readable and falls back to memory for new small songs', async () => {
  const disk = new MemoryCache(), cache = new AudioFileCache({ storage: { open: async () => disk } });
  await cache.put(tracks[0], audioResponse(), { maxBytes: 20 });
  disk.put = async () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
  await assert.rejects(cache.put(tracks[1], audioResponse(), { maxBytes: 20 }), { name: 'QuotaExceededError' });
  assert.equal((await cache.get(tracks[0])).size, 3); assert.equal(await cache.writable(), false);
  const buffer = new NextTrackBuffer({ cache, retryDelays: [], makeURL: () => 'blob:memory', fetcher: async () => audioResponse() });
  assert.equal(await buffer.prepare(tracks[1]), true); assert.equal(buffer.take('b'), 'blob:memory');
});

test('a reserve download finishing during a failed transition immediately rescues the same song', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), originalPlay = audio.play.bind(audio), buffer = fakeBuffer(); let ready = null;
  buffer.prepareQueue = () => {};
  buffer.take = id => { if (id !== ready) return null; ready = null; buffer.onChange(); return 'blob:late-reserve'; };
  audio.play = () => audio.src === tracks[1].url ? Promise.reject(new Error('offline')) : originalPlay();
  const player = new AudioPlayer(audio, { buffer, retryDelays: [30] });
  player.start(tracks, 'a'); await tick(); player.next(); await tick();
  assert.equal(player.status, 'recovering');
  ready = 'b'; buffer.onChange(); await tick();
  assert.equal(audio.src, 'blob:late-reserve'); assert.equal(player.status, 'playing'); assert.equal(player.queue.current.name, 'b');
  const calls = audio.playCalls; t.mock.timers.tick(100); await tick(); assert.equal(audio.playCalls, calls);
  player.pause();
});

test('each playback retry can restore a file that became available in the persistent cache', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), originalPlay = audio.play.bind(audio), buffer = fakeBuffer(); let cached = false;
  buffer.restore = async () => cached ? 'blob:newly-cached' : null;
  audio.play = () => audio.src.startsWith('blob:') ? originalPlay() : Promise.reject(new Error('offline'));
  const player = new AudioPlayer(audio, { buffer, retryDelays: [30] });
  player.start(tracks, 'a'); await tick(); assert.equal(player.status, 'recovering');
  cached = true; t.mock.timers.tick(30); await tick();
  assert.equal(audio.src, 'blob:newly-cached'); assert.equal(player.status, 'playing'); assert.equal(player.track.name, 'a');
  player.pause();
});

for (const position of [.070251, 56.304582]) test(`hidden native pause at ${position}s resumes the same file without changing the queue`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), log = [], buffer = fakeBuffer(); let suspended = 0;
  buffer.suspend = () => suspended++;
  buffer.take = id => id === 'b' ? 'blob:complete-b' : null;
  const player = new AudioPlayer(audio, { buffer, isHidden: () => true, pauseRecoveryDelays: [30], report: (event, details) => log.push({ event, ...details }) });
  player.start(tracks, 'a'); await tick(); audio.dispatchEvent(new Event('ended')); await tick();
  audio.currentTime = position; const calls = audio.playCalls; audio.pause();
  assert.equal(player.status, 'interrupted'); assert.equal(player.wantPlay, true); assert(suspended > 0);
  t.mock.timers.tick(30); await tick();
  assert.equal(audio.playCalls, calls + 1); assert.equal(player.status, 'playing'); assert.equal(audio.currentTime, position);
  assert.equal(audio.src, 'blob:complete-b'); assert.equal(player.queue.current.name, 'b'); assert.equal(player.queue.nextTrack.name, 'c');
  assert(log.some(x => x.event === 'audio-interrupted' && x.paused && x.wantPlay)); player.pause();
});

test('manual pause including lock-screen pause cancels pending background recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const origin of ['page', 'media-session', 'media-session-stop']) {
    const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), isHidden: () => true, pauseRecoveryDelays: [30] });
    player.start(tracks, 'a'); await tick(); audio.pause();
    player.pause(origin); const calls = audio.playCalls;
    t.mock.timers.tick(1000); player.recover(); await tick();
    assert.equal(audio.playCalls, calls); assert.equal(player.wantPlay, false); assert.equal(player.status, 'paused');
  }
});

test('a delayed pause event from an old source never pauses an already playing new source', async () => {
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), isHidden: () => true });
  player.start(tracks, 'a'); await tick(); player.next(); await tick();
  const calls = audio.playCalls; audio.dispatchEvent(new Event('pause'));
  assert.equal(audio.paused, false); assert.equal(player.wantPlay, true); assert.equal(player.status, 'playing');
  assert.equal(player.pauseRecoveryTimer, null); assert.equal(audio.playCalls, calls); player.pause();
});

test('persistent external suspension is bounded and visibility can recover it without reloading the song', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let hidden = true;
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), isHidden: () => hidden, pauseRecoveryDelays: [10, 20] });
  player.start(tracks, 'a'); await tick(); audio.currentTime = 56;
  for (const delay of [10, 20]) { audio.pause(); t.mock.timers.tick(delay); await tick(); }
  audio.pause(); const calls = audio.playCalls;
  t.mock.timers.tick(100000); player.recover(); await tick();
  assert.equal(audio.playCalls, calls); assert.equal(player.status, 'interrupted'); assert.equal(player.wantPlay, true);
  hidden = false; player.recover(); await tick();
  assert.equal(player.status, 'playing'); assert.equal(audio.playCalls, calls + 1); assert.equal(audio.currentTime, 56); player.pause();
});

test('changing track during a pending pause recovery cannot resume the old track', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), isHidden: () => true, pauseRecoveryDelays: [30] });
  player.start(tracks, 'a'); await tick(); audio.pause(); player.next(); await tick(); const calls = audio.playCalls;
  t.mock.timers.tick(100); await tick();
  assert.equal(player.track.name, 'b'); assert.equal(audio.playCalls, calls); assert.equal(player.pauseRecoveryCount, 0); player.pause();
});

test('repeated native pause events do not consume recovery attempts or delay the pending attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), isHidden: () => true, pauseRecoveryDelays: [30] });
  player.start(tracks, 'a'); await tick(); audio.pause(); t.mock.timers.tick(20); audio.pause();
  assert.equal(player.pauseRecoveryCount, 0); t.mock.timers.tick(10); await tick();
  assert.equal(player.pauseRecoveryCount, 1); assert.equal(player.status, 'playing'); player.pause();
});

test('a foreground native pause remains paused and recovery never resumes it', async () => {
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), isHidden: () => false });
  player.start(tracks, 'a'); await tick(); audio.pause(); const calls = audio.playCalls; player.recover(); await tick();
  assert.equal(audio.playCalls, calls); assert.equal(player.wantPlay, false); assert.equal(player.status, 'paused');
});

test('background recovery handles an autoplay denial without a retry loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), isHidden: () => true, pauseRecoveryDelays: [30] });
  player.start(tracks, 'a'); await tick(); audio.pause();
  audio.play = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
  t.mock.timers.tick(30); await tick();
  assert.equal(player.status, 'blocked'); assert.equal(player.wantPlay, false); assert.equal(player.pauseRecoveryTimer, null);
});

test('stable playback replenishes the interruption budget while manual pause always wins', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new FakeAudio(), player = new AudioPlayer(audio, { buffer: fakeBuffer(), isHidden: () => true, pauseRecoveryDelays: [30] });
  player.start(tracks, 'a'); await tick(); audio.pause(); t.mock.timers.tick(30); await tick();
  assert.equal(player.pauseRecoveryCount, 1); audio.currentTime = 31; audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(player.pauseRecoveryCount, 0); audio.pause(); player.pause(); const calls = audio.playCalls;
  t.mock.timers.tick(100); await tick(); assert.equal(audio.playCalls, calls); assert.equal(player.status, 'paused');
});
