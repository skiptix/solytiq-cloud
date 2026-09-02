// ---------------------------------------------------------------------------
// The microphone + playback engine behind Sol's voice mode.
//
// Owns four things the UI should not have to think about: getting microphone
// permission, recording one utterance, playing back a synthesized reply, and
// exposing a live amplitude signal for the waveform. Everything here is
// imperative on purpose — see `levelRef` below for why.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiTranscribeAudio, apiSpeakText } from '../../api/client';

export type VoicePhase = 'idle' | 'requesting' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

/**
 * Containers we'll ask `MediaRecorder` for, best first.
 *
 * This list is why voice input works on an iPhone at all: Chrome/Firefox/
 * Android record Opus-in-WebM and Safari/iOS records AAC-in-MP4, and neither
 * can produce the other's. Both are in the backend's format allow-list
 * (`audioFormatFromMime` in aiVoice.ts), so whichever the browser picks is
 * transcribable. An empty string means "let the browser decide" — the last
 * resort for a browser that rejects every explicit type but still records.
 */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  '',
];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const t of PREFERRED_MIME_TYPES) {
    if (!t) return '';
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

/** Feature detection, never UA sniffing — same rule the push layer follows.
 *  Note both halves are required: a browser can have `getUserMedia` and no
 *  `MediaRecorder` (older iOS), which would fail only at record time. */
export function isVoiceSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';
}

export interface VoiceSessionOptions {
  /**
   * Called with the transcript once an utterance has been recognized.
   *
   * RETURN a string to have it spoken back, or nothing to stay silent. That
   * return value is what keeps this hook self-contained: the alternative —
   * handing the caller a `speak` function to call from inside its own
   * `onTranscript` — is a forward reference into the very hook being
   * constructed, which works only because the call happens to be async.
   * Voice-only mode returns the assistant's reply here; hybrid dictation
   * returns nothing, because it only fills the composer.
   */
  onTranscript: (text: string) => void | string | Promise<void | string>;
  onError?: (message: string) => void;
  sessionId?: string | null;
}

export interface VoiceSession {
  phase: VoicePhase;
  error: string | null;
  /** True once the user has denied the mic. Irreversible from JS — the browser
   *  will not re-prompt — so the UI must say so rather than offer a button
   *  that can no longer do anything. Same one-shot reality as push permission. */
  permissionDenied: boolean;
  /**
   * Live input/output amplitude, 0..1, updated every animation frame by
   * whoever is driving the waveform.
   *
   * A REF, not state, and that is the whole point: the waveform samples this
   * ~60 times a second, and routing it through `setState` would re-render the
   * overlay 60 times a second — the exact per-frame-React-state mistake the
   * Net's force simulation exists to avoid (see NeuralGraph). Consumers read
   * `.current` inside a `useFrameLoop` callback and write straight to the DOM.
   */
  levelRef: React.RefObject<number>;
  /** The analyser currently producing `levelRef`, or null when nothing is
   *  making sound. Exposed so a waveform can read the full frequency band
   *  rather than just the scalar level. */
  analyserRef: React.RefObject<AnalyserNode | null>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  speak: (text: string) => Promise<void>;
  /** Stops everything immediately — recording, playback, and the mic stream. */
  cancel: () => void;
  setPhase: (p: VoicePhase) => void;
}

export default function useVoiceSession({ onTranscript, onError, sessionId }: VoiceSessionOptions): VoiceSession {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const levelRef = useRef(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // Guards every async continuation: a component that unmounted (or a session
  // the user cancelled) must not resume into setState or start playback.
  const aliveRef = useRef(true);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const fail = useCallback((msg: string) => {
    setError(msg);
    onErrorRef.current?.(msg);
  }, []);

  /**
   * One AudioContext for the whole session, created lazily inside a user
   * gesture. iOS starts every context `suspended` and only a gesture can
   * resume it — creating this at mount instead would leave a permanently
   * silent assistant on exactly the platform voice mode defaults to.
   */
  const ensureAudioContext = useCallback((): AudioContext | null => {
    try {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new Ctor();
      }
      if (audioCtxRef.current.state === 'suspended') void audioCtxRef.current.resume();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    levelRef.current = 0;
  }, []);

  const stopPlayback = useCallback(() => {
    const el = audioElRef.current;
    if (el) {
      el.pause();
      el.src = '';
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    try {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    } catch { /* already stopped */ }
    recorderRef.current = null;
    chunksRef.current = [];
    releaseStream();
    stopPlayback();
    setPhase('idle');
  }, [releaseStream, stopPlayback]);

  // Tear everything down on unmount: an orphaned MediaStream keeps the OS
  // recording indicator lit long after the overlay is gone.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      try {
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      } catch { /* already stopped */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const el = audioElRef.current;
      if (el) { el.pause(); el.src = ''; }
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  /** Wires an analyser onto a source and starts feeding `levelRef` from it. */
  const attachAnalyser = useCallback((connect: (ctx: AudioContext, analyser: AnalyserNode) => void) => {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const analyser = ctx.createAnalyser();
    // 512 is enough resolution for a 32-bar visualiser and cheap to sample
    // every frame; smoothing keeps neighbouring frames from flickering.
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    try {
      connect(ctx, analyser);
      analyserRef.current = analyser;
    } catch {
      analyserRef.current = null;
    }
  }, [ensureAudioContext]);

  const startListening = useCallback(async () => {
    if (!isVoiceSupported()) {
      fail('This browser cannot record audio.');
      return;
    }
    setError(null);
    setPhase('requesting');
    let stream: MediaStream;
    try {
      // The browser's own permission prompt fires here, on first use — there
      // is no separate "ask" call to make.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setPermissionDenied(true);
        fail('Microphone access was blocked. Allow it in your browser settings to talk to Sol.');
      } else if (name === 'NotFoundError') {
        fail('No microphone was found on this device.');
      } else {
        fail('Could not start the microphone.');
      }
      setPhase('idle');
      return;
    }
    if (!aliveRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = stream;
    attachAnalyser((ctx, analyser) => ctx.createMediaStreamSource(stream).connect(analyser));

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      releaseStream();
      fail('This browser cannot record audio.');
      setPhase('idle');
      return;
    }
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorderRef.current = recorder;
    recorder.start();
    setPhase('listening');
  }, [attachAnalyser, fail, releaseStream]);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) { setPhase('idle'); return; }
    setPhase('speaking');
    let url: string;
    try {
      url = await apiSpeakText(text, sessionId);
    } catch (err) {
      if (!aliveRef.current) return;
      // A failed synthesis must not read as a failed CONVERSATION — the reply
      // itself succeeded and (in hybrid mode) is on screen. Report it, then
      // return to idle rather than stranding the UI mid-turn.
      fail(err instanceof Error ? err.message : 'Could not play that reply.');
      setPhase('idle');
      return;
    }
    if (!aliveRef.current) { URL.revokeObjectURL(url); return; }

    stopPlayback();
    objectUrlRef.current = url;

    let el = audioElRef.current;
    if (!el) {
      el = new Audio();
      // Keeps iOS from routing playback to the earpiece and from taking over
      // the lock screen as if this were a media session.
      el.preload = 'auto';
      audioElRef.current = el;
      // The element↔analyser wiring is done ONCE per element: a second
      // createMediaElementSource on the same element throws, and the graph
      // survives every subsequent src swap anyway.
      attachAnalyser((ctx, analyser) => {
        const src = ctx.createMediaElementSource(el as HTMLAudioElement);
        src.connect(analyser);
        // An element pulled into a Web Audio graph no longer reaches the
        // speakers on its own — without this the reply plays silently.
        analyser.connect(ctx.destination);
      });
    }
    el.src = url;

    await new Promise<void>((resolve) => {
      const done = () => {
        el?.removeEventListener('ended', done);
        el?.removeEventListener('error', done);
        resolve();
      };
      el?.addEventListener('ended', done);
      el?.addEventListener('error', done);
      void el?.play().catch(() => done());
    });

    if (!aliveRef.current) return;
    stopPlayback();
    setPhase('idle');
  }, [attachAnalyser, fail, sessionId, stopPlayback]);

  const stopListening = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;

    // `stop()` is async by event, and the final `dataavailable` lands BEFORE
    // `stop` — so the blob is only complete once `onstop` fires. Awaiting the
    // event is what stops the last fraction of a second being cut off.
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
      try { recorder.stop(); } catch { resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })); }
    });
    recorderRef.current = null;
    chunksRef.current = [];
    releaseStream();
    if (!aliveRef.current) return;

    // A tap-start/tap-stop that lands in under a heartbeat is a misfire, not
    // an utterance. Sending it would cost a transcription call to be told the
    // user said nothing — and then Sol would answer that nothing.
    if (blob.size < 1200) {
      setPhase('idle');
      return;
    }

    setPhase('transcribing');
    // Transcription and the turn it feeds are caught SEPARATELY so the error
    // the user sees is true: "I couldn't understand that" is the wrong thing
    // to say when the words were heard perfectly and the assistant is what
    // failed, and sending someone back to repeat themselves for a fault that
    // was never theirs is the most frustrating way to get an error wrong.
    let text: string;
    try {
      text = (await apiTranscribeAudio(blob, sessionId)).trim();
    } catch (err) {
      if (!aliveRef.current) return;
      fail(err instanceof Error ? err.message : 'Could not understand that.');
      setPhase('idle');
      return;
    }
    if (!aliveRef.current) return;
    if (!text) { setPhase('idle'); return; }

    setPhase('thinking');
    try {
      // A returned string is the reply to speak. Doing the playback here
      // rather than in the caller is what lets the caller stay a plain
      // "given words, produce words" function with no audio knowledge.
      const reply = await onTranscriptRef.current(text);
      if (!aliveRef.current) return;
      if (typeof reply === 'string' && reply.trim()) await speak(reply);
      else setPhase('idle');
    } catch (err) {
      if (!aliveRef.current) return;
      fail(err instanceof Error ? err.message : 'Something went wrong answering that.');
      setPhase('idle');
    }
  }, [fail, releaseStream, sessionId, speak]);

  return {
    phase, error, permissionDenied,
    levelRef, analyserRef,
    startListening, stopListening, speak, cancel, setPhase,
  };
}
