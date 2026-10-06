export function km(n: number | null): string {
  return n === null ? '—' : `${n.toLocaleString('en-US')} km`;
}

export function titleCase(s: string | null): string {
  if (!s) return '—';
  if (s.length <= 3) return s.toUpperCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const BODY_LABEL: Record<string, string> = {
  sedan: 'Sedan', hatchback: 'Hatchback', suv: 'SUV', pickup: 'Pickup', van: 'Van', truck: 'Truck', bus: 'Bus', coupe: 'Coupe', wagon: 'Wagon', other: 'Other',
};

export function timeLeft(endsAt: string, now = Date.now()): { text: string; urgent: boolean; ended: boolean } {
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return { text: 'Closing…', urgent: true, ended: true };
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const text = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
  return { text, urgent: ms < 3_600_000, ended: false };
}

export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-ZW', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare' });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleString('en-ZW', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare' });
}
