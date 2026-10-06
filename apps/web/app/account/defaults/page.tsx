import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import { Appeal } from '@/components/account/Appeal';
import { apiOrNull } from '@/lib/api';

export const metadata = { title: 'Late payments' };

interface Case { caseId: string; status: string; openedAt: string; invoice: { number: string; status: string; dueAt: string; total?: { text: string } }; stepsApplied: string[]; appeals: Array<{ id: string; steps: string[]; status: string; raisedAt: string; decisionNote: string | null }>; waivers: Array<{ step: string; effect: string }> }
const LABEL: Record<string, string> = { warning: 'Warning', deposit_forfeit: 'Deposit kept', relist_fee: 'Relisting fee', tier_drop: 'Lower spending limit' };

export default async function DefaultsPage() {
  const cases = (await apiOrNull<Case[]>('/me/defaults')) ?? [];
  return (
    <>
      <div className="acc-title"><div><h1>Late payments</h1><p>If an invoice was not paid on time, the steps taken are listed here. You can appeal any of them.</p></div></div>
      {cases.length === 0 ? <div className="card empty"><CheckCircleIcon /><h3 className="w600">Nothing overdue</h3><p>You have no late payments.</p></div> : (
        <div className="stack">
          {cases.map((c) => (
            <div key={c.caseId} className="nest">
              <div className="nest-head"><ExclamationTriangleIcon style={{ color: 'var(--warn)' }} /><h3>Invoice <span className="mono">{c.invoice.number}</span></h3><span className="micro" style={{ marginLeft: 'auto' }}>{c.status}</span></div>
              <div className="nest-body stack">
                <div className="row" style={{ flexWrap: 'wrap' }}>{c.stepsApplied.map((s) => <span key={s} className="chip">{LABEL[s] ?? s}</span>)}</div>
                {c.waivers.map((w) => <span key={w.step} className="status good"><CheckCircleIcon /> {LABEL[w.step] ?? w.step} waived</span>)}
                {c.appeals.map((a) => <p key={a.id} className="small ink-2">Appeal against {a.steps.map((s) => LABEL[s] ?? s).join(', ')}: {a.status}{a.decisionNote ? `. ${a.decisionNote}` : ''}</p>)}
                {!c.appeals.some((a) => a.status === 'open') && <Appeal caseId={c.caseId} steps={c.stepsApplied} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
