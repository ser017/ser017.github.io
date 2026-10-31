import { recordAudioEvent, errorDetails } from './diagnostics.mjs';
import { TrackQueue } from './queue.mjs';
import { NextTrackBuffer, directURL } from './prefetch.mjs';

export class AudioPlayer extends EventTarget {
  constructor(audio, { queue = new TrackQueue(), buffer = new NextTrackBuffer(), revokeURL = url => URL.revokeObjectURL(url), retryDelays = [1000, 3000, 7000], report = recordAudioEvent } = {}) {
    super();
    Object.assign(this, { audio, queue, buffer, revokeURL, retryDelays, report });
    this.track = null; this.status = 'idle'; this.wantPlay = false; this.repeat = false;
    this.request = 0; this.activeBlob = null; this.candidates = []; this.sourceIndex = 0;
    this.error = ''; this.prefetchFor = null;
    this.retryTimer = null; this.retryCount = 0; this.resumeAt = 0;
    audio.autoplay = false;
    audio.addEventListener('playing', () => {
      if (!this.wantPlay) { audio.pause(); return; }
      this.status = 'playing'; this.error = ''; this.log('playing'); this.notify(); this.prepareNext();
    });
    audio.addEventListener('pause', () => {
      if (['loading', 'recovering'].includes(this.status) && this.wantPlay) return;
      if (audio.ended || this.status === 'error') return;
      this.wantPlay = false; this.clearRetry(); this.request++; this.status = this.track ? 'paused' : 'idle'; this.log('audio-pause'); this.notify();
    });
    audio.addEventListener('waiting', () => {
      if (this.wantPlay) { this.status = 'loading'; this.notify(); }
    });
    audio.addEventListener('timeupdate', () => {
      this.dispatchEvent(new Event('progress'));
      if (this.wantPlay && !audio.paused && audio.readyState >= 3) this.prepareNext();
    });
    audio.addEventListener('loadedmetadata', () => {
      if (this.resumeAt && Number.isFinite(audio.duration)) audio.currentTime = Math.min(this.resumeAt, Math.max(0, audio.duration - .1));
      this.resumeAt = 0;
      this.dispatchEvent(new Event('progress'));
    });
    audio.addEventListener('volumechange', () => this.dispatchEvent(new Event('volume')));
    audio.addEventListener('error', () => { if (audio.error) this.sourceFailed(audio.error); });
    audio.addEventListener('ended', () => {
      if (this.repeat || !this.wantPlay) return;
      this.clearRetry(); this.log('ended');
      const next = this.queue.next();
      // Один и тот же audio-элемент и немедленный play(), независимо от visibilityState.
      if (next) this.select(next, true);
      else { this.wantPlay = false; this.status = 'ended'; this.buffer.cancel(); this.notify(); }
    });
  }
  log(event, details = {}) {
    this.report(event, { track: this.track?.name || null, status: this.status, wantPlay: this.wantPlay,
      source: this.audio.src?.startsWith('blob:') ? 'buffered' : this.audio.src === directURL(this.track?.url || 'https://invalid.local') ? 'direct' : 'original',
      sourceIndex: this.sourceIndex, retry: this.retryCount, currentTime: this.audio.currentTime || 0,
      readyState: this.audio.readyState, networkState: this.audio.networkState, ...details });
  }
  clearRetry() { if (this.retryTimer !== null) clearTimeout(this.retryTimer); this.retryTimer = null; }
  notify() { this.dispatchEvent(new Event('state')); }
  start(tracks, id, { shuffle = this.queue.shuffle } = {}) {
    const playable = tracks.filter(track => track.url);
    if (!playable.length) return;
    this.queue.shuffle = shuffle;
    this.queue.set(playable, id);
    this.select(this.queue.current, true);
  }
  select(track, autoplay) {
    if (!track?.url) return;
    this.clearRetry(); this.retryCount = 0; this.resumeAt = 0;
    const prepared = this.buffer.take(track.name);
    this.buffer.cancel(); this.prefetchFor = null;
    const previousBlob = this.activeBlob;
    this.activeBlob = prepared;
    this.track = track; this.wantPlay = autoplay; this.status = autoplay ? 'loading' : 'paused'; this.error = '';
    this.request++;
    this.candidates = [...new Set([prepared, directURL(track.url), track.url].filter(Boolean))];
    this.sourceIndex = 0;
    this.audio.src = this.candidates[0]; this.audio.loop = this.repeat; this.audio.load();
    if (previousBlob && previousBlob !== prepared) this.revokeURL(previousBlob);
    this.log('select', { buffered: Boolean(prepared) }); this.notify();
    if (autoplay) this.play();
  }
  play() {
    if (!this.track) return;
    if (this.status === 'error' || this.audio.error) { this.retry(); return; }
    this.clearRetry();
    this.wantPlay = true; this.error = ''; this.status = 'loading'; this.notify();
    const token = this.request;
    const failed = error => {
      if (token !== this.request || !this.wantPlay || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        this.wantPlay = false; this.clearRetry(); this.status = 'blocked';
        this.error = 'Нажмите ▶, чтобы продолжить воспроизведение.';
        this.log('play-blocked', errorDetails(error)); this.notify();
      } else this.sourceFailed(error);
    };
    try { Promise.resolve(this.audio.play()).catch(failed); }
    catch (error) { failed(error); }
  }
  pause() {
    this.wantPlay = false; this.clearRetry(); this.request++; this.audio.pause();
    this.status = this.track ? 'paused' : 'idle'; this.log('user-pause'); this.notify();
  }
  toggle() { if (this.wantPlay) this.pause(); else if (this.status === 'error') this.retry(); else this.play(); }
  retry() { if (this.track) this.select(this.track, true); }
  next() { const track = this.queue.next(); if (track) this.select(track, true); }
  previous() {
    if (!this.track) return;
    if (this.audio.currentTime > 3) { this.seek(0); return; }
    const track = this.queue.previous(); if (track) this.select(track, true);
  }
  seek(value) {
    if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) return;
    this.audio.currentTime = Math.max(0, Math.min(value, this.audio.duration));
    this.dispatchEvent(new Event('progress'));
  }
  setShuffle(value) {
    this.queue.setShuffle(value); this.buffer.cancel(); this.prefetchFor = null;
    if (this.wantPlay && !this.audio.paused) this.prepareNext();
    this.notify();
  }
  setRepeat(value) {
    this.repeat = Boolean(value); this.audio.loop = this.repeat;
    this.buffer.cancel(); this.prefetchFor = null;
    if (!this.repeat && this.wantPlay && !this.audio.paused) this.prepareNext();
    this.notify();
  }
  updateQueue(action, ...args) {
    if (!this.queue[action](...args)) return;
    this.buffer.cancel(); this.prefetchFor = null;
    if (!this.repeat && this.wantPlay && !this.audio.paused) this.prepareNext();
    this.notify();
  }
  removeUpcoming(index) { this.updateQueue('removeUpcoming', index); }
  moveUpcoming(from, to) { this.updateQueue('moveUpcoming', from, to); }
  prepareNext() {
    const next = this.repeat ? null : this.queue.nextTrack;
    if (!next || this.prefetchFor === next.name) return;
    this.prefetchFor = next.name;
    void this.buffer.prepare(next);
  }
  sourceFailed(error) {
    if (!this.track || this.status === 'error' || this.retryTimer !== null) return;
    this.log('source-failed', errorDetails(error));
    this.resumeAt = Math.max(this.resumeAt, this.audio.currentTime || 0);
    if (this.sourceIndex + 1 < this.candidates.length) {
      this.loadCandidate(this.sourceIndex + 1);
      return;
    }
    if (this.wantPlay && this.retryCount < this.retryDelays.length) {
      const delay = this.retryDelays[this.retryCount++];
      const token = ++this.request;
      this.status = 'recovering'; this.error = '';
      this.log('retry-scheduled', { delayMs: delay });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (token !== this.request || !this.wantPlay) return;
        // Keep the same track and queue position; retry the network sources.
        this.candidates = [...new Set([directURL(this.track.url), this.track.url])];
        this.log('retry-start'); this.loadCandidate(0);
      }, delay);
      this.notify(); return;
    }
    this.wantPlay = false; this.request++; this.audio.pause(); this.status = 'error';
    this.error = 'Не удалось загрузить трек. Проверьте соединение и попробуйте ещё раз.';
    this.log('playback-error'); this.notify();
  }
  loadCandidate(index) {
    this.sourceIndex = index; this.request++;
    this.status = this.wantPlay ? 'loading' : 'paused';
    this.audio.src = this.candidates[index]; this.audio.load();
    this.log('load-source'); this.notify(); if (this.wantPlay) this.play();
  }
}
