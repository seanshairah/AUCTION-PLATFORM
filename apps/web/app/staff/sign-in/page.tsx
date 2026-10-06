import { LockClosedIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { StaffSignIn } from '@/components/staff/StaffSignIn';
import { apiOrNull } from '@/lib/api';
import '../console.css';

export const metadata = { title: 'Staff sign-in' };

export default async function StaffSignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = next?.startsWith('/staff') ? next : '/staff';
  const accounts = await apiOrNull<Array<{ id: string; name: string; roles: string[] }>>('/session/demo-staff-accounts');
  return (
    <div className="staff-gate">
      <section className="art">
        <Link href="/" className="wordmark"><b>ABC<span>.</span>Auctions</b><i>Operations console</i></Link>
        <div>
          <h1>Every queue.<br />Two people.<br /><span>One ledger.</span></h1>
          <p>Approvals above the threshold need a second person. Every action is written to the audit log with the reason given. Money moves only through the ledger.</p>
        </div>
        <div className="marks">
          <div><b>R1</b><span className="micro" style={{ color: 'var(--night-muted)' }}>Double-entry ledger</span></div>
          <div><b>R2</b><span className="micro" style={{ color: 'var(--night-muted)' }}>Versioned rulebook</span></div>
          <div><b>R3</b><span className="micro" style={{ color: 'var(--night-muted)' }}>Two-person approval</span></div>
        </div>
      </section>
      <section className="pane">
        <div>
          <span className="micro row" style={{ gap: 6 }}><LockClosedIcon width={14} /> Staff only</span>
          <h2 className="display d-md" style={{ marginTop: 8 }}>Sign in to the console</h2>
          <p className="ink-2" style={{ marginTop: 8 }}>Production uses your ABC staff account with a one-time code. This demo environment lets you pick a staff member to see what each role can do.</p>
        </div>
        {accounts && accounts.length > 0 ? (
          <StaffSignIn accounts={accounts} next={target} />
        ) : (
          <div className="notice neutral">Demo staff sign-in is switched off here. Ask an administrator for a staff account.</div>
        )}
        <Link href="/" className="link small">Back to the public site</Link>
      </section>
    </div>
  );
}
