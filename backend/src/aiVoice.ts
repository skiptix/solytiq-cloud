// ---------------------------------------------------------------------------
// Sol Voice Mode — the OpenRouter audio layer (speech-to-text + text-to-speech).
//
// WHY THIS IS SERVER-SIDE, AND NOT THE BROWSER'S OWN Web Speech API
// -----------------------------------------------------------------
// The obvious cheap implementation of voice input is `webkitSpeechRecognition`
// plus `speechSynthesis` — zero backend, zero cost. It was rejected on a hard
// platform fact, not on taste: **Web Speech API recognition does not work in an
// installed iOS PWA.** It works in a Safari *tab* and stops working the moment
// the same site is launched from the Home Screen. This app ships a manifest, a
// service worker and a `homescreen_connections` table precisely so people run
// it from the Home Screen (see "Home Screen Install" in CLAUDE.md), and mobile
// is exactly where voice mode is the DEFAULT — so that approach would have been
// broken in the one place it matters most, while appearing to work everywhere
// a developer would casually test it. Firefox has no recognition support at
// all, and `speechSynthesis` offers no control over which voice is installed
// on the listener's OS, so "use a female voice" would be unenforceable too.
//
// Routing both directions through OpenRouter's audio endpoints instead gives
// one implementation that behaves identically on every platform, reuses the
// key/billing/settings plumbing the chat proxy already has, and keeps the API
// key server-side exactly like `/api/ai/chat` does.
//
// WHY IT IS A PIPELINE AND NOT A "VOICE MODEL"
// --------------------------------------------
// OpenRouter exposes discrete `/audio/transcriptions` and `/audio/speech`
// endpoints, not a realtime speech-to-speech socket. That constraint turns out
// to be the feature: voice mode is STT -> *the existing chat tool-calling loop,
// untouched* -> TTS, so every tool, skill, memory entry and Knowledge Base
// lookup works in voice exactly as it does in text BY CONSTRUCTION rather than
// by a second implementation that has to be kept in sync. A speech-to-speech
// model would have meant a parallel tool-calling path — the one thing this
// codebase's shared-registry convention exists to avoid.
// ---------------------------------------------------------------------------
import { query } from './db';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Defaults chosen from the live OpenRouter catalog:
 *
 * - `hexgrad/kokoro-82m` is the cheapest TTS on the platform by a wide margin
 *   ($0.00000062/unit, ~40x under the next tier) and its `af_*` voices are
 *   purpose-built American Female voices — `af_heart` is the warm, natural one.
 *   A voice assistant talks a LOT, so per-unit cost compounds faster here than
 *   anywhere else in the app.
 * - `openai/gpt-4o-mini-transcribe` is the accuracy-per-cent sweet spot for
 *   short conversational utterances, which is all this ever sends it.
 *
 * All four are admin-overridable in Settings → AI, so an operator who wants
 * a different voice or a self-hosted-friendly free tier never edits code.
 */
export const VOICE_DEFAULTS = {
  ttsModel: 'hexgrad/kokoro-82m',
  ttsVoice: 'af_heart',
  sttModel: 'openai/gpt-4o-mini-transcribe',
} as const;

export interface VoiceSettings {
  enabled: boolean;
  ttsModel: string;
  ttsVoice: string;
  sttModel: string;
}

/** Reads the current voice settings fresh — same "no cached feature flag to
 *  drift out of sync with reality" contract `email/resendClient.ts` holds. */
export async function getVoiceSettings(): Promise<VoiceSettings> {
  const result = await query<{ key: string; value: string }>(
    "SELECT key, value FROM app_settings WHERE key IN ('ai_voice_enabled', 'ai_tts_model', 'ai_tts_voice', 'ai_stt_model')"
  );
  const s: Record<string, string> = {};
  for (const row of result.rows) s[row.key] = row.value;
  return {
    // Absent ⇒ on. Voice rides the same OPENROUTER_API_KEY the assistant
    // already needs, so there is nothing extra for an operator to enable
    // before it works; the toggle exists to turn it OFF (cost control).
    enabled: s['ai_voice_enabled'] !== 'false',
    ttsModel: s['ai_tts_model']?.trim() || VOICE_DEFAULTS.ttsModel,
    ttsVoice: s['ai_tts_voice']?.trim() || VOICE_DEFAULTS.ttsVoice,
    sttModel: s['ai_stt_model']?.trim() || VOICE_DEFAULTS.sttModel,
  };
}

/**
 * The audio container names OpenRouter's transcription endpoint accepts.
 * `MediaRecorder` gives us different ones per platform and there is no
 * negotiating with it: Chrome/Firefox/Android produce `audio/webm;codecs=opus`
 * while Safari/iOS produce `audio/mp4`. Both are in this map, which is the
 * whole reason recording works on an iPhone at all.
 */
const MIME_TO_FORMAT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/**
 * Maps a browser-supplied MIME type to an OpenRouter audio format, or null if
 * it is not an audio type we accept.
 *
 * Pure — the codec parameters (`;codecs=opus`) and any charset suffix are
 * stripped before lookup, since `MediaRecorder.mimeType` always carries them
 * and the API wants the bare container name.
 */
export function audioFormatFromMime(mime: string | undefined | null): string | null {
  if (!mime) return null;
  const base = mime.split(';')[0].trim().toLowerCase();
  return MIME_TO_FORMAT[base] ?? null;
}

/** Longest utterance we will synthesize in one call. A spoken reply past this
 *  is not a reply, it's a lecture — and every character costs. Sol is told to
 *  keep voice answers short (see the voice system-prompt addendum), so hitting
 *  this cap is the exception, not the rule. */
export const MAX_SPEECH_CHARS = 1800;

/**
 * Turns an assistant message into something worth listening to.
 *
 * The model writes Markdown, and a TTS engine reads Markdown literally —
 * "asterisk asterisk Done asterisk asterisk", every bullet as "hyphen", every
 * link as its full URL. Stripping it is not cosmetic: unstripped output is the
 * difference between a usable voice assistant and an unusable one.
 *
 * Pure and unit-tested. Truncation prefers the last sentence boundary inside
 * the budget so a capped reply ends on a full thought rather than mid-word.
 */
export function prepareSpeechText(raw: string): string {
  let t = raw ?? '';

  // Fenced code blocks: read the language, not 200 lines of syntax.
  t = t.replace(/```(\w+)?[\s\S]*?```/g, (_m, lang) => (lang ? ` (${lang} code block) ` : ' (code block) '));
  t = t.replace(/`([^`]+)`/g, '$1');
  // Images before links — an image's alt text is the only speakable part.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Inline entity chips ([[task:123|Ship it]]) speak as their label.
  t = t.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1');
  t = t.replace(/\[\[([^\]]+)\]\]/g, '$1');
  // Emphasis / headings / quotes / rules / list bullets.
  // Single `_` emphasis is matched only when the underscores sit OUTSIDE word
  // characters, exactly as Markdown itself requires. Stripping every `_` would
  // turn an identifier the model quoted (`section_id`, `af_heart`) into a
  // mispronounced run-on word — which is worse than leaving one stray
  // underscore in, since the identifier is usually the part that matters.
  t = t.replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1');
  t = t.replace(/(\*\*\*|\*\*|\*|___|__|~~)/g, '');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*?$/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');
  // Table pipes read as nothing useful; keep the cell text.
  t = t.replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) =>
    /^[\s|:-]+$/.test(row) ? '' : row.split('|').map((c) => c.trim()).filter(Boolean).join(', ')
  );
  // Collapse whitespace last, after every rule above has left its gaps.
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

  if (t.length <= MAX_SPEECH_CHARS) return t;
  const clipped = t.slice(0, MAX_SPEECH_CHARS);
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  return (lastStop > MAX_SPEECH_CHARS * 0.5 ? clipped.slice(0, lastStop + 1) : clipped).trim();
}

function apiKey(): string {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) throw new VoiceError('OPENROUTER_API_KEY is not configured', 503);
  return k;
}

export class VoiceError extends Error {
  constructor(message: string, readonly status: number, readonly details?: string) {
    super(message);
    this.name = 'VoiceError';
  }
}

const OR_HEADERS = () => ({
  Authorization: `Bearer ${apiKey()}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': process.env.FRONTEND_URL ?? 'http://localhost',
  'X-Title': 'Solytiq Cloud',
});

/** Same `AbortSignal`-on-a-timer convention as the chat proxy and the GPS
 *  route planner — no new HTTP client, no new dependency. Kept well under the
 *  chat proxy's 90s because a voice turn that takes 60s has already failed as
 *  a conversation regardless of what the API eventually returns. */
async function orFetch(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${OPENROUTER_BASE}${path}`, {
      method: 'POST',
      headers: OR_HEADERS(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new VoiceError('The audio service timed out', 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface TranscriptionResult {
  text: string;
  seconds?: number;
}

/**
 * Speech → text. Sends raw base64 (never a `data:` URI — the API rejects the
 * prefix) rather than multipart, so the same code path works regardless of
 * which container the recording browser chose.
 */
export async function transcribeAudio(
  audio: Buffer,
  mimeType: string | undefined,
  opts: { model: string; language?: string }
): Promise<TranscriptionResult> {
  const format = audioFormatFromMime(mimeType);
  if (!format) throw new VoiceError(`Unsupported audio format: ${mimeType ?? 'unknown'}`, 400);

  const res = await orFetch('/audio/transcriptions', {
    model: opts.model,
    input_audio: { data: audio.toString('base64'), format },
    ...(opts.language ? { language: opts.language } : {}),
  }, 60000);

  if (!res.ok) {
    const details = await res.text().catch(() => `HTTP ${res.status}`);
    console.error('OpenRouter transcription error:', res.status, details);
    throw new VoiceError('Transcription failed', 502, details);
  }
  const data = await res.json() as { text?: string; usage?: { seconds?: number } };
  return { text: (data.text ?? '').trim(), seconds: data.usage?.seconds };
}

export interface SpeechResult {
  audio: Buffer;
  contentType: string;
}

/**
 * Text → speech. Asks for `mp3` explicitly: the endpoint defaults to raw
 * `pcm`, which an `<audio>` element cannot play without the client
 * reassembling a WAV header first.
 */
export async function synthesizeSpeech(
  text: string,
  opts: { model: string; voice: string }
): Promise<SpeechResult> {
  const input = prepareSpeechText(text);
  if (!input) throw new VoiceError('Nothing to speak', 400);

  const res = await orFetch('/audio/speech', {
    model: opts.model,
    input,
    voice: opts.voice,
    response_format: 'mp3',
  }, 60000);

  if (!res.ok) {
    const details = await res.text().catch(() => `HTTP ${res.status}`);
    console.error('OpenRouter speech error:', res.status, details);
    throw new VoiceError('Speech synthesis failed', 502, details);
  }
  // The response is raw binary audio, not JSON — see the endpoint docs.
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new VoiceError('Speech synthesis returned no audio', 502);
  return { audio: buf, contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
}
