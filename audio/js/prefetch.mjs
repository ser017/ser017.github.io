export function directURL(value) {
  const url = new URL(value);
  if (['www.dropbox.com', 'dropbox.com'].includes(url.hostname) && /^\/(scl\/fi|s)\//.test(url.pathname)) {
    url.hostname = 'dl.dropboxusercontent.com';
    url.searchParams.delete('dl');
  }
  return url.href;
}
export class NextTrackBuffer {
  constructor({ fetcher = globalThis.fetch, makeURL = blob => URL.createObjectURL(blob), revokeURL = url => URL.revokeObjectURL(url), maxBytes = 32 * 1024 * 1024 } = {}) {
    Object.assign(this, { fetcher, makeURL, revokeURL, maxBytes });
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
    if (!track?.url) { this.cancel(); return; }
    if (this.ready?.id === track.name || this.job?.id === track.name) return;
    this.cancel();
    const controller = new AbortController();
    const job = { id: track.name, controller }; this.job = job;
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await this.fetcher(directURL(track.url), { signal: controller.signal, credentials: 'omit' });
      if (!response.ok || !response.body) throw new Error('Prefetch unavailable');
      const type = response.headers.get('content-type') || 'audio/mpeg';
      if (/text\/|application\/(json|xml)/i.test(type)) throw new Error('Not audio');
      if (Number(response.headers.get('content-length')) > this.maxBytes) throw new Error('Audio is too large to prefetch');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > this.maxBytes) { await reader.cancel(); throw new Error('Prefetch limit'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      if (this.job !== job || controller.signal.aborted || size === 0) return;
      this.ready = { id: track.name, url: this.makeURL(new Blob(chunks, { type })) };
    } catch {
      controller.abort();
      // Предзагрузка необязательна: сам трек всегда можно запустить обычным способом.
    } finally {
      clearTimeout(timer);
      if (this.job === job) this.job = null;
    }
  }
}
