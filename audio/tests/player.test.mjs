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
  const a = buffer.prepare(tracks[0]); const b = buffer.prepare(tracks[1]);
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
  const done = buffer.prepare(tracks[1]); t.mock.timers.tick(40); await tick();
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
  for (let i = 0; i < 130; i++) recordAudioEvent('bounded-test', { index: i });
  const report = audioReport(); assert.equal(report.events.length, 120); assert.equal(report.events.at(-1).index, 129);
});

test('default prefetch calls browser fetch with its global receiver', async t => {
  t.mock.method(globalThis, 'fetch', function () {
    assert.equal(this, globalThis, 'native fetch requires its Window receiver');
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }));
  });
  const buffer = new NextTrackBuffer({ retryDelays: [], makeURL: () => 'blob:browser-fetch' });
  assert.equal(await buffer.prepare(tracks[1]), true); assert.equal(buffer.take('b'), 'blob:browser-fetch');
});
