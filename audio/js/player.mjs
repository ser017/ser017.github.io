import { TrackQueue } from './queue.mjs';
import { NextTrackBuffer, directURL } from './prefetch.mjs';

export class AudioPlayer extends EventTarget {
  constructor(audio, { queue = new TrackQueue(), buffer = new NextTrackBuffer(), revokeURL = url => URL.revokeObjectURL(url) } = {}) {
    super();
    Object.assign(this, { audio, queue, buffer, revokeURL });
    this.track = null; this.status = 'idle'; this.wantPlay = false; this.repeat = false;
    this.request = 0; this.activeBlob = null; this.candidates = []; this.sourceIndex = 0;
    this.error = ''; this.prefetchFor = null;
    audio.autoplay = false;
    audio.addEventListener('playing', () => {
      if (!this.wantPlay) { audio.pause(); return; }
      this.status = 'playing'; this.error = ''; this.notify();
    });
    audio.addEventListener('pause', () => {
      if (this.status === 'loading' && this.wantPlay) return;
      if (audio.ended || this.status === 'error') return;
      this.wantPlay = false; this.status = this.track ? 'paused' : 'idle'; this.notify();
    });
    audio.addEventListener('waiting', () => {
      if (this.wantPlay) { this.status = 'loading'; this.notify(); }
    });
    audio.addEventListener('timeupdate', () => {
      this.dispatchEvent(new Event('progress'));
      if (this.wantPlay && !audio.paused && audio.currentTime >= 3 && audio.readyState >= 3) this.prepareNext();
    });
    audio.addEventListener('loadedmetadata', () => this.dispatchEvent(new Event('progress')));
    audio.addEventListener('volumechange', () => this.dispatchEvent(new Event('volume')));
    audio.addEventListener('error', () => { if (audio.error) this.sourceFailed(); });
    audio.addEventListener('ended', () => {
      if (this.repeat) return;
      const next = this.queue.next();
      // Один и тот же audio-элемент и немедленный play(), независимо от visibilityState.
      if (next) this.select(next, true);
      else { this.wantPlay = false; this.status = 'ended'; this.buffer.cancel(); this.notify(); }
    });
  }
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
    this.notify();
    if (autoplay) this.play();
  }
  play() {
    if (!this.track) return;
    this.wantPlay = true; this.error = ''; this.status = 'loading'; this.notify();
    const token = this.request;
    try {
      const promise = this.audio.play();
      Promise.resolve(promise).catch(error => {
        if (token !== this.request || !this.wantPlay || error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') {
          this.wantPlay = false; this.status = 'blocked'; this.error = 'Нажмите ▶, чтобы продолжить воспроизведение.'; this.notify();
        } else this.sourceFailed();
      });
    } catch { this.sourceFailed(); }
  }
  pause() { this.wantPlay = false; this.audio.pause(); this.status = this.track ? 'paused' : 'idle'; this.notify(); }
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
    if (this.wantPlay && !this.audio.paused && this.audio.currentTime >= 3) this.prepareNext();
    this.notify();
  }
  setRepeat(value) {
    this.repeat = Boolean(value); this.audio.loop = this.repeat;
    this.buffer.cancel(); this.prefetchFor = null;
    if (!this.repeat && this.wantPlay && !this.audio.paused) this.prepareNext();
    this.notify();
  }
  prepareNext() {
    const next = this.repeat ? null : this.queue.nextTrack;
    if (!next || this.prefetchFor === next.name) return;
    this.prefetchFor = next.name;
    void this.buffer.prepare(next);
  }
  sourceFailed() {
    if (!this.track || this.status === 'error') return;
    if (this.sourceIndex + 1 < this.candidates.length) {
      this.sourceIndex++; this.request++;
      this.status = this.wantPlay ? 'loading' : 'paused';
      this.audio.src = this.candidates[this.sourceIndex]; this.audio.load();
      this.notify(); if (this.wantPlay) this.play();
      return;
    }
    this.wantPlay = false; this.audio.pause(); this.status = 'error';
    this.error = 'Не удалось загрузить трек. Проверьте соединение и попробуйте ещё раз.';
    this.notify();
  }
}
