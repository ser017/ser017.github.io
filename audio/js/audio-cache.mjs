import { recordAudioEvent, errorDetails } from './diagnostics.mjs';

const MiB = 1024 * 1024;
export class AudioFileCache {
  constructor({ storage = null, maxBytes = 512 * MiB, maxEntries = 12, maxAgeMs = 7 * 86400000, report = recordAudioEvent } = {}) {
    Object.assign(this, { storage, maxBytes, maxEntries, maxAgeMs, report });
    this.pending = Promise.resolve(); this.cachePromise = null; this.writeDisabled = false;
    this.base = new URL('/.audio-files-v1/', globalThis.location?.origin || 'https://audio.local/').href;
  }
  async open() {
    if (!this.cachePromise) this.cachePromise = (async () => {
      try { return await (this.storage || globalThis.caches)?.open('ser017-audio-files-v1') || null; }
      catch (error) { this.report('cache-unavailable', errorDetails(error)); return null; }
    })();
    return this.cachePromise;
  }
  async writable() { return !this.writeDisabled && Boolean(await this.open()); }
  async key(track) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${track.name}\n${track.url}`));
    return this.base + [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async get(track) {
    const cache = await this.open(); if (!cache) return null;
    try {
      const key = await this.key(track), response = await cache.match(key);
      if (!response) return null;
      const age = Date.now() - Number(response.headers.get('x-audio-cached-at'));
      if (age > this.maxAgeMs) { await cache.delete(key); return null; }
      const blob = await response.blob();
      const expected = Number(response.headers.get('content-length'));
      if (!blob.size || (expected > 0 && blob.size !== expected)) { await cache.delete(key); return null; }
      this.report('cache-hit', { track: track.name, bytes: blob.size });
      return blob;
    } catch (error) { this.report('cache-read-failed', errorDetails(error)); return null; }
  }
  async put(track, response, { signal, maxBytes, onChunk = () => {} } = {}) {
    const cache = await this.open(); if (!cache || this.writeDisabled) throw new Error('Audio cache unavailable');
    const key = await this.key(track); let bytes = 0;
    const expected = Number(response.headers.get('content-length'));
    const type = response.headers.get('content-type') || 'audio/mpeg';
    const headers = new Headers({ 'content-type': type, 'x-audio-cached-at': String(Date.now()) });
    if (expected > 0) headers.set('content-length', String(expected));
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new Error('Audio exceeds file cache limit');
        onChunk(bytes); controller.enqueue(chunk);
      },
      flush() { if (!bytes || (expected > 0 && bytes !== expected)) throw new Error('Incomplete audio response'); },
    }));
    try {
      await cache.put(key, new Response(stream, { status: 200, headers }));
      if (signal?.aborted) { await cache.delete(key); return null; }
      await this.updateIndex(cache, { key, bytes, time: Date.now() });
      this.report('cache-saved', { track: track.name, bytes });
      return await this.get(track);
    } catch (error) {
      await cache.delete(key).catch(() => {});
      if (error.name === 'QuotaExceededError') {
        this.writeDisabled = true; this.report('cache-full', errorDetails(error));
      }
      throw error;
    }
  }
  updateIndex(cache, entry) {
    const update = async () => {
      const indexKey = this.base + 'index';
      const saved = await cache.match(indexKey);
      let entries = saved ? await saved.json().catch(() => []) : [];
      if (!Array.isArray(entries)) entries = [];
      entries = entries.filter(x => x.key !== entry.key);
      entries.push(entry);
      let total = entries.reduce((sum, x) => sum + x.bytes, 0);
      while (entries.length > this.maxEntries || total > this.maxBytes) {
        const old = entries.shift(); total -= old.bytes; await cache.delete(old.key);
      }
      await cache.put(indexKey, new Response(JSON.stringify(entries), { headers: { 'content-type': 'application/json' } }));
    };
    this.pending = this.pending.catch(() => {}).then(update);
    return this.pending;
  }
}
