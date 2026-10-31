import { recordAudioEvent, errorDetails } from './diagnostics.mjs';

export function supportsContinuousAudio() {
  try { return Boolean(globalThis.MediaSource?.isTypeSupported('audio/mpeg')); } catch { return false; }
}
export function preferContinuousAudio() {
  const flag = new URLSearchParams(globalThis.location?.search || '').get('audio-stream');
  return flag === '1' || (flag !== '0' && /Android/i.test(globalThis.navigator?.userAgent || ''));
}
export function blobDuration(blob) {
  return new Promise((resolve, reject) => {
    const probe = document.createElement('audio'), url = URL.createObjectURL(blob);
    const cleanup = () => { clearTimeout(timer); probe.onloadedmetadata = null; probe.onerror = null; probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Audio metadata timed out')); }, 15000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      const duration = probe.duration; cleanup();
      if (Number.isFinite(duration) && duration > 0) resolve(duration); else reject(new Error('Invalid audio duration'));
    };
    probe.onerror = () => { cleanup(); reject(new Error('Cannot read audio metadata')); };
    probe.src = url;
  });
}

// One MediaSource stays attached while complete MP3 files are appended in sequence.
// Native `ended` is reserved for the end of the queue, rather than each song.
export class ContinuousAudio {
  constructor(audio, { enabled = preferContinuousAudio() && supportsContinuousAudio(),
    createSource = () => new MediaSource(), makeURL = value => URL.createObjectURL(value), revokeURL = url => URL.revokeObjectURL(url),
    durationOf = blobDuration, getBlob = () => null, aheadSeconds = 45, behindSeconds = 10, chunkBytes = 64 * 1024,
    report = recordAudioEvent, onAdvance = () => {}, onError = () => {} } = {}) {
    Object.assign(this, { audio, enabled, createSource, makeURL, revokeURL, durationOf, getBlob, aheadSeconds, behindSeconds, chunkBytes, report, onAdvance, onError });
    this.epoch = 0; this.active = false; this.busy = false; this.segments = []; this.upcoming = []; this.repeat = false;
    this.durations = new WeakMap(); this.revision = 0; this.reconciled = 0;
    audio.addEventListener('timeupdate', () => { this.syncCursor(); this.pump(); });
    audio.addEventListener('playing', () => this.pump());
  }
  get current() { return this.segments[0] || null; }
  get position() { return Math.max(0, Math.min(this.audio.currentTime - (this.current?.start || 0), this.duration || Infinity)); }
  get duration() { return this.current?.duration || 0; }
  get bufferedEnd() { const ranges = this.sb?.buffered; return ranges?.length ? ranges.end(ranges.length - 1) : 0; }
  get state() { return { active: this.active, bufferedAhead: Math.max(0, this.bufferedEnd - this.audio.currentTime), segments: this.segments.length }; }
  metadata(blob) {
    if (!this.durations.has(blob)) this.durations.set(blob, Promise.resolve().then(() => this.durationOf(blob)));
    return this.durations.get(blob);
  }
  start(track, blob, upcoming = [], repeat = false) {
    if (!this.enabled || !blob) return false;
    this.stop();
    const epoch = this.epoch, source = this.createSource();
    this.source = source; this.active = true; this.sb = null; this.busy = false;
    this.segments = [{ track, blob, start: 0, duration: 0, offset: 0, started: false, complete: false, repeated: false }];
    this.upcoming = [...upcoming]; this.repeat = repeat; this.revision++; this.reconciled = this.revision;
    this.url = this.makeURL(source);
    source.addEventListener('sourceopen', () => {
      if (!this.active || epoch !== this.epoch || this.sb) return;
      try {
        this.sb = source.addSourceBuffer('audio/mpeg'); this.sb.mode = 'sequence';
        this.sb.addEventListener('error', () => { if (epoch === this.epoch) this.fail(new Error('Audio stream decoder error')); });
        source.duration = Infinity; this.pump();
      } catch (error) { this.fail(error); }
    });
    this.audio.src = this.url; this.audio.loop = false; this.audio.load();
    this.report('stream-start', { track: track.name });
    return true;
  }
  stop() {
    this.epoch++; this.active = false;
    this.cancelUpdate?.(); this.cancelUpdate = null;
    if (this.url) this.revokeURL(this.url);
    this.url = null; this.source = null; this.sb = null; this.segments = [];
  }
  fail(error) {
    if (!this.active) return;
    this.enabled = false; this.report('stream-failed', errorDetails(error)); this.onError(error);
  }
  setUpcoming(tracks, repeat) {
    const signature = JSON.stringify([Boolean(repeat), tracks.map(t => [t.name, t.url])]);
    if (signature !== this.signature) {
      this.signature = signature; this.upcoming = [...tracks]; this.repeat = Boolean(repeat); this.revision++;
    }
    this.pump();
  }
  syncCursor() {
    if (!this.active) return;
    while (this.segments.length > 1 && this.audio.currentTime >= this.segments[1].start) {
      this.segments.shift();
      this.report('stream-boundary', { track: this.current.track.name, start: this.current.start, repeated: this.current.repeated });
      this.onAdvance(this.current);
      if (!this.active) return;
    }
  }
  canSeek(position) {
    const target = (this.current?.start || 0) + position, ranges = this.sb?.buffered;
    for (let i = 0; ranges && i < ranges.length; i++) if (ranges.start(i) <= target && target <= ranges.end(i)) return true;
    return false;
  }
  seek(position) { this.audio.currentTime = this.current.start + position; this.syncCursor(); }
  update(action, epoch) {
    return new Promise((resolve, reject) => {
      const sb = this.sb;
      const cleanup = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', failed); if (this.cancelUpdate === cancel) this.cancelUpdate = null; };
      const done = () => { cleanup(); resolve(epoch === this.epoch); };
      const failed = () => { cleanup(); reject(new Error('Audio stream update failed')); };
      const cancel = () => { cleanup(); resolve(false); };
      this.cancelUpdate = cancel;
      sb.addEventListener('updateend', done, { once: true }); sb.addEventListener('error', failed, { once: true });
      try { action(sb); } catch (error) { cleanup(); reject(error); }
    });
  }
  async reconcile(epoch) {
    const revision = this.revision;
    const expected = this.repeat ? this.segments.slice(1).map(() => this.current.track) : this.upcoming;
    let mismatch = -1;
    for (let i = 1; i < this.segments.length; i++) {
      const desired = expected[i - 1], actual = this.segments[i].track;
      if (!desired || desired.name !== actual.name || desired.url !== actual.url) { mismatch = i; break; }
    }
    if (mismatch !== -1) {
      const cut = this.segments[mismatch].start;
      if (this.bufferedEnd > cut && !await this.update(sb => sb.remove(cut, Infinity), epoch)) return false;
      if (epoch !== this.epoch) return false;
      this.sb.abort(); this.segments.splice(mismatch);
      this.report('stream-queue-updated', { track: this.current.track.name });
    }
    this.reconciled = revision; return true;
  }
  async prune(epoch) {
    if (this.source.readyState === 'ended') return true;
    const cut = this.audio.currentTime - this.behindSeconds;
    if (cut > 0 && this.sb.buffered.length && this.sb.buffered.start(0) < cut - 1) return this.update(sb => sb.remove(0, cut), epoch);
    return true;
  }
  pump() {
    if (!this.active || !this.sb || this.busy) return;
    this.busy = true; const epoch = this.epoch;
    void (async () => {
      try {
        this.syncCursor();
        if (!await this.prune(epoch)) return;
        if (epoch !== this.epoch) return;
        if (this.reconciled !== this.revision && !await this.reconcile(epoch)) return;
        while (this.active && epoch === this.epoch && !this.audio.paused) {
          if (this.reconciled !== this.revision && !await this.reconcile(epoch)) return;
          const segment = this.segments.at(-1);
          if (segment.complete) {
            const track = this.repeat ? this.current.track : this.upcoming[this.segments.length - 1];
            if (!track) {
              if (this.source.readyState === 'open') { this.source.endOfStream(); this.report('stream-queue-end'); }
              return;
            }
            if (this.bufferedEnd - this.audio.currentTime >= this.aheadSeconds) return;
            const blob = this.repeat ? this.current.blob : this.getBlob(track);
            if (!blob) return;
            this.segments.push({ track, blob, start: segment.end, duration: 0, offset: 0, started: false, complete: false, repeated: this.repeat });
            continue;
          }
          if (!segment.duration) {
            segment.duration = await this.metadata(segment.blob);
            if (epoch !== this.epoch) return;
          }
          if (this.bufferedEnd - this.audio.currentTime >= this.aheadSeconds) return;
          const limit = Math.min(segment.offset + this.chunkBytes, segment.blob.size);
          const bytes = await segment.blob.slice(segment.offset, limit).arrayBuffer();
          if (epoch !== this.epoch || this.audio.paused) return;
          if (this.reconciled !== this.revision) continue;
          if (!segment.started) { this.sb.timestampOffset = segment.start; segment.started = true; }
          try { if (!await this.update(sb => sb.appendBuffer(bytes), epoch)) return; }
          catch (error) {
            if (error.name !== 'QuotaExceededError' || !await this.prune(epoch)) throw error;
            if (!await this.update(sb => sb.appendBuffer(bytes), epoch)) return;
          }
          if (epoch !== this.epoch) return;
          segment.offset = limit;
          if (limit === segment.blob.size) {
            segment.end = this.bufferedEnd;
            if (segment.end <= segment.start) throw new Error('MP3 contains no playable frames');
            segment.duration = segment.end - segment.start; segment.complete = true;
          }
        }
      } catch (error) { if (epoch === this.epoch) this.fail(error); }
      finally {
        if (epoch === this.epoch) {
          this.busy = false;
          if (this.active && this.reconciled !== this.revision) this.pump();
        }
      }
    })();
  }
}
