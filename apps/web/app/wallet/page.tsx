import { redirect } from 'next/navigation';
import { Topbar } from '@/components/Topbar';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import type { Me, Wallet } from '@/lib/types';

export const metadata = { title: 'Wallet' };

const METHOD: Record<string, string> = { branch_cash: 'Cash at branch', ecocash: 'EcoCash', onemoney: 'OneMoney', innbucks: 'InnBucks', omari: "O'mari", zimswitch: 'ZimSwitch', card: 'Card', bank_transfer: 'Bank transfer', wallet: 'Wallet' };

export default async function WalletPage() {
  const me = await apiOrNull<Me>('/me');
  if (!me) redirect('/sign-in?next=/wallet');
  const wallet = (await apiOrNull<Wallet>('/me/wallet')) ?? { balances: [], holds: [], payments: [] };
  return (
    <>
      <Topbar title="Wallet" sub="One wallet per currency. Deposits are held, not spent, and come back when the auction settles." me={me} />
      <div className="content stack" style={{ gap: 20 }}>
        <div className="accounts">
          {wallet.balances.length === 0 && <div className="card balance"><div className="muted">No money in your wallet yet.</div></div>}
          {wallet.balances.map((b) => (
            <div key={b.currency} className="card balance">
              <div className="price-label">{b.currency === 'USD' ? 'US dollars' : 'ZiG'} available</div>
              <div className="big">{b.available.text}</div>
              <div className="small muted">{b.held.text} held as deposits</div>
            </div>
          ))}
        </div>
        <div className="notice info">Top-ups by EcoCash, OneMoney, InnBucks, ZimSwitch or card are coming with the payments launch (pending the wallet regulation question, Q7). Until then, top up with cash at a branch.</div>
        <section className="card">
          <div className="section" style={{ paddingBottom: 0 }}><h2>Held deposits</h2></div>
          {wallet.holds.length === 0 ? <div className="section muted">Nothing held.</div> : (
            <table className="table"><tbody>
              {wallet.holds.map((h) => <tr key={h.id}><td>{h.description}</td><td className="muted">since {shortDateTime(h.since)}</td><td style={{ textAlign: 'right' }}><strong>{h.amount.text}</strong></td></tr>)}
            </tbody></table>
          )}
        </section>
        <section className="card">
          <div className="section" style={{ paddingBottom: 0 }}><h2>Payments in</h2></div>
          {wallet.payments.length === 0 ? <div className="section muted">No payments yet.</div> : (
            <table className="table">
              <thead><tr><th>When</th><th>Method</th><th>Status</th><th>Receipt</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {wallet.payments.map((p) => (
                  <tr key={p.id}><td>{shortDateTime(p.at)}</td><td>{METHOD[p.method] ?? p.method}</td><td><span className={`pill ${p.status === 'succeeded' ? 'good' : 'muted'}`}>{p.status}</span></td><td className="muted">{p.receipt ?? '—'}</td><td style={{ textAlign: 'right' }}><strong>{p.amount.text}</strong></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
