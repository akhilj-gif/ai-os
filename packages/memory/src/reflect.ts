// Reflection job (blueprint §7.2) — the nightly hygiene pass. Basic v1:
//   1. expire records past expires_at (hard delete of dead rows)
//   2. decay: unconfirmed records lose confidence with age
//   3. dedup: near-identical active records (cosine > 0.95) collapse to the
//      highest-confidence one; the rest are superseded (auditable, not deleted)
// Extracting semantic facts from episodic logs is a later, richer pass.
import type pg from 'pg';

const DEDUP_COSINE = 0.95; // cosine similarity above which two memories are "the same"
const DECAY_AFTER_DAYS = 14; // unconfirmed records start decaying after this
const DECAY_PER_RUN = 0.05;
const CONFIDENCE_FLOOR = 0.1; // below this, an unconfirmed record is junk → expire

export interface ReflectionReport {
  expired: number;
  decayed: number;
  deduped: number;
}

export async function runReflection(pool: pg.Pool): Promise<ReflectionReport> {
  // 1. Expire records whose TTL has passed.
  const expired = await pool.query(`DELETE FROM memory_records WHERE expires_at IS NOT NULL AND expires_at <= now()`);

  // 2. Decay confidence for active records not confirmed recently. Preferences the
  //    user explicitly stated decay slower (they carry user_stated provenance).
  const decayed = await pool.query(
    `UPDATE memory_records
     SET confidence = GREATEST(0, confidence - $1)
     WHERE superseded_by IS NULL
       AND last_confirmed_at < now() - ($2 || ' days')::interval
       AND NOT (source->>'user_stated' = 'true' AND type = 'preference')`,
    [DECAY_PER_RUN, DECAY_AFTER_DAYS],
  );

  // 2b. Junk sweep: decayed-to-nothing unconfirmed records expire.
  await pool.query(
    `DELETE FROM memory_records
     WHERE superseded_by IS NULL AND confidence < $1
       AND NOT (source->>'user_stated' = 'true')`,
    [CONFIDENCE_FLOOR],
  );

  // 3. Dedup near-identical active records within each type. Keep the highest
  //    confidence (tie → newest); supersede the rest so the chain stays auditable.
  const dupRows = await pool.query<{ keep: string; drop: string }>(
    `SELECT a.id AS drop, b.id AS keep
     FROM memory_records a
     JOIN memory_records b
       ON a.type = b.type
      AND a.id <> b.id
      AND a.superseded_by IS NULL AND b.superseded_by IS NULL
      AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
      AND (1 - (a.embedding <=> b.embedding)) > $1
      AND (b.confidence > a.confidence OR (b.confidence = a.confidence AND b.created_at > a.created_at))`,
    [DEDUP_COSINE],
  );
  let deduped = 0;
  const alreadyDropped = new Set<string>();
  for (const { keep, drop } of dupRows.rows) {
    if (alreadyDropped.has(drop) || alreadyDropped.has(keep)) continue;
    const res = await pool.query(
      `UPDATE memory_records SET superseded_by = $1 WHERE id = $2 AND superseded_by IS NULL`,
      [keep, drop],
    );
    if ((res.rowCount ?? 0) > 0) {
      deduped++;
      alreadyDropped.add(drop);
    }
  }

  return { expired: expired.rowCount ?? 0, decayed: decayed.rowCount ?? 0, deduped };
}
