import { cookies } from 'next/headers';

/**
 * Server-side calls to the API, forwarding the visitor's session cookie.
 * Browser-side calls go to /api/* on this origin (rewritten in next.config.ts).
 */
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string): Promise<T> {
  const jar = await cookies();
  const session = jar.get('abc_session');
  const res = await fetch(`${API_URL}${path}`, {
    headers: session ? { cookie: `abc_session=${session.value}` } : {},
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, `${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Like api(), but null for 401/403/404 instead of throwing. */
export async function apiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) return null;
    throw e;
  }
}
