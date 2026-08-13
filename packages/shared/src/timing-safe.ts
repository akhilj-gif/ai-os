// Constant-time secret comparison (2026-08-12, sharp-edges hunt). The API and
// both bridges compared shared-secret tokens with `!==`, a textbook timing
// side-channel. Real-world exploitability is low here (every check binds
// loopback-only), but the fix is one line per site, so there's no reason to
// leave it. node:crypto's timingSafeEqual REQUIRES equal-length buffers (it
// throws otherwise) — comparing an attacker-controlled length against itself
// on mismatch keeps the operation itself constant-time without leaking length.
import { timingSafeEqual } from 'node:crypto';

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // constant-time no-op — never skip straight to `false`
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
