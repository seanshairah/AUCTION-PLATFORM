import { Bars3Icon, CalendarDaysIcon, MapPinIcon, MagnifyingGlassIcon, Squares2X2Icon, XMarkIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { AutoSubmit } from '@/components/AutoSubmit';
import { FilterRail } from '@/components/FilterRail';
import { LotCard, LotRow } from '@/components/LotCards';
import { SaveSearch } from '@/components/SaveSearch';
import { api, apiOrNull } from '@/lib/api';
import { BODY_LABEL, shortDate, titleCase } from '@/lib/format';
import { HERO_PHOTO } from '@/lib/media';
import type { AuctionSummary, Facets, LotCard as Lot } from '@/lib/types';

export const metadata = { title: 'Docket' };

const KEYS = ['q', 'category', 'make', 'model', 'yearFrom', 'yearTo', 'bodyStyle', 'transmission', 'fuel', 'drive', 'branch', 'maxPrice', 'noReserve', 'endingWithinHours', 'sort', 'view'];
const API_KEYS = KEYS.filter((k) => k !== 'view');

const SORTS = [
  ['ending_soon', 'Ending soonest'],
  ['most_bids', 'Most bids'],
  ['price_low', 'Price, low to high'],
  ['price_high', 'Price, high to low'],
  ['newest', 'Newly listed'],
];

const LABEL: Record<string, (v: string) => string> = {
  q: (v) => `“${v}”`,
  category: (v) => (v === 'vehicles' ? 'Vehicles' : 'Other goods'),
  model: (v) => v,
  make: (v) => v,
  yearFrom: (v) => `From ${v}`,
  yearTo: (v) => `To ${v}`,
  bodyStyle: (v) => BODY_LABEL[v] ?? v,
  transmission: titleCase,
  fuel: titleCase,
  drive: (v) => v.toUpperCase(),
  branch: (v) => (v === 'HRE' ? 'Harare' : v === 'BYO' ? 'Bulawayo' : v),
  maxPrice: (v) => `Up to US$${Number(v).toLocaleString('en-US')}`,
  noReserve: () => 'No reserve',
  endingWithinHours: (v) => `Ending in ${v} h`,
};

function href(params: Record<string, string>, set: Record<string, string | null>): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...set })) if (v) next.set(k, v);
  const s = next.toString();
  return s ? `/auctions?${s}` : '/auctions';
}

export default async function DocketPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params: Record<string, string> = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v !== '') params[k] = v;
  }
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([k]) => API_KEYS.includes(k)))).toString();
  const [list, facets, auctions, me] = await Promise.all([
    api<{ lots: Lot[]; total: number }>(`/lots${qs ? `?${qs}` : ''}`),
    api<Facets>('/lots/facets'),
    api<AuctionSummary[]>('/auctions'),
    apiOrNull<{ id: string }>('/me'),
  ]);
  const a = auctions[0];
  const view = params.view === 'list' ? 'list' : 'grid';
  const cat = facets.category ?? [];
  const count = (v: string) => cat.find((c) => c.value === v)?.count ?? 0;
  const total = cat.reduce((n, c) => n + c.count, 0);
  const active = Object.entries(params).filter(([k]) => LABEL[k]);

  return (
    <>
      <section className="page-band">
        <div className="hero-photo" style={{ backgroundImage: `url(${a?.cover ? `${a.cover}?w=1600` : HERO_PHOTO})` }} aria-hidden />
        <div className="wrap inner">
          <div>
            <div className="micro" style={{ color: 'var(--night-muted)' }}>{a ? a.title : 'All auctions'}</div>
            <h1 className="display d-lg" style={{ marginTop: 8 }}>Docket</h1>
            {a && (
              <div className="row" style={{ gap: 16, marginTop: 12, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--night-muted)' }}>
                <span className="row"><CalendarDaysIcon width={15} /> First close {shortDate(a.firstCloseAt)}</span>
                <span className="row"><MapPinIcon width={15} /> {a.branch.name}</span>
                <span>{a.staggerSeconds ? `Staggered every ${Math.round(a.staggerSeconds / 60)} min` : ''}</span>
              </div>
            )}
          </div>
          <nav className="seg-tabs" aria-label="Category" style={{ background: 'rgba(255,255,255,.08)' }}>
            <Link href={href(params, { category: null })} className={!params.category ? 'on' : ''} style={!params.category ? undefined : { color: 'var(--night-muted)' }}>All <span className="badge">{total}</span></Link>
            <Link href={href(params, { category: 'vehicles' })} className={params.category === 'vehicles' ? 'on' : ''} style={params.category === 'vehicles' ? undefined : { color: 'var(--night-muted)' }}>Vehicles <span className="badge">{count('vehicles')}</span></Link>
            <Link href={href(params, { category: 'other' })} className={params.category === 'other' ? 'on' : ''} style={params.category === 'other' ? undefined : { color: 'var(--night-muted)' }}>Equipment and goods <span className="badge">{count('other')}</span></Link>
          </nav>
        </div>
      </section>

      <div className="wrap docket">
        <FilterRail facets={facets} params={params} />
        <section aria-label="Results">
          <div className="toolbar">
            <span className="w500">{list.total} {list.total === 1 ? 'lot' : 'lots'}</span>
            <span className="muted small">All-in figures include levy and VAT.</span>
            <span className="spacer" />
            <form action="/auctions" className="row">
              <AutoSubmit />
              {Object.entries(params).filter(([k]) => k !== 'sort').map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
              <label className="sr-only" htmlFor="sort">Sort</label>
              <select id="sort" name="sort" defaultValue={params.sort ?? 'ending_soon'}>
                {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <noscript><button className="btn sm ghost" type="submit">Sort</button></noscript>
            </form>
            <div className="btn-group" role="group" aria-label="View">
              <Link href={href(params, { view: null })} className="btn sm ghost" aria-pressed={view === 'grid'} aria-label="Grid view"><Squares2X2Icon /></Link>
              <Link href={href(params, { view: 'list' })} className="btn sm ghost" aria-pressed={view === 'list'} aria-label="List view"><Bars3Icon /></Link>
            </div>
          </div>
          {active.length > 0 && (
            <div className="active-filters">
              {active.map(([k, v]) => (
                <span key={k} className="chip">
                  {LABEL[k]!(v)}
                  <Link className="x" href={href(params, { [k]: null })} aria-label={`Remove ${LABEL[k]!(v)}`}><XMarkIcon /></Link>
                </span>
              ))}
              <Link href="/auctions" className="link small" style={{ alignSelf: 'center', marginLeft: 4 }}>Clear all</Link>
              <span style={{ marginLeft: 'auto' }}>
                <SaveSearch
                  query={Object.fromEntries(active.filter(([k]) => k !== 'sort'))}
                  suggested={active.filter(([k]) => k !== 'sort').map(([k, v]) => LABEL[k]!(v)).join(' · ').replace(/[“”]/g, '')}
                  signedIn={Boolean(me)}
                  next={href(params, {})}
                />
              </span>
            </div>
          )}
          {list.lots.length === 0 ? (
            <div className="card empty">
              <MagnifyingGlassIcon />
              <h3 className="w600">No lots match these filters</h3>
              <p>Remove a filter, or <Link className="link" href="/auctions">see every live lot</Link>.</p>
            </div>
          ) : view === 'list' ? (
            <div className="lot-list">{list.lots.map((l) => <LotRow key={l.id} lot={l} />)}</div>
          ) : (
            <div className="lot-grid">{list.lots.map((l) => <LotCard key={l.id} lot={l} />)}</div>
          )}
        </section>
      </div>
    </>
  );
}
