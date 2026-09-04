// SSRF regression for the yt-dlp SUBPROCESS sink in video_analyze.
// Run: tsx packages/tools/src/tools/video-ssrf-smoke.ts    (no network, no DB)
//
// THE HOLE THIS PINS. ssrf-guard.ts protects fetch()-based tools: private and
// link-local ranges, IPv6 transition families, resolve-and-check-every-answer,
// and a deliberately uniform refusal message so an injected agent cannot use the
// error text as a hostname oracle. yt-dlp does its networking in ANOTHER
// PROCESS, so none of that applied: `source` went from model-supplied tool args
// straight onto the command line. video_analyze is read-class, so the §8.3
// untrusted latch does not stop a prompt-injected agent from calling it either
// — "summarize this video: http://169.254.169.254/latest/meta-data/" was a
// straight path to cloud metadata and any internal host.
//
// The guard is a PRE-CHECK, not a sandbox: yt-dlp still resolves the name again
// and follows redirects itself. The final case below pins the boundary honestly
// rather than pretending redirect/rebinding are covered.
// video.ts reads AIOS_YTDLP at MODULE LOAD, so it must be set before the import
// or a real yt-dlp runs and the "no network" claim above is false — which is
// exactly what the first version of this file did.
process.env.AIOS_YTDLP = 'aios-ytdlp-that-does-not-exist';
const { videoAnalyze } = await import('./video.js');

let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

const err = async (source: string): Promise<string> => {
  const r = (await videoAnalyze.execute({ source }, {} as never)) as { error?: string };
  return r.error ?? '(no error — THE CALL WENT THROUGH)';
};
const REFUSED = /refused to fetch that URL/i;

console.log('— blocked targets must never reach the subprocess —');
for (const [url, why] of [
  ['http://169.254.169.254/latest/meta-data/', 'cloud metadata (the classic SSRF prize)'],
  ['http://127.0.0.1:4000/health', 'loopback — our own API'],
  ['http://localhost:5432/', 'loopback by name — Postgres'],
  ['http://10.0.0.5/video.mp4', 'RFC1918 private'],
  ['http://192.168.1.1/video.mp4', 'RFC1918 private'],
  ['http://[::1]:4000/', 'IPv6 loopback literal (brackets must be stripped)'],
  ['http://[0:0:0:0:0:ffff:127.0.0.1]/', 'IPv4-mapped IPv6 loopback'],
  ['http://[2002:7f00:1::]/', '6to4-wrapped loopback'],
] as const) {
  check(why, REFUSED.test(await err(url)), url);
}

console.log('\n— non-http schemes must not reach yt-dlp either —');
// These never matched the isUrl test, so they fall to the local-file branch and
// fail there. Asserted so a future widening of isUrl cannot silently open them.
for (const [url, why] of [
  ['file:///etc/passwd', 'file scheme'],
  ['rtsp://10.0.0.5/stream', 'rtsp to a private host'],
] as const) {
  const e = await err(url);
  check(why, /local file not found|refused to fetch/i.test(e), `${url} -> ${e.slice(0, 60)}`);
}

console.log('\n— a public URL must still be ALLOWED through to yt-dlp —');
// The guard must not be a blanket deny. example.com resolves publicly, so the
// call should get PAST the check and die on the missing binary instead.
const publicErr = await err('https://example.com/video.mp4');
check('a public URL passes the guard and reaches the download step', !REFUSED.test(publicErr), publicErr.slice(0, 70));
check('...and the failure is the (deliberately) missing yt-dlp binary', /is yt-dlp installed|ENOENT/i.test(publicErr), publicErr.slice(0, 70));

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
