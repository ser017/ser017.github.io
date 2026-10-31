import { AudioFileCache } from './audio-cache.mjs';
import { recordAudioEvent, errorDetails } from './diagnostics.mjs';

export function directURL(value) {
  const url = new URL(value);
  if (['www.dropbox.com', 'dropbox.com'].includes(url.hostname) && /^\/(scl\/fi|s)\//.test(url.pathname)) {
    url.hostname = 'dl.dropboxusercontent.com';
    url.searchParams.delete('dl');
  }
  return url.href;
}
function delay(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
export class NextTrackBuffer {
  constructor({ fetcher = (...args) => globalThis.fetch(...args), makeURL = blob => URL.createObjectURL(blob), revokeURL = url => URL.revokeObjectURL(url), maxBytes = 192 * 1024 * 1024, memoryBytes = 32 * 1024 * 1024, cache = new AudioFileCache(), retryDelays = [1500, 5000], timeoutMs = 180000, idleTimeoutMs = 20000, report = recordAudioEvent } = {}) {
    Object.assign(this, { fetcher, makeURL, revokeURL, maxBytes, memoryBytes, cache, retryDelays, timeoutMs, idleTimeoutMs, report });
    this.job = null; this.ready = null;
  }
  cancel() {
    this.job?.controller.abort(); this.job = null;
    if (this.ready) this.revokeURL(this.ready.url);
    this.ready = null;
  }
  take(id) {
    if (this.ready?.id !== id) return null;
    const ready = this.ready; this.ready = null; this.job = null;
    return ready.url;
  }
  async prepare(track) {
    if (!track?.url) { this.cancel(); return false; }
    if (this.ready?.id === track.name) return true;
    if (this.job?.id === track.name) return false;
    this.cancel(); this.permanentFailure = false;
    const job = { id: track.name, controller: new AbortController() }; this.job = job;
    const sources = [...new Set([directURL(track.url), track.url])];
    try {
      const cached = await this.cache?.get(track);
      if (this.job !== job || job.controller.signal.aborted) return false;
      if (cached) {
        this.ready = { id: track.name, url: this.makeURL(cached), bytes: cached.size };
        this.report('prefetch-ready', { track: track.name, bytes: cached.size, cached: true }); return true;
      }
      for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
        if (attempt) await delay(this.retryDelays[attempt - 1], job.controller.signal);
        if (this.job !== job || job.controller.signal.aborted) return false;
        const controller = new AbortController();
        const abort = () => controller.abort();
        job.controller.signal.addEventListener('abort', abort, { once: true });
        let timedOut = false, idleTimer = null;
        const progress = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { timedOut = true; controller.abort(); }, this.idleTimeoutMs);
        };
        progress();
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
        let size = 0, status = null, type = '', permanent = false, declaredBytes = 0;
        const started = Date.now();
        this.report('prefetch-start', { track: track.name, attempt: attempt + 1, source: attempt % sources.length ? 'original' : 'direct' });
        try {
          const response = await this.fetcher(sources[attempt % sources.length], { signal: controller.signal, credentials: 'omit' });
          status = response.status;
          if (!response.ok || !response.body) throw new Error(`Prefetch HTTP ${status}`);
          type = response.headers.get('content-type') || 'audio/mpeg';
          if (/text\/|application\/(json|xml)/i.test(type)) throw new Error('Response is not audio');
          declaredBytes = Number(response.headers.get('content-length'));
          const disk = this.cache?.writable ? await this.cache.writable() : Boolean(await this.cache?.open());
          const limit = disk ? this.maxBytes : Math.min(this.maxBytes, this.memoryBytes);
          if (declaredBytes > limit) { permanent = true; throw new Error(disk ? 'Audio exceeds file cache limit' : 'Audio exceeds memory fallback limit'); }
          let blob;
          if (disk) {
            blob = await this.cache.put(track, response, { signal: controller.signal, maxBytes: limit, onChunk: count => { size = count; progress(); } });
            if (blob) size = blob.size;
          } else {
            const reader = response.body.getReader(); const chunks = [];
            try {
              while (true) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength; progress();
                if (size > limit) { permanent = true; await reader.cancel(); throw new Error('Audio exceeds memory fallback limit'); }
                chunks.push(value);
              }
            } finally { reader.releaseLock(); }
            if (declaredBytes > 0 && size !== declaredBytes) throw new Error('Incomplete audio response');
            blob = new Blob(chunks, { type });
          }
          if (this.job !== job || controller.signal.aborted) return false;
          if (!blob?.size) throw new Error('Empty audio response');
          this.ready = { id: track.name, url: this.makeURL(blob), bytes: size };
          this.report('prefetch-ready', { track: track.name, attempt: attempt + 1, bytes: size, elapsedMs: Date.now() - started });
          return true;
        } catch (error) {
          controller.abort();
          if (this.job !== job || job.controller.signal.aborted) return false;
          this.report('prefetch-failed', { track: track.name, attempt: attempt + 1, status, type, bytes: size, declaredBytes, permanent, timedOut, ...errorDetails(error) });
          if (permanent) { this.permanentFailure = true; break; }
        } finally {
          clearTimeout(timer); clearTimeout(idleTimer); job.controller.signal.removeEventListener('abort', abort);
        }
      }
      return false;
    } finally {
      if (this.job === job) this.job = null;
    }
  }
}
