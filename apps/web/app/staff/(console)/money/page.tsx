import { BanknotesIcon, CheckIcon, DocumentMagnifyingGlassIcon } from '@heroicons/react/20/solid';
import { Action } from '@/components/staff/Action';
import { apiOrNull } from '@/lib/api';
import { can, staffMe, words } from '@/lib/staff';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Reconciliation' };

interface Item {
  itemId: string; runId: string; source: string; currency: string; statementDate: string; outcome: string; externalReference: string | null;
  statementAmount: Money | null; payment: { id: string; amount: Money; gateway: string; accountId: string; failureReason: string | null } | null;
  difference: Money | null; withinTolerance: boolean; shortfall: Money | null; pendingWriteOff: string | null;
}

const OUTCOME: Record<string, { label: string; tone: string }> = {
  missing_in_system: { label: 'On statement, not in system', tone: 'bad' },
  missing_at_source: { label: 'In system, not on statement', tone: 'bad' },
  amount_mismatch: { label: 'Amounts differ', tone: 'warn' },
  currency_mismatch: { label: 'Currency differs', tone: 'bad' },
};

export default async function MoneyPage() {
  const me = (await staffMe())!;
  const items = await apiOrNull<Item[]>('/staff/reconciliation');
  if (!items) return <div className="notice bad">Your role cannot see reconciliation.</div>;
  const resolve = can(me, 'reconciliation.resolve');
  const writeOff = can(me, 'reconciliation.write_off.request');
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><BanknotesIcon /> R1 · One ledger</span>
          <h1>Reconciliation</h1>
          <p>Each day the gateway and bank statements are matched against the ledger, line by line and currency by currency. What does not match lands here; nothing is netted across USD and ZiG.</p>
        </div>
      </div>
      <div className="pnl">
        <header><DocumentMagnifyingGlassIcon /><h2>Exceptions</h2><span className={`badge${items.length ? ' urgent' : ''}`}>{items.length}</span></header>
        <div className="body flush">
          {items.length === 0 ? <div className="empty"><CheckIcon /><b>Everything matches</b><span>Statement lines and ledger entries agree for every source and currency.</span></div> : (
            <table className="table">
              <thead><tr><th>Source</th><th>Date</th><th>Outcome</th><th>Reference</th><th className="r">Statement</th><th className="r">System</th><th className="r">Difference</th><th>Actions</th></tr></thead>
              <tbody>{items.map((i) => {
                const o = OUTCOME[i.outcome] ?? { label: words(i.outcome), tone: 'warn' };
                return (
                  <tr key={i.itemId} style={{ verticalAlign: 'top' }}>
                    <td><span className="w500">{words(i.source)}</span><br /><span className="micro">{i.currency}</span></td>
                    <td className="small mono">{i.statementDate}</td>
                    <td><span className={`status ${o.tone}`}><span className="ring" /> {o.label}</span>{i.withinTolerance && <><br /><span className="small muted">Within tolerance</span></>}</td>
                    <td className="small mono">{i.externalReference ?? '—'}</td>
                    <td className="r mono">{i.statementAmount?.text ?? '—'}</td>
                    <td className="r mono">{i.payment?.amount.text ?? '—'}</td>
                    <td className="r mono" style={{ color: i.difference && i.difference.minor !== '0' ? 'var(--bad)' : undefined }}>{i.difference?.text ?? i.shortfall?.text ?? '—'}</td>
                    <td>
                      <div className="stack-8">
                        {resolve && (
                          <div className="btn-group">
                            <Action url={`/staff/reconciliation/${i.itemId}/resolve`} body={{ resolution: i.withinTolerance ? 'within_tolerance' : 'matched_manually', ...(i.payment ? { paymentId: i.payment.id } : {}) }} label="Resolve" note="note:How was it matched?" icon={<CheckIcon />} />
                            <Action url={`/staff/reconciliation/${i.itemId}/resolve`} body={{ resolution: 'gateway_error' }} label="Gateway error" note="note:What did the gateway get wrong?" />
                          </div>
                        )}
                        {writeOff && i.shortfall && !i.pendingWriteOff && <Action url={`/staff/reconciliation/${i.itemId}/write-off`} body={{ clientKey: `wo-${i.itemId}` }} label={`Write off ${i.shortfall.text}`} tone="danger" note="reason:Why write it off? A second person approves." done="Write-off raised for approval." />}
                        {i.pendingWriteOff && <span className="status warn"><span className="ring" /> Write-off waiting for approval</span>}
                        {!resolve && !writeOff && <span className="muted small">View only</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
