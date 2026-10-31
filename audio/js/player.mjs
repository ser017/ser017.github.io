import { recordAudioEvent, errorDetails } from './diagnostics.mjs';
import { TrackQueue } from './queue.mjs';
import { PlaybackBuffer } from './reserve.mjs';
import { directURL } from './prefetch.mjs';
import { ContinuousAudio } from './continuous.mjs';

export class AudioPlayer extends EventTarget {
  constructor(audio, { queue = new TrackQueue(), buffer = new PlaybackBuffer(), continuous = null, revokeURL = url => URL.revokeObjectURL(url), retryDelays = [1000, 3000, 7000, 15000, 30000, 60000, 60000, 60000], startupTimeoutMs = 25000, stalledTimeoutMs = 20000, pauseRecoveryDelays = [300, 1500], isHidden = () => globalThis.document?.hidden === true, report = recordAudioEvent } = {}) {
    super();
    Object.assign(this, { audio, queue, buffer, revokeURL, retryDelays, startupTimeoutMs, stalledTimeoutMs, pauseRecoveryDelays, isHidden, report });
    this.track = null; this.status = 'idle'; this.wantPlay = false; this.repeat = false;
    this.request = 0; this.activeBlob = null; this.candidates = []; this.sourceIndex = 0;
    this.error = ''; this.prefetchFor = null;
    this.retryTimer = null; this.retryCount = 0; this.resumeAt = 0; this.watchdog = null;
    this.pauseRecoveryTimer = null; this.pauseRecoveryCount = 0; this.pauseRecoveryProgress = 0;
    this.stream = continuous || new ContinuousAudio(audio, { report });
    this.stream.getBlob = track => this.buffer.peekBlob?.(track.name);
    this.stream.onAdvance = segment => this.advanceStream(segment);
    this.stream.onError = error => this.sourceFailed(error);
    this.buffer.onChange = () => {
      this.dispatchEvent(new Event('buffer'));
      this.stream.pump();
      if (this.track && this.wantPlay && ['loading', 'recovering'].includes(this.status)) {
        const prepared = this.buffer.take(this.track.name);
        if (prepared) this.usePrepared(prepared);
      }
    };
    audio.autoplay = false;
    audio.addEventListener('playing', () => {
      if (!this.wantPlay) { audio.pause(); return; }
      this.clearWatchdog(); this.clearPauseRecovery(); this.status = 'playing'; this.error = ''; this.log('playing'); this.notify(); this.prepareNext();
    });
    audio.addEventListener('pause', event => this.handlePause(event));
    audio.addEventListener('waiting', () => {
      if (this.wantPlay) { if (this.status !== 'loading') this.log('audio-waiting'); this.status = 'loading'; this.armWatchdog(this.stalledTimeoutMs); this.notify(); }
    });
    audio.addEventListener('stalled', () => { if (this.wantPlay) { this.log('audio-stalled'); this.armWatchdog(this.stalledTimeoutMs); } });
    audio.addEventListener('timeupdate', () => {
      if (this.wantPlay && !audio.paused && audio.readyState >= 3 && this.position !== this.lastProgress) { this.lastProgress = this.position; this.clearWatchdog(); }
      if (!audio.paused && this.pauseRecoveryCount && this.position - this.pauseRecoveryProgress >= 30) this.pauseRecoveryCount = 0;
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
      if ((this.repeat && !this.stream.active) || !this.wantPlay) return;
      this.clearRetry(); this.clearWatchdog(); this.clearPauseRecovery(); this.log('ended');
      const next = this.queue.next();
      // Один и тот же audio-элемент и немедленный play(), независимо от visibilityState.
      if (next) this.select(next, true);
      else { this.wantPlay = false; this.status = 'ended'; this.buffer.cancel(); this.notify(); }
    });
  }
  log(event, details = {}) {
    this.report(event, { track: this.track?.name || null, status: this.status, wantPlay: this.wantPlay,
      source: this.stream.active ? 'continuous' : this.audio.src?.startsWith('blob:') ? 'buffered' : this.audio.src === directURL(this.track?.url || 'https://invalid.local') ? 'direct' : 'original',
      sourceIndex: this.sourceIndex, retry: this.retryCount, currentTime: this.position || 0, timelineTime: this.audio.currentTime || 0,
      readyState: this.audio.readyState, networkState: this.audio.networkState, paused: this.audio.paused, ended: this.audio.ended,
      duration: Number.isFinite(this.duration) ? this.duration : null, pauseRecovery: this.pauseRecoveryCount,
      reserve: this.bufferState, stream: this.stream.state, ...details });
  }
  clearPauseRecovery() { if (this.pauseRecoveryTimer !== null) clearTimeout(this.pauseRecoveryTimer); this.pauseRecoveryTimer = null; }
  handlePause(event) {
    // load()/source changes can deliver a pause event after a newer play().
    if (!this.audio.paused) { this.log('stale-pause-ignored'); return; }
    if (this.audio.ended || this.audio.error || this.status === 'error') return;
    if (this.wantPlay && this.track && this.isHidden()) {
      this.clearRetry(); this.clearWatchdog(); this.buffer.suspend?.();
      // Repeated pause events do not consume retries or postpone a pending retry.
      if (this.status === 'interrupted') { this.log('audio-pause-repeat'); return; }
      this.request++; this.status = 'interrupted';
      this.log('audio-interrupted', { trusted: event?.isTrusted === true });
      if (this.pauseRecoveryCount < this.pauseRecoveryDelays.length) {
        const token = this.request, delay = this.pauseRecoveryDelays[this.pauseRecoveryCount];
        this.pauseRecoveryTimer = setTimeout(() => {
          this.pauseRecoveryTimer = null;
          if (token !== this.request || !this.wantPlay || !this.audio.paused || this.status !== 'interrupted') return;
          this.pauseRecoveryCount++; this.pauseRecoveryProgress = this.position;
          this.log('pause-recovery-start'); this.play();
        }, delay);
        this.pauseRecoveryTimer?.unref?.();
        this.log('pause-recovery-scheduled', { delayMs: delay });
      } else this.log('pause-recovery-limited');
      this.notify(); return;
    }
    this.wantPlay = false; this.clearRetry(); this.clearWatchdog(); this.clearPauseRecovery(); this.buffer.suspend?.();
    this.request++; this.status = this.track ? 'paused' : 'idle'; this.log('audio-pause'); this.notify();
  }
  clearRetry() { if (this.retryTimer !== null) clearTimeout(this.retryTimer); this.retryTimer = null; }
  clearWatchdog() { if (this.watchdog !== null) clearTimeout(this.watchdog); this.watchdog = null; }
  armWatchdog(ms) {
    if (this.watchdog !== null) return;
    const token = this.request;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (token === this.request && this.wantPlay) this.sourceFailed({ name: 'TimeoutError', message: 'Audio made no progress before timeout' });
    }, ms);
    this.watchdog?.unref?.();
  }
  recover() {
    if (!this.wantPlay) return;
    if (this.status === 'interrupted') {
      if (!this.isHidden()) { this.log('pause-recovery-visible'); this.play(); }
      return;
    }
    this.prepareNext(); this.buffer.retryNow?.();
    if (this.status === 'recovering' && this.retryTimer !== null) {
      this.clearRetry(); this.log('connection-retry'); this.retryCurrent();
    }
  }
  get bufferState() { return this.buffer.state || { ready: 0, total: 0 }; }
  get position() { return this.stream.active ? this.stream.position : this.audio.currentTime; }
  get duration() { return this.stream.active ? this.stream.duration : this.audio.duration; }
  advanceStream(segment) {
    if (!segment.repeated) {
      if (this.queue.nextTrack?.name !== segment.track.name) {
        this.log('stream-queue-race');
        const desired = this.queue.next();
        if (desired) this.select(desired, this.wantPlay);
        else { this.wantPlay = false; this.stream.stop(); this.audio.pause(); this.status = 'ended'; this.notify(); }
        return;
      }
      this.queue.next();
      const previousBlob = this.activeBlob;
      this.activeBlob = this.buffer.take(segment.track.name) || URL.createObjectURL(segment.blob);
      if (previousBlob && previousBlob !== this.activeBlob) this.revokeURL(previousBlob);
      this.track = segment.track;
    }
    this.request++; this.clearRetry(); this.clearWatchdog(); this.clearPauseRecovery();
    this.retryCount = 0; this.pauseRecoveryCount = 0; this.pauseRecoveryProgress = 0; this.lastProgress = null;
    this.status = this.wantPlay ? 'playing' : 'paused'; this.error = ''; this.log('continuous-next', { repeated: segment.repeated });
    this.notify(); this.prepareNext();
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
    this.clearRetry(); this.clearWatchdog(); this.clearPauseRecovery(); this.pauseRecoveryCount = 0; this.pauseRecoveryProgress = 0;
    this.retryCount = 0; this.resumeAt = 0; this.lastProgress = null;
    const blob = this.buffer.peekBlob?.(track.name);
    const prepared = this.buffer.take(track.name);
    this.stream.stop();
    if (!this.buffer.prepareQueue) this.buffer.cancel(); this.prefetchFor = null;
    const previousBlob = this.activeBlob;
    this.activeBlob = prepared;
    this.track = track; this.wantPlay = autoplay; this.status = autoplay ? 'loading' : 'paused'; this.error = '';
    this.request++;
    this.candidates = [...new Set([prepared, directURL(track.url), track.url].filter(Boolean))];
    this.sourceIndex = 0;
    let streaming = false;
    try { streaming = Boolean(blob && this.stream.start(track, blob, this.queue.upcoming, this.repeat)); }
    catch (error) { this.stream.stop(); this.stream.enabled = false; this.log('stream-start-failed', errorDetails(error)); }
    if (!streaming) { this.audio.src = this.candidates[0]; this.audio.loop = this.repeat; this.audio.load(); }
    if (previousBlob && previousBlob !== prepared) this.revokeURL(previousBlob);
    this.log('select', { buffered: Boolean(prepared) }); this.notify();
    if (autoplay) this.play();
    if (!prepared) this.restoreCurrent();
  }
  usePrepared(url) {
    this.clearRetry(); this.clearPauseRecovery();
    const previousBlob = this.activeBlob;
    this.activeBlob = url;
    this.candidates = [...new Set([url, directURL(this.track.url), this.track.url])];
    this.log('cache-restore'); this.loadCandidate(0);
    if (previousBlob && previousBlob !== url) this.revokeURL(previousBlob);
  }
  restoreCurrent(fallbackToNetwork = false) {
    if (!this.track || !this.wantPlay) return;
    const prepared = this.buffer.take(this.track.name);
    if (prepared) { this.usePrepared(prepared); return; }
    if (!this.buffer.restore) { if (fallbackToNetwork) this.loadCandidate(0); return; }
    const token = this.request;
    void this.buffer.restore(this.track).then(url => {
      if (token !== this.request || !this.wantPlay || this.status === 'playing') { if (url) this.revokeURL(url); return; }
      if (url) this.usePrepared(url);
      else if (fallbackToNetwork) this.loadCandidate(0);
    }).catch(error => {
      this.log('cache-restore-failed', errorDetails(error));
      if (fallbackToNetwork && token === this.request && this.wantPlay) this.loadCandidate(0);
    });
  }
  retryCurrent() {
    this.candidates = [...new Set([directURL(this.track.url), this.track.url])]; this.sourceIndex = 0;
    this.armWatchdog(this.startupTimeoutMs); this.restoreCurrent(true);
  }
  play() {
    if (!this.track) return;
    if (this.stream.active && this.status === 'ended') { this.wantPlay = true; this.leaveStream(0); return; }
    if (this.status === 'error' || this.audio.error) { this.retry(); return; }
    this.clearRetry(); this.clearPauseRecovery();
    this.wantPlay = true; this.error = ''; this.status = 'loading'; this.armWatchdog(this.startupTimeoutMs); this.notify();
    const token = this.request;
    const failed = error => {
      if (token !== this.request || !this.wantPlay || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        this.wantPlay = false; this.clearRetry(); this.clearWatchdog(); this.buffer.suspend?.(); this.status = 'blocked';
        this.error = 'Нажмите ▶, чтобы продолжить воспроизведение.';
        this.log('play-blocked', errorDetails(error)); this.notify();
      } else this.sourceFailed(error);
    };
    try { Promise.resolve(this.audio.play()).catch(failed); }
    catch (error) { failed(error); }
  }
  pause(origin = 'page') {
    this.wantPlay = false; this.clearRetry(); this.clearWatchdog(); this.clearPauseRecovery(); this.buffer.suspend?.(); this.request++; this.audio.pause();
    this.status = this.track ? 'paused' : 'idle'; this.log('user-pause', { origin }); this.notify();
  }
  toggle() {
    if (this.status === 'interrupted' && this.pauseRecoveryTimer === null) this.play();
    else if (this.wantPlay) this.pause(); else if (this.status === 'error') this.retry(); else this.play();
  }
  retry() { if (this.track) this.select(this.track, true); }
  next() { const track = this.queue.next(); if (track) this.select(track, true); }
  previous() {
    if (!this.track) return;
    if (this.position > 3) { this.seek(0); return; }
    const track = this.queue.previous(); if (track) this.select(track, true);
  }
  seek(value) {
    if (!Number.isFinite(this.duration) || this.duration <= 0) return;
    const position = Math.max(0, Math.min(value, this.duration));
    if (this.stream.active) {
      if (this.stream.canSeek(position)) this.stream.seek(position);
      else this.leaveStream(position);
    } else this.audio.currentTime = position;
    this.dispatchEvent(new Event('progress'));
  }
  setShuffle(value) {
    this.queue.setShuffle(value); if (!this.buffer.prepareQueue) this.buffer.cancel(); this.prefetchFor = null;
    if (this.wantPlay && !this.audio.paused) this.prepareNext();
    this.notify();
  }
  setRepeat(value) {
    this.repeat = Boolean(value); this.audio.loop = this.stream.active ? false : this.repeat;
    if (!this.buffer.prepareQueue) this.buffer.cancel(); this.prefetchFor = null;
    if (this.buffer.prepareQueue || (!this.repeat && this.wantPlay && !this.audio.paused)) this.prepareNext();
    this.notify();
  }
  updateQueue(action, ...args) {
    if (!this.queue[action](...args)) return;
    if (!this.buffer.prepareQueue) this.buffer.cancel(); this.prefetchFor = null;
    if (this.buffer.prepareQueue || (!this.repeat && this.wantPlay && !this.audio.paused)) this.prepareNext();
    this.notify();
  }
  removeUpcoming(index) { this.updateQueue('removeUpcoming', index); }
  moveUpcoming(from, to) { this.updateQueue('moveUpcoming', from, to); }
  prepareNext() {
    if (this.stream.active) this.stream.setUpcoming(this.queue.upcoming, this.repeat);
    if (this.buffer.prepareQueue) {
      if (this.repeat) { this.buffer.suspend(); return; }
      this.buffer.prepareQueue(this.queue.upcoming);
      if (!this.wantPlay) this.buffer.suspend();
      return;
    }
    const next = this.repeat ? null : this.queue.nextTrack;
    if (!next || this.prefetchFor === next.name) return;
    this.prefetchFor = next.name;
    void this.buffer.prepare(next);
  }
  sourceFailed(error) {
    if (!this.track || this.status === 'error' || this.retryTimer !== null) return;
    this.clearWatchdog(); this.log('source-failed', errorDetails(error));
    if (this.stream.active) { this.leaveStream(this.position); return; }
    this.resumeAt = Math.max(this.resumeAt, this.position || 0);
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
        this.log('retry-start'); this.retryCurrent();
      }, delay);
      this.notify(); return;
    }
    this.wantPlay = false; this.clearWatchdog(); this.clearPauseRecovery(); this.buffer.suspend?.(); this.request++; this.audio.pause(); this.status = 'error';
    this.error = 'Не удалось загрузить трек. Проверьте соединение и попробуйте ещё раз.';
    this.log('playback-error'); this.notify();
  }
  loadCandidate(index) {
    this.clearWatchdog(); this.sourceIndex = index; this.request++;
    this.status = this.wantPlay ? 'loading' : 'paused';
    this.audio.src = this.candidates[index]; this.audio.load();
    this.log('load-source'); this.notify(); if (this.wantPlay) this.play();
  }
  leaveStream(position) {
    this.stream.stop(); this.resumeAt = position;
    this.candidates = [...new Set([this.activeBlob, directURL(this.track.url), this.track.url].filter(Boolean))];
    this.audio.loop = this.repeat; this.log('stream-fallback'); this.loadCandidate(0);
  }
}
