import { BanknotesIcon, LockClosedIcon, PlusIcon } from '@heroicons/react/20/solid';
import { PayMarks } from '@/components/Marks';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import type { Wallet } from '@/lib/types';

export const metadata = { title: 'Wallet' };

const METHOD: Record<string, string> = { branch_cash: 'Cash at branch', ecocash: 'EcoCash', onemoney: 'OneMoney', innbucks: 'InnBucks', omari: "O'mari", zimswitch: 'ZimSwitch', card: 'Card', bank_transfer: 'Bank transfer', wallet: 'Wallet' };

export default async function WalletPage() {
  const wallet = (await apiOrNull<Wallet>('/me/wallet')) ?? { balances: [], holds: [], payments: [] };
  const usd = wallet.balances.find((b) => b.currency === 'USD');
  const zwg = wallet.balances.find((b) => b.currency === 'ZWG');
  return (
    <>
      <div className="acc-title">
        <div>
          <h1>Wallet</h1>
          <p>One balance per currency, never mixed. Deposits are held, not spent, and come back when the auction settles.</p>
        </div>
        <button className="btn" disabled title="Mobile-money top-ups open with the payments launch (Q7)"><PlusIcon /> Top up</button>
      </div>
      <div className="kpis" style={{ ['--n' as string]: 4, marginBottom: 16 }}>
        <div className="kpi"><span className="micro">US$ available</span><span className="v">{usd?.available.text ?? 'US$0.00'}</span></div>
        <div className="kpi"><span className="micro">US$ held as deposits</span><span className="v">{usd?.held.text ?? 'US$0.00'}</span></div>
        <div className="kpi"><span className="micro">ZiG available</span><span className="v">{zwg?.available.text ?? '—'}</span></div>
        <div className="kpi"><span className="micro">ZiG held</span><span className="v">{zwg?.held.text ?? '—'}</span></div>
      </div>
      <div className="notice info" style={{ marginBottom: 16 }}>
        <BanknotesIcon />
        <span>EcoCash, OneMoney, InnBucks, ZimSwitch and card top-ups open with the payments launch. Until then, top up with cash at the Harare or Bulawayo counter and keep your receipt number.</span>
      </div>
      <div className="nest" style={{ marginBottom: 16 }}>
        <div className="nest-head"><LockClosedIcon /><h3>Held deposits</h3><span className="badge">{wallet.holds.length}</span></div>
        <div className="nest-body" style={{ padding: 0 }}>
          {wallet.holds.length === 0 ? <p className="muted" style={{ padding: 16 }}>Nothing held.</p> : (
            <table className="table"><tbody>
              {wallet.holds.map((h) => <tr key={h.id}><td className="w500">{h.description}</td><td className="muted small">Since {shortDateTime(h.since)}</td><td className="r mono">{h.amount.text}</td></tr>)}
            </tbody></table>
          )}
        </div>
      </div>
      <div className="nest">
        <div className="nest-head"><BanknotesIcon /><h3>Payments in</h3><span className="badge">{wallet.payments.length}</span></div>
        <div className="nest-body" style={{ padding: 0 }}>
          {wallet.payments.length === 0 ? <p className="muted" style={{ padding: 16 }}>No payments yet.</p> : (
            <table className="table">
              <thead><tr><th>When</th><th>Method</th><th>Status</th><th>Receipt</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {wallet.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="small">{shortDateTime(p.at)}</td>
                    <td>{METHOD[p.method] ?? p.method}</td>
                    <td><span className={`status ${p.status === 'succeeded' ? 'good' : 'neutral'}`}><span className="ring" style={p.status === 'succeeded' ? { background: 'currentColor' } : undefined} />{p.status === 'succeeded' ? 'Received' : p.status}</span></td>
                    <td className="mono small muted">{p.receipt ?? '—'}</td>
                    <td className="r mono">{p.amount.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div style={{ marginTop: 24 }}><div className="micro" style={{ marginBottom: 8 }}>Ways to pay</div><PayMarks /></div>
    </>
  );
}
