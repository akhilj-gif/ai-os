// Google Calendar read tool. Default window = "today" in the user's timezone
// (AIOS_TZ, default Asia/Kolkata).
import type { ToolDef } from '../registry.js';
import { googleApi } from '../google.js';

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
  return asUTC - date.getTime();
}

/** [start, end) of the current calendar day in tz, as ISO instants. */
export function todayRange(tz: string): { timeMin: string; timeMax: string } {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const [y, m, d] = dtf.format(now).split('-').map(Number);
  const offset = tzOffsetMs(tz, now);
  const startMs = Date.UTC(y!, m! - 1, d!) - offset;
  return {
    timeMin: new Date(startMs).toISOString(),
    timeMax: new Date(startMs + 24 * 3600 * 1000).toISOString(),
  };
}

interface GEvent {
  id: string;
  summary?: string;
  status?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
}

export const calendarList: ToolDef = {
  name: 'calendar_list',
  untrustedOutput: true, // event titles/descriptions are attacker-controllable (§8.3)
  description:
    "List events on the user's primary Google Calendar. Defaults to today in the user's timezone if no range is given.",
  inputSchema: {
    type: 'object',
    properties: {
      timeMin: { type: 'string', description: 'ISO 8601 start (default: start of today, user tz)' },
      timeMax: { type: 'string', description: 'ISO 8601 end (default: end of today, user tz)' },
      maxResults: { type: 'number', description: 'Max events (1-50). Default 20.' },
    },
  },
  async execute(args, ctx) {
    const tz = process.env.AIOS_TZ ?? 'Asia/Kolkata';
    const dflt = todayRange(tz);
    const timeMin = typeof args.timeMin === 'string' && args.timeMin ? args.timeMin : dflt.timeMin;
    const timeMax = typeof args.timeMax === 'string' && args.timeMax ? args.timeMax : dflt.timeMax;
    const max = Math.min(Math.max(Number(args.maxResults) || 20, 1), 50);
    const data = await googleApi<{ items?: GEvent[] }>(
      ctx.pool,
      `${CAL}?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
        `&singleEvents=true&orderBy=startTime&maxResults=${max}&timeZone=${encodeURIComponent(tz)}`,
    );
    return {
      timezone: tz,
      timeMin,
      timeMax,
      events: (data.items ?? [])
        .filter((e) => e.status !== 'cancelled')
        .map((e) => ({
          id: e.id,
          summary: e.summary ?? '(no title)',
          start: e.start?.dateTime ?? e.start?.date ?? '',
          end: e.end?.dateTime ?? e.end?.date ?? '',
          location: e.location,
          attendees: e.attendees?.length,
        })),
    };
  },
};

// Creates a REAL event on the user's calendar — undoable (delete/edit in Google
// Calendar) but visible to anyone invited, so it is approval-gated (trust_policies:
// write, auto_approve=false — see migration 0012). Non-auto tools are queued for the
// user's one-click approval by the executor BEFORE the structural untrusted-content
// gate is ever consulted, so this reliably fires even in a task that already read
// calendar_list/gmail_list (which is the normal, expected order of operations).
export const calendarCreateEvent: ToolDef = {
  name: 'calendar_create_event',
  description:
    "Propose a new event on the user's primary Google Calendar. This is NOT auto-approved — it is queued for the user's explicit one-click approval and only actually created once they approve.",
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'ISO 8601 start datetime, e.g. 2026-07-10T09:45:00+05:30' },
      end: { type: 'string', description: 'ISO 8601 end datetime. If omitted, defaults to 30 minutes after start.' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses (optional)' },
      location: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['summary', 'start'],
  },
  async execute(args, ctx) {
    const tz = process.env.AIOS_TZ ?? 'Asia/Kolkata';
    const summary = String(args.summary ?? '').trim();
    const start = String(args.start ?? '').trim();
    if (!summary || !start) throw new Error('summary and start are required');
    const startMs = Date.parse(start);
    if (Number.isNaN(startMs)) throw new Error(`start is not a valid ISO datetime: "${start}"`);
    const end = typeof args.end === 'string' && args.end ? args.end : new Date(startMs + 30 * 60_000).toISOString();
    const attendees = Array.isArray(args.attendees)
      ? (args.attendees as unknown[]).filter((a): a is string => typeof a === 'string').map((email) => ({ email }))
      : undefined;

    const created = await googleApi<{ id: string; htmlLink?: string }>(ctx.pool, CAL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        summary,
        start: { dateTime: start, timeZone: tz },
        end: { dateTime: end, timeZone: tz },
        ...(attendees ? { attendees } : {}),
        ...(typeof args.location === 'string' ? { location: args.location } : {}),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
      }),
    });
    return { eventId: created.id, htmlLink: created.htmlLink, summary, start, end };
  },
};
