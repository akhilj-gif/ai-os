// M12d VAD smoke — deterministic, no browser, no audio (ADR-0015). Proves the
// conversation-mode state decisions: silence never sends, trailing silence
// ends an utterance, speech resets the silence clock, hard caps hold.
// Run: npx tsx apps/voice/src/lib/vad-smoke.ts
import { vadDecision, isSpeech, rmsFromByteTimeDomain, VAD_DEFAULTS } from './vad.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

console.log('— vadDecision —');
check('just armed → continue', vadDecision({ sawSpeech: false, sinceSpeechMs: 0, sinceStartMs: 100 }) === 'continue');
check('silence under timeout → continue', vadDecision({ sawSpeech: false, sinceSpeechMs: 0, sinceStartMs: 7900 }) === 'continue');
check('never any speech → abort (send NOTHING)', vadDecision({ sawSpeech: false, sinceSpeechMs: 0, sinceStartMs: 8000 }) === 'abort-silent');
check('speaking → continue', vadDecision({ sawSpeech: true, sinceSpeechMs: 200, sinceStartMs: 3000 }) === 'continue');
check('short pause mid-sentence → continue', vadDecision({ sawSpeech: true, sinceSpeechMs: 1300, sinceStartMs: 5000 }) === 'continue');
check('trailing silence after speech → end utterance', vadDecision({ sawSpeech: true, sinceSpeechMs: 1400, sinceStartMs: 5000 }) === 'end-utterance');
check('speech resets the silence clock (fresh speech continues)', vadDecision({ sawSpeech: true, sinceSpeechMs: 0, sinceStartMs: 59_000 }) === 'continue');
check('hard cap with speech → end (still sends)', vadDecision({ sawSpeech: true, sinceSpeechMs: 100, sinceStartMs: 60_000 }) === 'end-maxlen');
check('hard cap without speech → abort', vadDecision({ sawSpeech: false, sinceSpeechMs: 0, sinceStartMs: 60_000 }) === 'abort-silent');

console.log('\n— isSpeech / rms —');
check('threshold boundary: at speechRms counts as speech', isSpeech(VAD_DEFAULTS.speechRms) && !isSpeech(VAD_DEFAULTS.speechRms - 0.001));
{
  const silent = new Uint8Array(512).fill(128); // perfectly flat = silence
  check('flat buffer → rms 0', rmsFromByteTimeDomain(silent) === 0);
  const loud = new Uint8Array(512);
  for (let i = 0; i < loud.length; i++) loud[i] = i % 2 === 0 ? 28 : 228; // full swing
  check('full-swing buffer → loud rms', rmsFromByteTimeDomain(loud) > 0.7, String(rmsFromByteTimeDomain(loud).toFixed(3)));
  const whisper = new Uint8Array(512);
  for (let i = 0; i < whisper.length; i++) whisper[i] = i % 2 === 0 ? 127 : 129; // ±1/128 ≈ mic noise floor
  check('mic noise floor stays below the speech threshold', !isSpeech(rmsFromByteTimeDomain(whisper)), String(rmsFromByteTimeDomain(whisper).toFixed(4)));
  check('empty buffer → 0 (no crash)', rmsFromByteTimeDomain(new Uint8Array(0)) === 0);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
