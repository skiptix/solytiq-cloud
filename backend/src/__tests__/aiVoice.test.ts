// ---------------------------------------------------------------------------
// Sol Voice Mode — the two pure functions everything else depends on.
//
// No database and no network: `prepareSpeechText` and `audioFormatFromMime`
// are deliberately side-effect-free precisely so they can be pinned here.
// Both are load-bearing in ways a manual test would not catch:
//
//   - `audioFormatFromMime` is the ONLY thing making voice input work on an
//     iPhone. Safari records `audio/mp4` where Chrome records `audio/webm`;
//     drop the mp4 mapping and the feature silently stops working on the one
//     platform where voice mode is the DEFAULT.
//   - `prepareSpeechText` is the difference between a usable assistant and one
//     that reads "asterisk asterisk Done asterisk asterisk" out loud.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { audioFormatFromMime, prepareSpeechText, MAX_SPEECH_CHARS, VOICE_DEFAULTS } from '../aiVoice';

describe('audioFormatFromMime', () => {
  it('maps what a real MediaRecorder actually produces, codec parameters and all', () => {
    // Chrome / Firefox / Android.
    expect(audioFormatFromMime('audio/webm;codecs=opus')).toBe('webm');
    expect(audioFormatFromMime('audio/webm')).toBe('webm');
    // Safari / iOS — the case the whole mobile default rests on.
    expect(audioFormatFromMime('audio/mp4')).toBe('m4a');
    expect(audioFormatFromMime('audio/mp4;codecs=mp4a.40.2')).toBe('m4a');
    expect(audioFormatFromMime('audio/x-m4a')).toBe('m4a');
    // Everything else the API accepts.
    expect(audioFormatFromMime('audio/ogg;codecs=opus')).toBe('ogg');
    expect(audioFormatFromMime('audio/wav')).toBe('wav');
    expect(audioFormatFromMime('audio/mpeg')).toBe('mp3');
    expect(audioFormatFromMime('audio/aac')).toBe('aac');
    expect(audioFormatFromMime('audio/flac')).toBe('flac');
  });

  it('is case- and whitespace-insensitive, since the header is not ours to control', () => {
    expect(audioFormatFromMime('AUDIO/WEBM; codecs=OPUS')).toBe('webm');
    expect(audioFormatFromMime('  audio/mp4  ')).toBe('m4a');
  });

  it('rejects anything that is not audio — this doubles as the upload filter', () => {
    // routes/ai.ts uses this same function as multer's fileFilter, so a null
    // here is what stops a .zip or an image being buffered at all.
    expect(audioFormatFromMime('application/zip')).toBeNull();
    expect(audioFormatFromMime('image/png')).toBeNull();
    expect(audioFormatFromMime('audio/midi')).toBeNull();
    expect(audioFormatFromMime('')).toBeNull();
    expect(audioFormatFromMime(undefined)).toBeNull();
    expect(audioFormatFromMime(null)).toBeNull();
  });
});

describe('prepareSpeechText', () => {
  it('strips emphasis rather than reading it aloud', () => {
    expect(prepareSpeechText('**Done!** That is _now_ ~~not~~ complete.'))
      .toBe('Done! That is now not complete.');
  });

  it('leaves an identifier the model quoted intact', () => {
    // The reason single-underscore stripping is word-boundary-anchored: a
    // reply mentioning a real field name must not become "sectionid".
    expect(prepareSpeechText('Set the section_id field.')).toBe('Set the section_id field.');
    expect(prepareSpeechText('The voice is af_heart.')).toBe('The voice is af_heart.');
  });

  it('strips headings, quotes and list bullets', () => {
    const out = prepareSpeechText('## Today\n- Buy milk\n- Call Ana\n1. First\n> A quote');
    expect(out).not.toMatch(/[#>*]/);
    expect(out).toContain('Buy milk');
    expect(out).toContain('Call Ana');
    expect(out).toContain('First');
    expect(out).toContain('A quote');
  });

  it('speaks a link’s label, never its URL', () => {
    const out = prepareSpeechText('See [the roadmap](https://example.com/a/very/long/path?x=1).');
    expect(out).toBe('See the roadmap.');
    expect(out).not.toContain('http');
  });

  it('speaks an image’s alt text and drops the source', () => {
    expect(prepareSpeechText('![a bar chart](data:image/png;base64,AAAA)')).toBe('a bar chart');
  });

  it('collapses an inline entity chip to its label', () => {
    expect(prepareSpeechText('I moved [[task:1751293847221|Ship the release]] to Doing.'))
      .toBe('I moved Ship the release to Doing.');
  });

  it('summarizes a code block instead of dictating it', () => {
    const out = prepareSpeechText('Try:\n```ts\nconst x = 1;\nconst y = 2;\n```\nthat should work.');
    expect(out).toContain('(ts code block)');
    expect(out).not.toContain('const x');
  });

  it('reads a table as prose and drops its separator row', () => {
    const out = prepareSpeechText('| Task | Due |\n| --- | --- |\n| Invoice | Friday |');
    expect(out).toContain('Task, Due');
    expect(out).toContain('Invoice, Friday');
    expect(out).not.toContain('|');
    expect(out).not.toContain('---');
  });

  it('truncates on a sentence boundary rather than mid-word', () => {
    const sentence = 'This is a complete sentence about the project. ';
    const out = prepareSpeechText(sentence.repeat(120));
    expect(out.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(out.endsWith('.')).toBe(true);
  });

  it('still truncates when there is no sentence boundary to fall back on', () => {
    const out = prepareSpeechText('word '.repeat(2000));
    expect(out.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(out.length).toBeGreaterThan(0);
  });

  it('leaves ordinary spoken prose untouched', () => {
    const plain = 'You have three things due today: the tax return, the client call, and the invoice.';
    expect(prepareSpeechText(plain)).toBe(plain);
  });

  it('returns empty for content that is nothing but markup', () => {
    // synthesizeSpeech treats an empty result as a 400 rather than paying for
    // a synthesis call that would produce silence.
    expect(prepareSpeechText('---')).toBe('');
    expect(prepareSpeechText('   ')).toBe('');
    expect(prepareSpeechText('')).toBe('');
  });

  it('survives a null/undefined body without throwing', () => {
    expect(prepareSpeechText(undefined as unknown as string)).toBe('');
  });
});

describe('VOICE_DEFAULTS', () => {
  it('defaults to a female voice, which is the documented product requirement', () => {
    // Kokoro's `af_` prefix is literally "American Female" — a rename here
    // would silently change the assistant's voice for every instance that
    // never overrode it in Settings.
    expect(VOICE_DEFAULTS.ttsVoice.startsWith('af_')).toBe(true);
    expect(VOICE_DEFAULTS.ttsModel).toBe('hexgrad/kokoro-82m');
    expect(VOICE_DEFAULTS.sttModel).toContain('transcribe');
  });
});
