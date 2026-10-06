import Link from 'next/link';
import { BODY_LABEL, titleCase } from '@/lib/format';
import type { Facets } from '@/lib/types';

/**
 * Filters as a plain GET form: works without JavaScript and on slow connections
 * (lite mode), and every filtered view has a shareable, crawlable URL.
 */
export function FilterPanel({ facets, params }: { facets: Facets; params: Record<string, string> }) {
  const years = (facets.year ?? []).map((y) => y.value);
  const option = (list: Facets[string] | undefined, label: (v: string) => string = titleCase) =>
    (list ?? []).map((f) => (
      <option key={f.value} value={f.value}>
        {label(f.value)} ({f.count})
      </option>
    ));
  return (
    <aside className="card filters">
      <h3>
        Filters <Link href="/auctions">Reset</Link>
      </h3>
      <form action="/auctions">
        {params.q && <input type="hidden" name="q" value={params.q} />}
        {params.category && <input type="hidden" name="category" value={params.category} />}
        {params.sort && <input type="hidden" name="sort" value={params.sort} />}
        <div className="field">
          <label htmlFor="f-make">Make</label>
          <select id="f-make" name="make" defaultValue={params.make ?? ''}>
            <option value="">Any make</option>
            {option(facets.make, (v) => v)}
          </select>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="f-yf">Year from</label>
            <select id="f-yf" name="yearFrom" defaultValue={params.yearFrom ?? ''}>
              <option value="">Any</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-yt">Year to</label>
            <select id="f-yt" name="yearTo" defaultValue={params.yearTo ?? ''}>
              <option value="">Any</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="f-body">Body style</label>
          <select id="f-body" name="bodyStyle" defaultValue={params.bodyStyle ?? ''}>
            <option value="">Any body style</option>
            {option(facets.bodyStyle, (v) => BODY_LABEL[v] ?? v)}
          </select>
        </div>
        <div className="field">
          <label>Transmission</label>
          <div className="seg" role="radiogroup" aria-label="Transmission">
            {[['', 'Any'], ['automatic', 'Auto'], ['manual', 'Manual']].map(([v, l]) => (
              <label key={v}>
                <input type="radio" name="transmission" value={v} defaultChecked={(params.transmission ?? '') === v} />
                <span>{l}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="f-fuel">Fuel</label>
            <select id="f-fuel" name="fuel" defaultValue={params.fuel ?? ''}>
              <option value="">Any</option>
              {option(facets.fuel)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-drive">Drive</label>
            <select id="f-drive" name="drive" defaultValue={params.drive ?? ''}>
              <option value="">Any</option>
              {option(facets.drive, (v) => v.toUpperCase())}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="f-max">Current bid up to (US$)</label>
          <input id="f-max" name="maxPrice" inputMode="numeric" pattern="[0-9]*" placeholder="Any" defaultValue={params.maxPrice ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="f-branch">Branch</label>
          <select id="f-branch" name="branch" defaultValue={params.branch ?? ''}>
            <option value="">Harare and Bulawayo</option>
            {option(facets.branch, (v) => (v === 'HRE' ? 'Harare' : v === 'BYO' ? 'Bulawayo' : v))}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" name="noReserve" value="1" defaultChecked={params.noReserve === '1'} /> No reserve only
        </label>
        <button className="btn block" type="submit">Show results</button>
      </form>
    </aside>
  );
}
