// Secrets broker (blueprint §8.2): the ONE place secrets are read, and a redaction
// guard so a secret that ever slips into a tool result, args, or trace payload is
// scrubbed before it's persisted to the append-only audit log. Agents never get
// raw credentials in context — model/provider keys live here and in the model
// router; OAuth tokens live in the DB and are fetched inside tools, never surfaced.
const SECRET_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_API_KEY_FALLBACK',
  'GROQ_API_KEY',
  'NVIDIA_API_KEY',
  'X_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'UBER_CLIENT_SECRET',
  'DATABASE_URL',
  'LANGFUSE_SECRET_KEY',
  // Bridge/API bearer tokens (2026-08-13, secrets-redaction audit): these
  // authenticate to the OS's own HTTP surfaces (server.ts, browser-bridge,
  // whatsapp-bridge, the mobility bridge) — read via process.env in their
  // respective entrypoints but never listed here, so any of them landing in
  // a tool result or error message would have reached the audit log in the
  // clear instead of being scrubbed like every other credential.
  'AIOS_API_TOKEN',
  'BROWSER_BRIDGE_TOKEN',
  'WHATSAPP_BRIDGE_TOKEN',
  'MOBILITY_BRIDGE_TOKEN',
] as const;

// Structural patterns for known secret shapes — catch values even when they don't
// come from our own env (e.g. a token pasted into an email the OS reads).
const SECRET_PATTERNS: RegExp[] = [
  /GOCSPX-[\w-]{10,}/g, // Google client secret
  /AQ\.[\w-]{20,}/g, // Google API key
  /xai-[A-Za-z0-9]{20,}/g, // xAI key
  /gsk_[A-Za-z0-9]{20,}/g, // Groq key
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style key
  /ya29\.[\w.-]{20,}/g, // Google OAuth access token
  /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@[^\s"']+/g, // DB URL with creds
  /\bBearer\s+[A-Za-z0-9._-]{20,}/g, // bearer tokens
];

export class SecretsBroker {
  private values: string[];
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.values = SECRET_ENV_NAMES.map((n) => env[n]).filter((v): v is string => !!v && v.length >= 8);
  }

  /** Typed read of a known secret. The ONLY sanctioned way to read a secret. */
  get(name: (typeof SECRET_ENV_NAMES)[number]): string | undefined {
    return process.env[name];
  }

  /** Scrub any known secret VALUE or secret-shaped token from arbitrary text
   *  before it is logged/persisted. Idempotent; safe on undefined/objects. */
  redact<T>(input: T): T {
    let s = typeof input === 'string' ? input : JSON.stringify(input);
    if (!s) return input;
    for (const v of this.values) s = s.split(v).join('[REDACTED]');
    for (const re of SECRET_PATTERNS) s = s.replace(re, '[REDACTED]');
    if (typeof input === 'string') return s as unknown as T;
    try {
      return JSON.parse(s) as T;
    } catch {
      return input; // if scrubbing broke JSON, return original (better than crashing audit)
    }
  }
}

let shared: SecretsBroker | null = null;
export function secretsBroker(): SecretsBroker {
  shared ??= new SecretsBroker();
  return shared;
}

/** Convenience: scrub a value for audit persistence. */
export function redactForAudit<T>(input: T): T {
  return secretsBroker().redact(input);
}
