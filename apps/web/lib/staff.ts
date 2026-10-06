import { apiOrNull } from './api';

/** The signed-in staff member (GET /staff/me), or null for anyone else. */
export interface StaffMe {
  id: string;
  name: string;
  roles: string[];
  permissions: string[];
}

export async function staffMe(): Promise<StaffMe | null> {
  return apiOrNull<StaffMe>('/staff/me');
}

/** Screens served by routes that check roles directly rather than a named permission. */
const ROLE_SCREENS: Record<string, readonly string[]> = {
  tickets: ['support', 'ops', 'admin'],
  claims: ['support', 'ops', 'admin', 'finance', 'risk'],
  gate: ['ops', 'cashier', 'vehicle_desk', 'admin'],
};

export function canSee(me: StaffMe, screen: string): boolean {
  const roles = ROLE_SCREENS[screen];
  if (roles) return me.roles.some((r) => roles.includes(r));
  return me.permissions.includes(screen);
}

/** The permission a second person needs to approve each kind of override (docs/18 §3). */
export const APPROVE_PERMISSION: Record<string, string> = {
  limit_change: 'override.limit_change.approve', tier_change: 'override.tier_change.approve', tax_rate_activation: 'tax_rate.activation.approve',
  default_waiver: 'default.waiver.approve', reconciliation_write_off: 'reconciliation.write_off.approve',
};

/** Pending overrides this person may approve: someone else raised them and their role holds the permission. */
export function approvableBy<T extends { kind: string; requestedBy: { id: string } }>(me: StaffMe, list: T[]): T[] {
  return list.filter((o) => o.requestedBy.id !== me.id && me.permissions.includes(APPROVE_PERMISSION[o.kind] ?? ''));
}

export function can(me: StaffMe, permission: string): boolean {
  return me.permissions.includes(permission);
}

export function initials(name: string): string {
  return name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

/** "Rufaro Dube (ABC risk, demo)" → "Rufaro Dube". */
export function plainName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '');
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = seconds / 3600;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function pct(rate: number | null | undefined, digits = 0): string {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(digits)}%`;
}

export function words(code: string | null | undefined): string {
  if (!code) return '—';
  const s = code.replaceAll('_', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function relative(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  if (m < 1) return 'just now';
  const text = m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}
