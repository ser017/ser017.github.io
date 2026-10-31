import { NextTrackBuffer } from './prefetch.mjs';
import { AudioFileCache } from './audio-cache.mjs';
import { recordAudioEvent, errorDetails } from './diagnostics.mjs';

export class PlaybackBuffer {
  constructor({ depth = 5, concurrency = 2, maxReadyBytes = 256 * 1024 * 1024, retryMs = 30000,
    cache = new AudioFileCache(), createBuffer = options => new NextTrackBuffer(options),
    makeURL = blob => URL.createObjectURL(blob), report = recordAudioEvent } = {}) {
    Object.assign(this, { depth, concurrency, maxReadyBytes, retryMs, cache, createBuffer, makeURL, report });
    this.entries = new Map(); this.order = []; this.running = 0; this.timer = null;
    this.paused = false; this.onChange = () => {}; this.hadFailure = false;
  }
  get state() {
    const entries = [...this.entries.values()];
    return { ready: entries.filter(x => x.buffer.ready).length, total: entries.length,
      bytes: entries.reduce((sum, x) => sum + (x.buffer.ready?.bytes || 0), 0), loading: this.running };
  }
  emit() { this.onChange(this.state); }
  prepareQueue(tracks) {
    const wanted = [...new Map(tracks.filter(x => x?.url).slice(0, this.depth).map(x => [x.name, x])).values()];
    const signature = JSON.stringify(wanted.map(x => [x.name, x.url]));
    if (signature === this.signature && !this.paused) return;
    this.signature = signature;
    const names = new Set(wanted.map(x => x.name));
    for (const [id, entry] of this.entries) {
      if (!names.has(id) || wanted.find(x => x.name === id)?.url !== entry.track.url) {
        entry.cancelled = true; entry.buffer.cancel(); this.entries.delete(id);
      }
    }
    for (const track of wanted) if (!this.entries.has(track.name)) {
      this.entries.set(track.name, { track, buffer: this.createBuffer({ cache: this.cache, report: this.report }), running: false, retryAt: 0, lastBytes: 0, permanent: false });
    }
    this.order = wanted.map(x => x.name); this.paused = false; this.pump(); this.emit();
  }
  take(id) {
    const entry = this.entries.get(id); if (!entry) return null;
    const url = entry.buffer.take(id); if (!url) return null;
    this.entries.delete(id); this.order = this.order.filter(x => x !== id);
    this.emit(); return url;
  }
  async restore(track) {
    const blob = await this.cache.get(track);
    return blob ? this.makeURL(blob) : null;
  }
  suspend() {
    this.paused = true; clearTimeout(this.timer); this.timer = null;
    for (const entry of this.entries.values()) if (entry.running) { entry.cancelled = true; entry.buffer.cancel(); }
  }
  cancel() {
    this.suspend();
    for (const entry of this.entries.values()) entry.buffer.cancel();
    this.entries.clear(); this.order = []; this.signature = null; this.emit();
  }
  retryNow() {
    for (const entry of this.entries.values()) if (!entry.permanent) entry.retryAt = 0;
    this.pump();
  }
  trimReady() {
    let bytes = this.state.bytes;
    for (const id of [...this.order].reverse()) {
      if (bytes <= this.maxReadyBytes) break;
      const entry = this.entries.get(id);
      if (entry?.buffer.ready) { bytes -= entry.buffer.ready.bytes || 0; entry.buffer.cancel(); }
    }
  }
  pump() {
    clearTimeout(this.timer); this.timer = null;
    if (this.paused) return;
    const entries = this.order.map(id => this.entries.get(id)).filter(Boolean);
    for (const entry of entries) {
      if (this.running >= this.concurrency) break;
      if (entry.running || entry.buffer.ready || entry.permanent || entry.retryAt > Date.now()) continue;
      if (entry.lastBytes && this.state.bytes + entry.lastBytes > this.maxReadyBytes) continue;
      entry.running = true; entry.cancelled = false; this.running++;
      void (async () => {
        let success = false;
        try { success = await entry.buffer.prepare(entry.track); }
        catch (error) { this.report('reserve-failed', { track: entry.track.name, ...errorDetails(error) }); }
        finally {
          entry.running = false; this.running--;
          if (this.entries.get(entry.track.name) === entry) {
            if (!entry.cancelled && !success) {
              this.hadFailure = true; entry.permanent = Boolean(entry.buffer.permanentFailure);
              entry.retryAt = Date.now() + this.retryMs;
            }
            if (success) entry.lastBytes = entry.buffer.ready?.bytes || 0;
            this.trimReady(); this.emit();
          }
          this.pump();
        }
      })();
    }
    const future = entries.filter(x => !x.running && !x.buffer.ready && !x.permanent && x.retryAt > Date.now());
    if (future.length) this.timer = setTimeout(() => this.pump(), Math.max(1, Math.min(...future.map(x => x.retryAt)) - Date.now()));
  }
}
