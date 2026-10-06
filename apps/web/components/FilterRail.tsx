import { ChevronDownIcon, MagnifyingGlassIcon } from '@heroicons/react/20/solid';
import { BODY_LABEL, titleCase } from '@/lib/format';
import type { Facets } from '@/lib/types';
import { AutoSubmit } from './AutoSubmit';

function Group({ title, open = true, children }: { title: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="fgroup" open={open}>
      <summary>{title}<ChevronDownIcon /></summary>
      <div className="fbody">{children}</div>
    </details>
  );
}

function Radios({ name, facet, params, label = titleCase }: { name: string; facet: Facets[string] | undefined; params: Record<string, string>; label?: (v: string) => string }) {
  const current = params[name] ?? '';
  return (
    <>
      <label className="opt"><span><input type="radio" name={name} value="" defaultChecked={current === ''} /> Any</span></label>
      {(facet ?? []).map((f) => (
        <label key={f.value} className="opt">
          <span><input type="radio" name={name} value={f.value} defaultChecked={current === f.value} /> {label(f.value)}</span>
          <span className="count">{f.count}</span>
        </label>
      ))}
    </>
  );
}

/**
 * The docket's filters: one GET form, so every filtered view has a URL and works
 * without JavaScript on slow connections. With JavaScript, changes apply at once.
 */
export function FilterRail({ facets, params }: { facets: Facets; params: Record<string, string> }) {
  const years = (facets.year ?? []).map((y) => y.value);
  return (
    <aside className="rail-filters" aria-label="Filters">
      <form action="/auctions">
        <AutoSubmit />
        {['category', 'sort', 'view'].map((k) => params[k] && <input key={k} type="hidden" name={k} value={params[k]} />)}
        <div className="search-in field">
          <MagnifyingGlassIcon />
          <input className="input" name="q" defaultValue={params.q} placeholder="Year, make, model or lot" aria-label="Search the docket" />
        </div>
        <Group title="Make"><Radios name="make" facet={facets.make} params={params} label={(v) => v} /></Group>
        <Group title="Year">
          <div className="row">
            <select className="input" name="yearFrom" defaultValue={params.yearFrom ?? ''} aria-label="Year from">
              <option value="">From</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select className="input" name="yearTo" defaultValue={params.yearTo ?? ''} aria-label="Year to">
              <option value="">To</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </Group>
        <Group title="Body style"><Radios name="bodyStyle" facet={facets.bodyStyle} params={params} label={(v) => BODY_LABEL[v] ?? v} /></Group>
        <Group title="Transmission"><Radios name="transmission" facet={facets.transmission} params={params} /></Group>
        <Group title="Fuel" open={false}><Radios name="fuel" facet={facets.fuel} params={params} /></Group>
        <Group title="Drive" open={false}><Radios name="drive" facet={facets.drive} params={params} label={(v) => v.toUpperCase()} /></Group>
        <Group title="Current bid" open={false}>
          <input className="input" name="maxPrice" inputMode="numeric" pattern="[0-9]*" placeholder="Up to, in US$" defaultValue={params.maxPrice ?? ''} />
        </Group>
        <Group title="Branch" open={false}><Radios name="branch" facet={facets.branch} params={params} label={(v) => (v === 'HRE' ? 'Harare' : v === 'BYO' ? 'Bulawayo' : v)} /></Group>
        <Group title="Reserve">
          <label className="check"><input type="checkbox" name="noReserve" value="1" defaultChecked={params.noReserve === '1'} /> No reserve only</label>
        </Group>
        <div className="fgroup" style={{ paddingTop: 16 }}><button className="btn ink block" type="submit">Apply filters</button></div>
      </form>
    </aside>
  );
}
