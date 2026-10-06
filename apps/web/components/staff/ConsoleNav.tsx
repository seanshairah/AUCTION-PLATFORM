'use client';

import {
  BanknotesIcon, BookOpenIcon, CalendarDaysIcon, ChartBarIcon, ChatBubbleLeftRightIcon, CheckBadgeIcon, ChevronRightIcon,
  ExclamationTriangleIcon, HomeModernIcon, QrCodeIcon, ScaleIcon, ShieldExclamationIcon, Squares2X2Icon,
} from '@heroicons/react/20/solid';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const ICONS = {
  today: Squares2X2Icon, auctions: CalendarDaysIcon, gate: QrCodeIcon, approvals: CheckBadgeIcon, tickets: ChatBubbleLeftRightIcon,
  claims: ScaleIcon, defaults: ExclamationTriangleIcon, risk: ShieldExclamationIcon, money: BanknotesIcon, rulebook: BookOpenIcon,
  analytics: ChartBarIcon, site: HomeModernIcon,
};

export interface ConsoleLink { href: string; label: string; icon: keyof typeof ICONS; count?: number; urgent?: boolean }

export function ConsoleNav({ sections }: { sections: Array<{ title: string; links: ConsoleLink[] }> }) {
  const path = usePathname();
  return (
    <nav aria-label="Console">
      {sections.filter((s) => s.links.length).map((s) => (
        <div key={s.title} style={{ display: 'contents' }}>
          <div className="sect">{s.title}</div>
          {s.links.map((l) => {
            const Icon = ICONS[l.icon];
            const on = l.href === '/staff' ? path === '/staff' : path.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
                <Icon />
                {l.label}
                {l.count ? <span className={`badge${l.urgent ? ' urgent' : ''}`}>{l.count}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

const TITLES: Record<string, string> = {
  '/staff': 'Today', '/staff/auctions': 'Auctions', '/staff/gate': 'Gate', '/staff/approvals': 'Approvals', '/staff/tickets': 'Tickets',
  '/staff/claims': 'Claims', '/staff/defaults': 'Late payments', '/staff/risk': 'Risk', '/staff/money': 'Reconciliation',
  '/staff/rulebook': 'Rulebook', '/staff/analytics': 'Analytics',
};

export function Crumbs() {
  const path = usePathname();
  const base = Object.keys(TITLES).filter((k) => path === k || (k !== '/staff' && path.startsWith(k))).sort((a, b) => b.length - a.length)[0] ?? '/staff';
  return (
    <div className="crumbs">
      <span>Operations</span><ChevronRightIcon /><b>{TITLES[base]}</b>
    </div>
  );
}

/** Harare time, ticking, so a queue's deadlines read against the same clock the server uses. */
export function ConsoleClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="con-clock" title="Harare time (CAT)">
      <span className="dot" aria-hidden />
      {now ? now.toLocaleTimeString('en-ZW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Harare' }) : '--:--:--'} CAT
    </span>
  );
}
