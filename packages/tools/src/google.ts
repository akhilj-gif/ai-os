// Google API access: token refresh + fetch helper over the oauth_tokens row.
// Plain REST via fetch — the googleapis SDK is heavyweight for three endpoints.
import type pg from 'pg';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GoogleNotConnectedError extends Error {
  constructor() {
    super(
      'Google account not connected — the user must visit http://localhost:4000/oauth/google to connect Gmail/Calendar.',
    );
  }
}

interface TokenRow {
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: Date | null;
}

export async function getGoogleAccessToken(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<TokenRow>(
    `SELECT refresh_token, access_token, access_token_expires_at
     FROM oauth_tokens WHERE provider = 'google'`,
  );
  const row = rows[0];
  if (!row) throw new GoogleNotConnectedError();

  const stillValid =
    row.access_token &&
    row.access_token_expires_at &&
    row.access_token_expires_at.getTime() - Date.now() > 60_000;
  if (stillValid) return row.access_token!;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  await pool.query(
    `UPDATE oauth_tokens
     SET access_token = $1,
         access_token_expires_at = now() + ($2 || ' seconds')::interval,
         updated_at = now()
     WHERE provider = 'google'`,
    [data.access_token, String(data.expires_in)],
  );
  return data.access_token;
}

export async function googleApi<T = unknown>(
  pool: pg.Pool,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getGoogleAccessToken(pool);
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Google API ${res.status} on ${url.split('?')[0]}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}
