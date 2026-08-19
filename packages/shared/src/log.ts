// Structured logging (2026-08-15 harness pass). One JSON object per line, so a
// week of logs across six services can be grepped, filtered and JOINED — which
// plain console.log could not do.
//
// WHY THIS EXISTS. There were ~145 bare console.* calls across the services and
// no way to answer the only question that matters during an incident: "the user
// says chat broke at 3pm — what actually happened?" The data to answer it was
// already being written (every task persists trace_events and steps keyed by
// trace_id) but the LOG side had no correlation id at all, so a log line could
// never be tied to the task that produced it. Every field below exists to make
// that join possible:
//
//   ts       ISO timestamp, sortable and mergeable across files
//   level    debug|info|warn|error — filter noise without losing it
//   svc      which process wrote it (api, kernel, bridge, …)
//   evt      a STABLE dotted event name (chat.start, tool.blocked) — grep by
//            what happened, not by prose that changes when someone edits a string
//   traceId  the join key to trace_events/steps and to other services
//   taskId   the join key to tasks
//   ms       duration, when the event closes something timed
//   err      message + stack, flattened (a raw Error JSON.stringifies to "{}")
//
// Secrets are redacted by @ai-os/trust's broker at the AUDIT boundary; logs must
// not carry credentials in the first place, so pass ids and counts, not payloads.
//
// Deliberately not pino/winston: this is ~60 lines, has no dependency, and
// writing a JSON line to stdout is exactly what pm2 already captures and
// pm2-logrotate already rotates.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** AIOS_LOG_LEVEL gates output; default info. Set debug when reproducing. */
function threshold(): number {
  const raw = (process.env.AIOS_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return ORDER[raw] ?? ORDER.info;
}

/** AIOS_LOG_PRETTY=1 prints human-readable lines instead of JSON — for a live
 *  terminal. Machines get JSON; humans get columns. */
function pretty(): boolean {
  return process.env.AIOS_LOG_PRETTY === '1';
}

export interface LogFields {
  traceId?: string;
  taskId?: string;
  ms?: number;
  err?: unknown;
  [key: string]: unknown;
}

/** Errors do not survive JSON.stringify — `{}` is the classic lost-stack bug. */
function flattenErr(e: unknown): { message: string; stack?: string } | undefined {
  if (e === undefined || e === null) return undefined;
  if (e instanceof Error) return { message: e.message, stack: e.stack?.split('\n').slice(0, 4).join('\n') };
  return { message: String(e) };
}

function emit(level: LogLevel, svc: string, evt: string, fields: LogFields = {}): void {
  if (ORDER[level] < threshold()) return;
  const { err, ...rest } = fields;
  const rec = { ts: new Date().toISOString(), level, svc, evt, ...rest, ...(err !== undefined ? { err: flattenErr(err) } : {}) };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (pretty()) {
    const extra = Object.entries(rest)
      .filter(([k]) => k !== 'traceId' && k !== 'taskId')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
    const tid = rec.traceId ? ` trace=${String(rec.traceId).slice(0, 8)}` : '';
    const e = rec.err ? ` err="${(rec.err as { message: string }).message}"` : '';
    out.write(`${level.toUpperCase().padEnd(5)} ${svc.padEnd(8)} ${evt.padEnd(24)}${tid} ${extra}${e}\n`);
    return;
  }
  out.write(JSON.stringify(rec) + '\n');
}

/** A logger bound to one service name, so call sites stay short. */
export function logger(svc: string) {
  return {
    debug: (evt: string, f?: LogFields) => emit('debug', svc, evt, f),
    info: (evt: string, f?: LogFields) => emit('info', svc, evt, f),
    warn: (evt: string, f?: LogFields) => emit('warn', svc, evt, f),
    error: (evt: string, f?: LogFields) => emit('error', svc, evt, f),
    /** Time an operation and log its outcome once, with ms and err populated. */
    async timed<T>(evt: string, f: LogFields, fn: () => Promise<T>): Promise<T> {
      const t0 = Date.now();
      try {
        const out = await fn();
        emit('info', svc, evt, { ...f, ms: Date.now() - t0 });
        return out;
      } catch (err) {
        emit('error', svc, evt, { ...f, ms: Date.now() - t0, err });
        throw err;
      }
    },
  };
}

export type Logger = ReturnType<typeof logger>;
