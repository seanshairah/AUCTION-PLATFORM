import { ChatBubbleLeftRightIcon, CheckCircleIcon, ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import { NewTicket } from '@/components/support/NewTicket';
import { RaiseClaim } from '@/components/support/RaiseClaim';
import { Reply } from '@/components/support/Reply';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Support' };

interface Ticket { id: string; number: string; category: string; subject: string; status: string; priority: string; firstResponseDueAt: string; createdAt: string; breached: { firstResponse: boolean }; messages: Array<{ id: string; author: string; authorName: string; body: string; internal: boolean; at: string }> }
interface Dispute { id: string; lotRef: string; lotTitle: string; category: string; status: string; description: string; responseDueAt: string; remedy: string | null; refund: Money | null; decision: string | null; raisedAt: string; overdue: boolean }
interface Purchase { lots: Array<{ id: string; title: string }> }

const DSTATUS: Record<string, string> = { open: 'Open', under_review: 'Under review', upheld: 'Upheld', partially_upheld: 'Partly upheld', rejected: 'Not upheld', withdrawn: 'Withdrawn' };

export default async function SupportPage({ searchParams }: { searchParams: Promise<{ claim?: string }> }) {
  const { claim } = await searchParams;
  const [tickets, disputes, purchases] = await Promise.all([apiOrNull<Ticket[]>('/me/tickets'), apiOrNull<Dispute[]>('/me/disputes'), claim ? apiOrNull<Purchase[]>('/me/purchases') : Promise.resolve(null)]);
  const claimLot = claim ? purchases?.flatMap((p) => p.lots).find((l) => l.id === claim) : undefined;
  return (
    <>
      <div className="acc-title"><div><h1>Support</h1><p>Questions, claims and replies in one place. Every message has an owner and a reply-by time.</p></div></div>
      <div className="split" style={{ alignItems: 'start' }}>
        <div className="stack">
          {(disputes ?? []).length > 0 && (
            <div className="nest">
              <div className="nest-head"><h3>Claims</h3><span className="badge">{disputes!.length}</span></div>
              <div className="nest-body" style={{ padding: 0 }}>
                <table className="table">
                  <thead><tr><th>Lot</th><th>Status</th><th>Reply by</th><th>Outcome</th></tr></thead>
                  <tbody>{disputes!.map((d) => (
                    <tr key={d.id}>
                      <td><span className="w500">{d.lotTitle}</span><br /><span className="micro">{d.lotRef}</span></td>
                      <td>{DSTATUS[d.status] ?? d.status}</td>
                      <td className="small">{d.overdue ? <span className="status bad"><ExclamationTriangleIcon /> Overdue</span> : shortDateTime(d.responseDueAt)}</td>
                      <td className="small">{d.remedy ? `${d.remedy.replaceAll('_', ' ')}${d.refund ? ` · ${d.refund.text}` : ''}` : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
          <div className="nest">
            <div className="nest-head"><ChatBubbleLeftRightIcon /><h3>Your conversations</h3><span className="badge">{(tickets ?? []).length}</span></div>
            <div className="nest-body stack" style={{ padding: (tickets ?? []).length ? 16 : 16 }}>
              {(tickets ?? []).length === 0 && <p className="muted">No conversations yet.</p>}
              {(tickets ?? []).map((t) => (
                <details key={t.id} className="card" style={{ padding: '12px 14px' }}>
                  <summary className="row between" style={{ cursor: 'pointer', listStyle: 'none' }}>
                    <span><span className="w600">{t.subject}</span><br /><span className="micro">{t.number} · {t.category}</span></span>
                    <span className={`status ${t.status === 'resolved' || t.status === 'closed' ? 'good' : t.breached.firstResponse ? 'bad' : 'neutral'}`}>
                      {t.status === 'resolved' || t.status === 'closed' ? <CheckCircleIcon /> : <ClockIcon />}
                      {t.status === 'open' ? `Reply by ${shortDateTime(t.firstResponseDueAt)}` : t.status.replace('_', ' ')}
                    </span>
                  </summary>
                  <div className="timeline" style={{ marginTop: 12 }}>
                    {t.messages.filter((m) => !m.internal).map((m) => (
                      <div key={m.id} className="tl-item"><span className="who">{m.author === 'customer' ? 'You' : m.authorName}</span><span className="when" style={{ gridColumn: 'auto', textAlign: 'right' }}>{shortDateTime(m.at)}</span><span style={{ gridColumn: '1 / -1' }} className="ink-2">{m.body}</span></div>
                    ))}
                  </div>
                  {t.status !== 'closed' && <div style={{ marginTop: 10 }}><Reply ticketId={t.id} /></div>}
                </details>
              ))}
            </div>
          </div>
        </div>
        <div className="stack">
          {claimLot && <RaiseClaim lotId={claimLot.id} lotTitle={claimLot.title} />}
          <NewTicket />
        </div>
      </div>
    </>
  );
}
