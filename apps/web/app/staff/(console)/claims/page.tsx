import { CameraIcon, ClockIcon, ExclamationTriangleIcon, ScaleIcon, UserPlusIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Action } from '@/components/staff/Action';
import { DisputeDecision } from '@/components/staff/DisputeDecision';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { plainName, relative, staffMe, words } from '@/lib/staff';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Claims' };

interface Dispute {
  id: string; lotRef: string; lotTitle: string; category: string; status: string; listedCondition: string; claimedCondition: string | null;
  description: string; owner: { id: string; name: string } | null; responseDueAt: string; decisionDueAt: string | null; overdue: boolean;
  remedy: string | null; refund: Money | null; currency: string; decision: string | null; decidedAt: string | null; raisedAt: string;
  assessment: { qualifies: boolean; reasons: string[] } | null; evidence: string[];
}

const TABS = [['open', 'Open'], ['under_review', 'Under review'], ['decided', 'Decided'], ['all', 'All']] as const;

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const me = (await staffMe())!;
  const { status = 'open' } = await searchParams;
  const list = await apiOrNull<Dispute[]>(`/staff/disputes?status=${encodeURIComponent(status)}`);
  if (!list) return <div className="notice bad">Your role cannot see claims.</div>;
  const canAct = me.roles.some((r) => ['support', 'ops', 'admin'].includes(r));
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><ScaleIcon /> Deliverable 17 · Not as described</span>
          <h1>Claims</h1>
          <p>Each claim is judged against the published inspection report, not against memory. Refunds above the threshold go to finance as a second approval before any money moves.</p>
        </div>
        <nav className="seg-tabs" aria-label="Status">
          {TABS.map(([k, label]) => <Link key={k} href={`/staff/claims?status=${k}`} className={status === k ? 'on' : ''}>{label}</Link>)}
        </nav>
      </div>

      {list.length === 0 && <div className="pnl"><div className="empty"><ScaleIcon /><b>No claims in this view</b><span>Buyers raise claims from their purchases within the claim window.</span></div></div>}

      {list.map((d) => (
        <article key={d.id} className="req">
          <div className="main">
            <div className="top">
              <span className="chip ink">{words(d.category)}</span>
              <span className="chip">{words(d.status)}</span>
              {d.overdue ? <span className="status bad"><ExclamationTriangleIcon /> Response overdue</span> : d.status === 'open' || d.status === 'under_review' ? <span className="status warn"><ClockIcon /> Respond {relative(d.responseDueAt)}</span> : null}
            </div>
            <div>
              <Link href={`/lots/${d.lotRef}`} className="what link">{d.lotTitle}</Link>
              <div className="micro" style={{ marginTop: 4 }}>{d.lotRef} · raised {shortDateTime(d.raisedAt)}</div>
            </div>
            <blockquote>{d.description}</blockquote>
            <div className="meta">
              <div><span className="micro">Listed as</span><span className="small">{words(d.listedCondition)}</span></div>
              <div><span className="micro">Buyer says</span><span className="small">{words(d.claimedCondition)}</span></div>
              <div><span className="micro">Evidence</span><span className="small row" style={{ gap: 4 }}><CameraIcon width={14} className="muted" /> {d.evidence.length} file{d.evidence.length === 1 ? '' : 's'}</span></div>
              <div><span className="micro">Owner</span><span className="small">{d.owner ? plainName(d.owner.name) : 'Unassigned'}</span></div>
            </div>
            {d.assessment && (
              <div className={`notice ${d.assessment.qualifies ? 'good' : 'neutral'} small`}>
                <span><b>{d.assessment.qualifies ? 'Qualifies against the report.' : 'Does not qualify against the report.'}</b> {d.assessment.reasons.join(' ')}</span>
              </div>
            )}
            {d.decision && <div className="notice info small"><span><b>Decision{d.remedy ? ` · ${words(d.remedy)}` : ''}{d.refund ? ` · ${d.refund.text}` : ''}:</b> {d.decision}</span></div>}
          </div>
          <aside className="side">
            {d.decidedAt ? <><span className="micro">Decided</span><span className="small">{shortDateTime(d.decidedAt)}</span></> : canAct ? (
              <>
                {d.owner?.id !== me.id && <Action url={`/staff/disputes/${d.id}/assign`} body={{ ownerStaffId: me.id }} label="Take this claim" icon={<UserPlusIcon />} done="Assigned to you." />}
                <DisputeDecision disputeId={d.id} currency={d.currency} />
              </>
            ) : <div className="notice neutral small">Your role can see claims but not decide them.</div>}
          </aside>
        </article>
      ))}
    </>
  );
}
