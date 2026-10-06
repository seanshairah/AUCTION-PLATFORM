import { CarFront, Clock, Gavel, Wallet } from 'lucide-react';
import Link from 'next/link';
import { FilterPanel } from '@/components/FilterPanel';
import { LotCard } from '@/components/LotCard';
import { Topbar } from '@/components/Topbar';
import { api, apiOrNull } from '@/lib/api';
import type { Facets, LotCard as Lot, Me, MyBid, Wallet as WalletT } from '@/lib/types';

export const metadata = { title: 'Auctions' };

const KEYS = ['q', 'category', 'make', 'model', 'yearFrom', 'yearTo', 'bodyStyle', 'transmission', 'fuel', 'drive', 'branch', 'maxPrice', 'noReserve', 'endingWithinHours', 'sort'];

const CHIPS: Array<{ label: string; set: Record<string, string> }> = [
  { label: 'All lots', set: {} },
  { label: 'Vehicles', set: { category: 'vehicles' } },
  { label: 'Ending in 24 h', set: { endingWithinHours: '24' } },
  { label: 'No reserve', set: { noReserve: '1' } },
];

const SORTS = [
  ['ending_soon', 'Ending soonest'],
  ['most_bids', 'Most bids'],
  ['price_low', 'Price: low to high'],
  ['price_high', 'Price: high to low'],
  ['newest', 'Newly listed'],
];

function hrefWith(params: Record<string, string>, set: Record<string, string>, clear: string[] = []): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (!clear.includes(k) && v) next.set(k, v);
  for (const [k, v] of Object.entries(set)) next.set(k, v);
  const s = next.toString();
  return s ? `/auctions?${s}` : '/auctions';
}

export default async function AuctionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params: Record<string, string> = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v !== '') params[k] = v;
  }
  const qs = new URLSearchParams(params).toString();
  const [list, facets, me, all] = await Promise.all([
    api<{ lots: Lot[]; total: number }>(`/lots${qs ? `?${qs}` : ''}`),
    api<Facets>('/lots/facets'),
    apiOrNull<Me>('/me'),
    api<{ lots: Lot[]; total: number }>('/lots?endingWithinHours=24'),
  ]);
  const [bids, wallet] = me ? await Promise.all([apiOrNull<MyBid[]>('/me/bids'), apiOrNull<WalletT>('/me/wallet')]) : [null, null];
  const liveCount = (facets.category ?? []).reduce((n, c) => n + c.count, 0);
  const leading = bids?.filter((b) => b.status === 'leading').length ?? 0;
  const outbid = bids?.filter((b) => b.status === 'outbid').length ?? 0;
  const usd = wallet?.balances.find((b) => b.currency === 'USD');
  const chipActive = (set: Record<string, string>) =>
    Object.keys(set).length === 0
      ? !params.category && !params.endingWithinHours && !params.noReserve
      : Object.entries(set).every(([k, v]) => params[k] === v);

  return (
    <>
      <Topbar title="Auctions" sub="Timed online auctions · prices include levy and VAT" me={me} q={params.q} />
      <div className="content">
        <section className="stats" aria-label="Summary">
          <div className="card stat"><span className="icon"><CarFront size={20} /></span><div><div className="value">{liveCount}</div><div className="label">Live lots</div></div></div>
          <div className="card stat"><span className="icon"><Clock size={20} /></span><div><div className="value">{all.total}</div><div className="label">Ending in 24 hours</div></div></div>
          <div className="card stat"><span className="icon"><Gavel size={20} /></span><div><div className="value">{me ? `${leading} leading` : '—'}</div><div className="label">{me ? `${outbid} outbid` : 'Sign in to bid'}</div></div></div>
          <div className="card stat"><span className="icon"><Wallet size={20} /></span><div><div className="value">{usd ? usd.available.text : '—'}</div><div className="label">{usd ? `Wallet available · ${usd.held.text} held` : 'Wallet'}</div></div></div>
        </section>
        <div className="dash">
          <section>
            <div className="toolbar">
              {CHIPS.map((c) => (
                <Link key={c.label} href={hrefWith(params, c.set, ['category', 'endingWithinHours', 'noReserve'])} className={`chip${chipActive(c.set) ? ' active' : ''}`}>
                  {c.label}
                </Link>
              ))}
              <span className="spacer" />
              <form action="/auctions" className="row">
                {Object.entries(params).filter(([k]) => k !== 'sort').map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                <select name="sort" defaultValue={params.sort ?? 'ending_soon'} aria-label="Sort">
                  {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <button className="btn ghost" style={{ height: 34 }} type="submit">Sort</button>
              </form>
            </div>
            <p className="muted small" style={{ margin: '0 0 12px' }}>
              {list.total} {list.total === 1 ? 'lot' : 'lots'}{params.q ? ` matching “${params.q}”` : ''}
            </p>
            {list.lots.length === 0 ? (
              <div className="card empty">
                <h3>No lots match these filters</h3>
                <p>Try fewer filters, or <Link href="/auctions" style={{ color: 'var(--accent)' }}>see all live lots</Link>.</p>
              </div>
            ) : (
              <div className="grid">
                {list.lots.map((lot) => <LotCard key={lot.id} lot={lot} />)}
              </div>
            )}
          </section>
          <FilterPanel facets={facets} params={params} />
        </div>
      </div>
    </>
  );
}
