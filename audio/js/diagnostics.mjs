const key = 'ser017-audio-diagnostics-v1';
const limit = 240;
export const playbackVersion = '2026-10-31-interruption-4';
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
let events = [];
try {
  const saved = JSON.parse(globalThis.localStorage?.getItem(key) || '[]');
  if (Array.isArray(saved)) events = saved.slice(-limit);
} catch {}

// Keep reports local and omit shared-link tokens from exception messages.
export function errorDetails(error) {
  return {
    errorName: String(error?.name || 'Error'),
    errorMessage: String(error?.message || '').replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]').slice(0, 400),
    ...(Number.isFinite(error?.code) ? { errorCode: error.code } : {}),
  };
}
export function recordAudioEvent(event, details = {}) {
  events.push({ time: new Date().toISOString(), version: playbackVersion, session, event,
    visibility: globalThis.document?.visibilityState || 'unknown', online: globalThis.navigator?.onLine ?? null, ...details });
  events = events.slice(-limit);
  try { globalThis.localStorage?.setItem(key, JSON.stringify(events)); } catch {}
}
export function audioReport() {
  return { version: playbackVersion, exportedAt: new Date().toISOString(), userAgent: globalThis.navigator?.userAgent || '', events: [...events] };
}
