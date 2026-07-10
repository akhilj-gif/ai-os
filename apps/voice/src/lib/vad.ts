// M12d — hands-free conversation mode (ADR-0015): the voice-activity decision
// logic, kept PURE so it is deterministically testable (vad-smoke.ts). The
// hook feeds it rms samples from a WebAudio AnalyserNode; this module decides
// when an utterance ends. Failure mode is always discard-not-send: a silent
// arming aborts without transcribing anything.

export interface VadConfig {
  /** rms (0..1) above this counts as speech. Tuned for a near-field laptop mic. */
  speechRms: number;
  /** utterance ends after this much trailing silence (once speech was heard) */
  trailingSilenceMs: number;
  /** never heard speech at all for this long → abort, send nothing */
  noSpeechTimeoutMs: number;
  /** hard cap per utterance */
  maxUtteranceMs: number;
}

export const VAD_DEFAULTS: VadConfig = {
  speechRms: 0.015,
  trailingSilenceMs: 1400,
  noSpeechTimeoutMs: 8000,
  maxUtteranceMs: 60_000,
};

export type VadVerdict = 'continue' | 'end-utterance' | 'abort-silent' | 'end-maxlen';

export interface VadSample {
  /** any speech heard since arming? */
  sawSpeech: boolean;
  /** ms since the LAST speech sample (meaningless when !sawSpeech) */
  sinceSpeechMs: number;
  /** ms since arming */
  sinceStartMs: number;
}

export function isSpeech(rms: number, cfg: VadConfig = VAD_DEFAULTS): boolean {
  return rms >= cfg.speechRms;
}

export function vadDecision(s: VadSample, cfg: VadConfig = VAD_DEFAULTS): VadVerdict {
  if (s.sinceStartMs >= cfg.maxUtteranceMs) return s.sawSpeech ? 'end-maxlen' : 'abort-silent';
  if (!s.sawSpeech) return s.sinceStartMs >= cfg.noSpeechTimeoutMs ? 'abort-silent' : 'continue';
  return s.sinceSpeechMs >= cfg.trailingSilenceMs ? 'end-utterance' : 'continue';
}

/** rms of a getByteTimeDomainData buffer (bytes are 128-centered). */
export function rmsFromByteTimeDomain(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / bytes.length);
}
