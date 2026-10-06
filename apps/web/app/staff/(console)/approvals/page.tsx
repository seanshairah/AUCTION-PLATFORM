import { CheckBadgeIcon, CheckIcon, ClockIcon, UserIcon, XMarkIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Action } from '@/components/staff/Action';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { APPROVE_PERMISSION, can, plainName, relative, staffMe, words } from '@/lib/staff';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Approvals' };

interface Override {
  id: string; kind: string; currency: string | null; amount: Money | null; reason: string;
  requestedBy: { id: string; name: string }; requestedAt: string; requiresSecondApproval: boolean; status: string;
  approvedBy: { id: string; name: string } | null; decidedAt: string | null; decisionNote: string | null; expiresAt: string | null; executedAt: string | null;
  payload: { summary?: string; currency?: string };
}

const TABS = [['pending', 'Waiting'], ['executed', 'Executed'], ['rejected', 'Rejected'], ['expired', 'Lapsed']] as const;

/** "… 2500000 minor units …" reads as money. */
function readable(summary: string | undefined, currency: string | null): string {
  if (!summary) return '';
  return summary.replace(/(\d+) minor units/g, (_, n: string) => {
    const v = (Number(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency === 'ZWG' ? `ZiG ${v}` : `US$${v}`;
  }).replace(/until (\d{4}-\d{2}-\d{2})/, (_, d: string) => `until ${new Date(d).toLocaleDateString('en-ZW', { day: 'numeric', month: 'short', year: 'numeric' })}`);
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const me = (await staffMe())!;
  const { status = 'pending' } = await searchParams;
  const [list, pending] = await Promise.all([
    apiOrNull<Override[]>(`/staff/overrides?status=${encodeURIComponent(status)}`),
    apiOrNull<Override[]>('/staff/overrides?status=pending'),
  ]);
  if (!list) return <div className="notice bad">Your role cannot see approvals.</div>;
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><CheckBadgeIcon /> R3 · Two-person rule</span>
          <h1>Approvals</h1>
          <p>Changes above the threshold wait here for a second person with the right role. The person who raised a request can never approve it, and a request nobody approves lapses on its own.</p>
        </div>
        <nav className="seg-tabs" aria-label="Status">
          {TABS.map(([k, label]) => (
            <Link key={k} href={`/staff/approvals?status=${k}`} className={status === k ? 'on' : ''}>
              {label}{k === 'pending' && (pending?.length ?? 0) > 0 && <span className="badge urgent">{pending!.length}</span>}
            </Link>
          ))}
        </nav>
      </div>

      {list.length === 0 && (
        <div className="pnl"><div className="empty"><CheckBadgeIcon /><b>{status === 'pending' ? 'Nothing is waiting for approval' : `No ${words(status).toLowerCase()} requests`}</b><span>Requests are raised from the risk, money and late-payment screens.</span></div></div>
      )}

      {list.map((o) => {
        const mine = o.requestedBy.id === me.id;
        const allowed = can(me, APPROVE_PERMISSION[o.kind] ?? '');
        const decided = o.status !== 'pending';
        const failed = o.status === 'rejected' || o.status === 'expired';
        return (
          <article key={o.id} className="req">
            <div className="main">
              <div className="top">
                <span className="chip ink">{words(o.kind)}</span>
                {o.requiresSecondApproval && <span className="chip">Above threshold</span>}
                {o.status === 'pending' && o.expiresAt && <span className="status warn"><ClockIcon /> Lapses {relative(o.expiresAt)}</span>}
                {o.status === 'executed' && <span className="status good"><CheckIcon /> Executed {o.executedAt ? shortDateTime(o.executedAt) : ''}</span>}
                {o.status === 'rejected' && <span className="status bad"><XMarkIcon /> Rejected</span>}
                {o.status === 'expired' && <span className="status neutral"><span className="ring" /> Lapsed</span>}
              </div>
              <div className="row" style={{ alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
                {o.amount && <span className="amt">{o.amount.text}</span>}
                <span className="what">{readable(o.payload.summary, o.currency)}</span>
              </div>
              <blockquote>{o.reason}</blockquote>
              <div className="meta">
                <div><span className="micro">Raised</span><span className="small">{shortDateTime(o.requestedAt)}</span></div>
                <div><span className="micro">Reference</span><span className="small mono">{o.id.slice(0, 8)}</span></div>
                {o.decisionNote && <div><span className="micro">Decision note</span><span className="small">{o.decisionNote}</span></div>}
              </div>
            </div>
            <aside className="side">
              <span className="micro">Sign-off</span>
              <div className="people">
                <div className="p done">
                  <span className="n"><UserIcon /></span>
                  <div><div className="who">{plainName(o.requestedBy.name)}{mine ? ' (you)' : ''}</div><div className="when">Raised {relative(o.requestedAt)}</div></div>
                </div>
                <div className={`p ${o.status === 'pending' ? 'wait' : failed ? 'no' : 'done'}`}>
                  <span className="n">{o.status === 'pending' ? '2' : failed ? <XMarkIcon /> : <CheckIcon />}</span>
                  <div>
                    <div className="who">{o.approvedBy ? plainName(o.approvedBy.name) : o.status === 'expired' ? 'Nobody approved in time' : 'Second person'}</div>
                    <div className="when">{o.decidedAt ? `${words(o.status)} ${relative(o.decidedAt)}` : 'Waiting'}</div>
                  </div>
                </div>
              </div>
              {!decided && (
                mine ? <div className="notice neutral small">You raised this request, so someone else must approve it.</div>
                : !allowed ? <div className="notice neutral small">Your role cannot approve a {words(o.kind).toLowerCase()}.</div>
                : (
                  <div className="stack-8">
                    <Action url={`/staff/overrides/${o.id}/approve`} label="Approve and apply" tone="ink" size="md" note="note:Note for the audit log (optional)" noteRequired={false} done="Approved and applied." icon={<CheckIcon />} />
                    <Action url={`/staff/overrides/${o.id}/reject`} label="Reject" tone="danger" note="note:Why are you rejecting it?" done="Rejected." icon={<XMarkIcon />} />
                  </div>
                )
              )}
            </aside>
          </article>
        );
      })}
    </>
  );
}
