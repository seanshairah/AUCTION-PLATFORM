import { CheckIcon, FingerPrintIcon, LinkIcon, NoSymbolIcon, ShieldExclamationIcon, UserGroupIcon, XMarkIcon } from '@heroicons/react/20/solid';
import { Action } from '@/components/staff/Action';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { can, duration, staffMe, words } from '@/lib/staff';

export const metadata = { title: 'Risk' };

interface Registration {
  registrationId: string; account: { id: string; name: string; tier: string; verification: string }; auction: { code: string; title: string; branch: string };
  reasons: string[]; waitingSeconds: number; targetMinutes: number | null;
  linkedAccounts: Array<{ id: string; name: string; sharedSignals: string[]; isSellerInAuction: boolean }>; history: { invoicesPaid: number; defaults: number };
}
interface Cluster { accounts: Array<{ id: string; name: string; tier: string; status: string; isSeller: boolean }>; signalTypes: string[]; size: number }
interface Anomalies {
  thresholds: Record<string, unknown>;
  bidUp: Array<{ bidder: { name: string }; seller: { name: string }; lotsBid: number; lotsWon: number; linkedToSeller: boolean }>;
  sharedSignals: Array<{ signalType: string; signal: string; accounts: Array<{ name: string }> }>;
}
interface Restricted { id: string; name: string; tier: string; status: string; restrictedUntil: string | null; since: string | null; reason: string | null }

export default async function RiskPage() {
  const me = (await staffMe())!;
  const [regs, clusters, anomalies, restricted] = await Promise.all([
    apiOrNull<Registration[]>('/staff/risk/registrations'),
    apiOrNull<Cluster[]>('/staff/risk/link-clusters'),
    apiOrNull<Anomalies>('/staff/risk/anomalies'),
    apiOrNull<Restricted[]>('/staff/risk/restricted'),
  ]);
  if (!regs) return <div className="notice bad">Your role cannot see the risk queue.</div>;
  const decide = can(me, 'risk.decide_registration');
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><ShieldExclamationIcon /> Deliverable 18 · Trust and safety</span>
          <h1>Risk</h1>
          <p>Registrations the rules could not approve on their own, accounts linked by device, phone or payout details, and bidding that looks like shill bidding. Every decision needs a written reason.</p>
        </div>
      </div>

      <div className="kband" style={{ ['--n' as string]: 4 }}>
        <div><span className="micro">Registrations waiting</span><span className={`v${regs.length ? ' urgent' : ''}`}>{regs.length}</span><span className="s">Target: within {regs[0]?.targetMinutes ?? 30} minutes</span></div>
        <div><span className="micro">Link clusters</span><span className="v">{clusters?.length ?? 0}</span><span className="s">{(clusters ?? []).filter((c) => c.accounts.some((a) => a.isSeller)).length} include a seller</span></div>
        <div><span className="micro">Anomalies</span><span className="v">{(anomalies?.bidUp.length ?? 0) + (anomalies?.sharedSignals.length ?? 0)}</span><span className="s">Bid-up and shared signals</span></div>
        <div><span className="micro">Restricted accounts</span><span className="v">{restricted?.length ?? 0}</span><span className="s">Cannot bid until reviewed</span></div>
      </div>

      <div className="cgrid">
        <section className="pnl c-12">
          <header><UserGroupIcon /><h2>Registrations for review</h2><span className="badge">{regs.length}</span></header>
          <div className="body flush">
            {regs.length === 0 ? <div className="empty"><CheckIcon /><b>Nothing to review</b><span>Most registrations are approved by the rules in seconds; the rest land here.</span></div> : (
              <table className="table">
                <thead><tr><th>Bidder</th><th>Auction</th><th>Why it is here</th><th>Linked accounts</th><th>History</th><th className="r">Waiting</th><th>Decision</th></tr></thead>
                <tbody>{regs.map((r) => {
                  const late = r.targetMinutes !== null && r.waitingSeconds > r.targetMinutes * 60;
                  return (
                    <tr key={r.registrationId} style={{ verticalAlign: 'top' }}>
                      <td><span className="w500">{r.account.name}</span><br /><span className="micro">{words(r.account.tier)} · {words(r.account.verification)}</span></td>
                      <td className="small">{r.auction.title}<br /><span className="muted">{r.auction.code}</span></td>
                      <td><div className="stack-8">{r.reasons.map((x) => <span key={x} className="small">{words(x)}</span>)}</div></td>
                      <td>{r.linkedAccounts.length === 0 ? <span className="muted small">None</span> : r.linkedAccounts.map((l) => (
                        <div key={l.id} className="small"><span className={l.isSellerInAuction ? 'w600' : ''} style={l.isSellerInAuction ? { color: 'var(--bad)' } : undefined}>{l.name}</span>{l.isSellerInAuction ? ' (seller here)' : ''}<br /><span className="muted">{l.sharedSignals.map(words).join(', ')}</span></div>
                      ))}</td>
                      <td className="small">{r.history.invoicesPaid} paid<br /><span className={r.history.defaults ? '' : 'muted'} style={r.history.defaults ? { color: 'var(--bad)' } : undefined}>{r.history.defaults} default{r.history.defaults === 1 ? '' : 's'}</span></td>
                      <td className="r mono" style={late ? { color: 'var(--bad)' } : undefined}>{duration(r.waitingSeconds)}</td>
                      <td>{decide ? (
                        <div className="btn-group">
                          <Action url={`/staff/risk/registrations/${r.registrationId}/decision`} body={{ decision: 'approved' }} label="Approve" note="reason:Why approve?" icon={<CheckIcon />} />
                          <Action url={`/staff/risk/registrations/${r.registrationId}/decision`} body={{ decision: 'rejected' }} label="Reject" tone="danger" note="reason:Why reject? The bidder is told in plain words." icon={<XMarkIcon />} />
                        </div>
                      ) : <span className="muted small">View only</span>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
          </div>
        </section>

        <section className="pnl c-6">
          <header><LinkIcon /><h2>Link clusters</h2><span className="badge">{clusters?.length ?? 0}</span></header>
          <div className="body flush">
            {(clusters ?? []).length === 0 ? <div className="empty"><LinkIcon /><b>No linked accounts</b><span>Accounts sharing a device, phone or payout account are grouped here.</span></div> : clusters!.map((c, i) => (
              <div key={i} style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                <div className="row between"><span className="w500">{c.size} accounts</span><span className="micro">{c.signalTypes.map(words).join(' · ')}</span></div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{c.accounts.map((a) => <span key={a.id} className={`chip${a.isSeller ? ' accent' : ''}`}>{a.name}{a.isSeller ? ' · seller' : ''}</span>)}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="pnl c-6">
          <header><FingerPrintIcon /><h2>Anomalies</h2></header>
          <div className="body flush">
            {!anomalies || anomalies.bidUp.length + anomalies.sharedSignals.length === 0 ? <div className="empty"><FingerPrintIcon /><b>No patterns found</b><span>Repeated bidding on one seller’s lots without winning, and signals shared across accounts.</span></div> : (
              <table className="table">
                <thead><tr><th>Pattern</th><th>Accounts</th><th className="r">Detail</th></tr></thead>
                <tbody>
                  {anomalies.bidUp.map((b, i) => (
                    <tr key={`b${i}`}><td><span className="status warn"><span className="ring" /> Bid-up</span></td><td className="small">{b.bidder.name} on {b.seller.name}’s lots{b.linkedToSeller ? ' · linked to seller' : ''}</td><td className="r mono small">{b.lotsBid} bid · {b.lotsWon} won</td></tr>
                  ))}
                  {anomalies.sharedSignals.map((s, i) => (
                    <tr key={`s${i}`}><td><span className="status info"><span className="ring" /> {words(s.signalType)}</span></td><td className="small">{s.accounts.map((a) => a.name).join(', ')}</td><td className="r mono small">{s.signal}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="pnl c-12">
          <header><NoSymbolIcon /><h2>Restricted accounts</h2><span className="badge">{restricted?.length ?? 0}</span></header>
          <div className="body flush">
            {(restricted ?? []).length === 0 ? <div className="empty"><NoSymbolIcon /><b>No restricted accounts</b><span>A tier change to restricted is a two-person override.</span></div> : (
              <table className="table">
                <thead><tr><th>Account</th><th>Tier</th><th>Reason</th><th>Since</th><th>Until</th></tr></thead>
                <tbody>{restricted!.map((r) => (
                  <tr key={r.id}><td className="w500">{r.name}</td><td>{words(r.tier)}</td><td className="small">{r.reason ?? '—'}</td><td className="small">{r.since ? shortDateTime(r.since) : '—'}</td><td className="small">{r.restrictedUntil ? shortDateTime(r.restrictedUntil) : 'Until reviewed'}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
