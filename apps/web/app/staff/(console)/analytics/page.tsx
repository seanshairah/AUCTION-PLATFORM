import { ArchiveBoxIcon, ChartBarIcon, TableCellsIcon } from '@heroicons/react/20/solid';
import { AutoSubmit } from '@/components/AutoSubmit';
import { Action } from '@/components/staff/Action';
import { BarChart, RangeChart } from '@/components/staff/Charts';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { can, duration, pct, staffMe, words } from '@/lib/staff';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Analytics' };

interface Timing { cohort: number; completed: number; medianSeconds: number | null; p90Seconds: number | null }
interface Measures {
  period: { from: string; to: string; branch: string | null };
  registrationToFirstBid: Timing;
  inAppPayments: Array<{ currency: string; depositCount: number; depositInAppCount: number; depositShare: number | null; deposits: Money; depositsInApp: Money; winningCount: number; winningInAppCount: number; winningsShare: number | null; winnings: Money }>;
  hammerToPayment: Timing;
  sellThrough: { offered: number; sold: number; rate: number | null; byCategory: Array<{ category: string; offered: number; sold: number; rate: number | null }> };
  defaults: { invoices: number; overdue: number; defaulted: number; cured: number; defaultRate: number | null; cureRate: number | null; recoveryRate: number | null };
  bidsPerLot: { lots: number; lotsWithBids: number; bids: number; averageBids: number | null; medianBids: number | null; averageUniqueBidders: number | null };
  inspectionCoverage: { vehicleLots: number; withReport: number; share: number | null };
  saleToPayout: Timing;
  support: { instrumented: boolean; tickets: number; sales: number; ticketsPer100Sales: number | null; replied: number; medianFirstReplySeconds: number | null };
  realisedPrices: Array<{ category: string; currency: string; lotsSold: number; medianHammer: Money; minHammer: Money; maxHammer: Money; totalHammer: Money }>;
  revenue: Array<{ currency: string; lines: Array<{ type: string; amount: Money }>; netRevenue: Money; grossHammer: Money }>;
  gatewaySuccess: Array<{ gateway: string; currency: string; attempts: number; succeeded: number; rate: number | null }>;
}
interface Baseline { id: string; label: string; from: string; to: string; branch: string | null; frozenAt: string; notes: string | null }

const CATEGORY: Record<string, string> = {
  vehicles: 'Vehicles', vehicles_used_zw: 'Used vehicles (ZW)', it: 'IT and electronics', catering: 'Catering equipment',
  furniture: 'Furniture', general: 'General goods', special: 'Special auctions',
};
const cat = (c: string) => CATEGORY[c] ?? words(c);

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}
const usd = (n: number) => `US$${n >= 1000 ? `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : n.toFixed(0)}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; branch?: string }> }) {
  const me = (await staffMe())!;
  const sp = await searchParams;
  const today = new Date();
  const from = sp.from ?? iso(new Date(today.getTime() - 30 * 86_400_000));
  const to = sp.to ?? iso(new Date(today.getTime() + 86_400_000));
  const branch = sp.branch && /^[A-Z]{2,5}$/.test(sp.branch) ? sp.branch : '';
  const qs = `from=${from}&to=${to}${branch ? `&branch=${branch}` : ''}`;
  const [m, baselines] = await Promise.all([apiOrNull<Measures>(`/staff/analytics/measures?${qs}`), apiOrNull<Baseline[]>('/staff/analytics/baselines')]);
  if (!m) return <div className="notice bad">Your role cannot see analytics.</div>;

  const st = m.sellThrough;
  const usdPrices = m.realisedPrices.filter((r) => r.currency === 'USD');
  const priceMax = niceMax(Math.max(0, ...usdPrices.map((r) => Number(r.maxHammer.minor) / 100)));
  const usdRevenue = m.revenue.find((r) => r.currency === 'USD');
  const tiles: Array<[string, string, string]> = [
    ['Registration to first bid', duration(m.registrationToFirstBid.medianSeconds), `median · p90 ${duration(m.registrationToFirstBid.p90Seconds)} · ${m.registrationToFirstBid.completed}/${m.registrationToFirstBid.cohort} bid`],
    ['Hammer to payment', duration(m.hammerToPayment.medianSeconds), `median · ${m.hammerToPayment.completed}/${m.hammerToPayment.cohort} paid`],
    ['Sale to seller payout', duration(m.saleToPayout.medianSeconds), `median · ${m.saleToPayout.completed}/${m.saleToPayout.cohort} paid out`],
    ['First support reply', duration(m.support.medianFirstReplySeconds), `median · ${m.support.replied}/${m.support.tickets} replied`],
    ['Bids per lot', m.bidsPerLot.averageBids === null ? '—' : m.bidsPerLot.averageBids.toFixed(1), `average · median ${m.bidsPerLot.medianBids ?? '—'}`],
    ['Bidders per lot', m.bidsPerLot.averageUniqueBidders === null ? '—' : m.bidsPerLot.averageUniqueBidders.toFixed(1), `average unique bidders`],
    ['Inspection coverage', pct(m.inspectionCoverage.share), `${m.inspectionCoverage.withReport}/${m.inspectionCoverage.vehicleLots} vehicles with a report`],
    ['Default rate', pct(m.defaults.defaultRate, 1), `${m.defaults.defaulted} of ${m.defaults.invoices} invoices · cure ${pct(m.defaults.cureRate)}`],
  ];

  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><ChartBarIcon /> Deliverable 19 · Blueprint §9 measures</span>
          <h1>Analytics</h1>
          <p>The measures the blueprint asks ABC to track, read from the ledger and the auction engine through the read connection. Freeze a baseline before changing anything, then compare.</p>
        </div>
      </div>

      <form className="fbar" method="get">
        <AutoSubmit />
        <label>From <input className="input mono" type="date" name="from" defaultValue={from} /></label>
        <label>To <input className="input mono" type="date" name="to" defaultValue={to} /></label>
        <label>Branch
          <select className="input" name="branch" defaultValue={branch}>
            <option value="">All branches</option><option value="HRE">Harare</option><option value="BYO">Bulawayo</option>
          </select>
        </label>
        <noscript><button className="btn sm ghost">Apply</button></noscript>
        <span className="small muted" style={{ marginLeft: 'auto' }}>{shortDateTime(m.period.from)} to {shortDateTime(m.period.to)}</span>
      </form>

      <div className="cgrid">
        <section className="pnl c-12">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }} className="ana-top">
            <div className="hero-fig" style={{ borderRight: '1px solid var(--line)' }}>
              <span className="micro">Sell-through</span>
              <span className="fig">{st.rate === null ? '—' : Math.round(st.rate * 100)}<small>%</small></span>
              <span className="small ink-2">{st.sold} of {st.offered} lots offered were sold.</span>
              <div className="meter" style={{ marginTop: 8 }}><i style={{ width: `${(st.rate ?? 0) * 100}%` }} /></div>
            </div>
            <div className="tiles" style={{ alignSelf: 'stretch' }}>
              {tiles.map(([k, v, s], i) => (
                <div key={k} className="tile" style={i < 4 ? { borderTop: 0 } : undefined}><span className="micro">{k}</span><span className="v">{v}</span><span className="s">{s}</span></div>
              ))}
            </div>
          </div>
        </section>

        <section className="pnl c-6">
          <header><ChartBarIcon /><h2>Sell-through by category</h2></header>
          <div className="body stack">
            {st.byCategory.length === 0 ? <div className="empty">No lots closed in this period.</div> : (
              <BarChart
                max={1}
                ticks={['0%', '25%', '50%', '75%', '100%']}
                rows={st.byCategory.map((c) => ({ label: cat(c.category), value: c.rate ?? 0, display: pct(c.rate), tip: [['Offered', String(c.offered)], ['Sold', String(c.sold)], ['Rate', pct(c.rate, 1)]] }))}
              />
            )}
            <details className="as-table"><summary><TableCellsIcon /> Show as table</summary>
              <table className="table"><thead><tr><th>Category</th><th className="r">Offered</th><th className="r">Sold</th><th className="r">Rate</th></tr></thead>
                <tbody>{st.byCategory.map((c) => <tr key={c.category}><td>{cat(c.category)}</td><td className="r mono">{c.offered}</td><td className="r mono">{c.sold}</td><td className="r mono">{pct(c.rate, 1)}</td></tr>)}</tbody></table>
            </details>
          </div>
        </section>

        <section className="pnl c-6">
          <header><ChartBarIcon /><h2>Realised hammer prices (USD)</h2><span className="right micro">Low to high · dot is the median</span></header>
          <div className="body stack">
            {usdPrices.length === 0 ? <div className="empty">No USD lots sold in this period.</div> : (
              <RangeChart
                max={priceMax}
                ticks={[0, 0.5, 1].map((f) => usd(priceMax * f))}
                rows={usdPrices.map((r) => ({
                  label: cat(r.category), min: Number(r.minHammer.minor) / 100, median: Number(r.medianHammer.minor) / 100, max: Number(r.maxHammer.minor) / 100,
                  display: r.medianHammer.text.replace('.00', ''),
                  tip: [['Lots sold', String(r.lotsSold)], ['Median', r.medianHammer.text], ['Low', r.minHammer.text], ['High', r.maxHammer.text], ['Total', r.totalHammer.text]],
                }))}
              />
            )}
            <details className="as-table"><summary><TableCellsIcon /> Show as table</summary>
              <table className="table"><thead><tr><th>Category</th><th className="r">Sold</th><th className="r">Low</th><th className="r">Median</th><th className="r">High</th></tr></thead>
                <tbody>{m.realisedPrices.map((r) => <tr key={`${r.category}${r.currency}`}><td>{cat(r.category)} <span className="micro">{r.currency}</span></td><td className="r mono">{r.lotsSold}</td><td className="r mono">{r.minHammer.text}</td><td className="r mono">{r.medianHammer.text}</td><td className="r mono">{r.maxHammer.text}</td></tr>)}</tbody></table>
            </details>
          </div>
        </section>

        <section className="pnl c-6">
          <header><ChartBarIcon /><h2>Paid in the app</h2><span className="right micro">Share of money paid without visiting a branch</span></header>
          <div className="body flush">
            <table className="table">
              <thead><tr><th>Currency</th><th>Deposits</th><th className="r">Share</th><th>Winning invoices</th><th className="r">Share</th></tr></thead>
              <tbody>{m.inAppPayments.length === 0 ? <tr><td colSpan={5} className="muted">No payments in this period.</td></tr> : m.inAppPayments.map((p) => (
                <tr key={p.currency}>
                  <td className="mono">{p.currency}</td>
                  <td style={{ minWidth: 140 }}><div className="meter"><i style={{ width: `${(p.depositShare ?? 0) * 100}%` }} /></div><span className="small muted">{p.depositInAppCount}/{p.depositCount} · {p.depositsInApp.text} of {p.deposits.text}</span></td>
                  <td className="r mono">{pct(p.depositShare)}</td>
                  <td style={{ minWidth: 140 }}><div className="meter"><i style={{ width: `${(p.winningsShare ?? 0) * 100}%` }} /></div><span className="small muted">{p.winningInAppCount}/{p.winningCount}</span></td>
                  <td className="r mono">{pct(p.winningsShare)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        <section className="pnl c-6">
          <header><ChartBarIcon /><h2>Revenue (USD)</h2><span className="right micro">Recognised on payment</span></header>
          <div className="body">
            <div className="row" style={{ gap: 32, flexWrap: 'wrap' }}>
              <div className="stack-8"><span className="micro">Net revenue</span><span className="mono" style={{ fontSize: 28, fontWeight: 500 }}>{usdRevenue?.netRevenue.text ?? 'US$0.00'}</span></div>
              <div className="stack-8"><span className="micro">Gross hammer</span><span className="mono" style={{ fontSize: 28, fontWeight: 500, color: 'var(--ink-2)' }}>{usdRevenue?.grossHammer.text ?? 'US$0.00'}</span></div>
            </div>
            {usdRevenue && usdRevenue.lines.length > 0 && (
              <table className="table" style={{ marginTop: 12 }}><tbody>{usdRevenue.lines.map((l) => <tr key={l.type}><td>{words(l.type)}</td><td className="r mono">{l.amount.text}</td></tr>)}</tbody></table>
            )}
            {m.gatewaySuccess.length > 0 && (
              <table className="table" style={{ marginTop: 12 }}><thead><tr><th>Gateway</th><th className="r">Attempts</th><th className="r">Succeeded</th></tr></thead>
                <tbody>{m.gatewaySuccess.map((g) => <tr key={`${g.gateway}${g.currency}`}><td>{words(g.gateway)} <span className="micro">{g.currency}</span></td><td className="r mono">{g.attempts}</td><td className="r mono">{pct(g.rate)}</td></tr>)}</tbody></table>
            )}
          </div>
        </section>

        <section className="pnl c-12">
          <header><ArchiveBoxIcon /><h2>Baselines</h2><span className="badge">{baselines?.length ?? 0}</span>
            {can(me, 'analytics.baseline.freeze') && <span className="right"><Action url="/staff/analytics/baselines" body={{ from, to, ...(branch ? { branch } : {}) }} label="Freeze this period as a baseline" tone="ink" note="label:Label, e.g. baseline-2026-11" done="Baseline frozen. It can never be edited." /></span>}
          </header>
          <div className="body flush">
            {(baselines ?? []).length === 0 ? <div className="empty"><ArchiveBoxIcon /><b>No baseline yet</b><span>Blueprint §9: the first task is a baseline. A frozen baseline is append-only.</span></div> : (
              <table className="table"><thead><tr><th>Label</th><th>Period</th><th>Branch</th><th>Frozen</th><th>Notes</th></tr></thead>
                <tbody>{baselines!.map((b) => <tr key={b.id}><td className="mono w500">{b.label}</td><td className="small">{shortDateTime(b.from)} to {shortDateTime(b.to)}</td><td>{b.branch ?? 'All'}</td><td className="small">{shortDateTime(b.frozenAt)}</td><td className="small muted">{b.notes ?? '—'}</td></tr>)}</tbody></table>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
