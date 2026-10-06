import { ChevronRightIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ConsoleClock, ConsoleNav, Crumbs, type ConsoleLink } from '@/components/staff/ConsoleNav';
import { StaffSignOut } from '@/components/staff/StaffSignOut';
import { apiOrNull } from '@/lib/api';
import { approvableBy, canSee, initials, plainName, staffMe } from '@/lib/staff';
import '../console.css';

export const metadata = { title: { default: 'Operations', template: '%s · ABC Operations' }, robots: { index: false } };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const me = await staffMe();
  if (!me) redirect('/staff/sign-in');
  const see = (s: string) => canSee(me, s);
  const [overrides, tickets, disputes, cases, regs, recon] = await Promise.all([
    see('override.view') ? apiOrNull<Array<{ kind: string; requestedBy: { id: string } }>>('/staff/overrides?status=pending') : null,
    see('tickets') ? apiOrNull<Array<{ breached: { firstResponse: boolean } }>>('/staff/tickets') : null,
    see('claims') ? apiOrNull<Array<{ overdue: boolean }>>('/staff/disputes') : null,
    see('default.view') ? apiOrNull<unknown[]>('/staff/defaults?status=open') : null,
    see('risk.view') ? apiOrNull<unknown[]>('/staff/risk/registrations') : null,
    see('reconciliation.view') ? apiOrNull<unknown[]>('/staff/reconciliation') : null,
  ]);
  const forMe = approvableBy(me, overrides ?? []).length;
  const link = (screen: string, l: ConsoleLink): ConsoleLink[] => (see(screen) ? [l] : []);
  const sections: Array<{ title: string; links: ConsoleLink[] }> = [
    { title: 'Today', links: [
      { href: '/staff', label: 'Today', icon: 'today' },
      ...link('dashboard.view', { href: '/staff/auctions', label: 'Auctions', icon: 'auctions' }),
      ...link('gate', { href: '/staff/gate', label: 'Gate release', icon: 'gate' }),
    ] },
    { title: 'Queues', links: [
      ...link('override.view', { href: '/staff/approvals', label: 'Approvals', icon: 'approvals', count: forMe, urgent: forMe > 0 }),
      ...link('tickets', { href: '/staff/tickets', label: 'Tickets', icon: 'tickets', count: tickets?.length ?? 0, urgent: (tickets ?? []).some((t) => t.breached.firstResponse) }),
      ...link('claims', { href: '/staff/claims', label: 'Claims', icon: 'claims', count: disputes?.length ?? 0, urgent: (disputes ?? []).some((d) => d.overdue) }),
      ...link('default.view', { href: '/staff/defaults', label: 'Late payments', icon: 'defaults', count: cases?.length ?? 0 }),
      ...link('risk.view', { href: '/staff/risk', label: 'Risk', icon: 'risk', count: regs?.length ?? 0, urgent: (regs?.length ?? 0) > 0 }),
    ] },
    { title: 'Money and rules', links: [
      ...link('reconciliation.view', { href: '/staff/money', label: 'Reconciliation', icon: 'money', count: recon?.length ?? 0, urgent: (recon?.length ?? 0) > 0 }),
      ...link('rulebook.view', { href: '/staff/rulebook', label: 'Rulebook', icon: 'rulebook' }),
      ...link('analytics.view', { href: '/staff/analytics', label: 'Analytics', icon: 'analytics' }),
    ] },
  ];
  return (
    <div className="console">
      <aside className="con-side">
        <div className="con-brand">
          <Link href="/staff" className="wordmark"><b>ABC<span>.</span>Ops</b><i>Operations console</i></Link>
          <span className="con-env">Demo</span>
        </div>
        <ConsoleNav sections={sections} />
        <div className="con-who">
          <div className="me">
            <span className="avatar">{initials(me.name)}</span>
            <div style={{ minWidth: 0 }}>
              <div className="name">{plainName(me.name)}</div>
              <div className="roles">{me.roles.map((r) => <span key={r} className="role">{r}</span>)}</div>
            </div>
          </div>
          <div className="acts">
            <Link href="/" className="btn sm outline-night">Public site <ChevronRightIcon /></Link>
            <StaffSignOut />
          </div>
        </div>
      </aside>
      <div style={{ minWidth: 0 }}>
        <div className="con-top">
          <Crumbs />
          <div className="right"><ConsoleClock /></div>
        </div>
        <div className="con-body">{children}</div>
      </div>
    </div>
  );
}
