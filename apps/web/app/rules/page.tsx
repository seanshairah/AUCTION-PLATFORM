import { BookOpenIcon, ChevronRightIcon } from '@heroicons/react/20/solid';
import { api } from '@/lib/api';
import type { Rulebook } from '@/lib/types';

export const metadata = { title: 'Fees and rules' };

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default async function RulesPage() {
  const rules = await api<Rulebook>('/rules');
  return (
    <>
      <section className="page-band">
        <div className="wrap inner">
          <div>
            <div className="micro" style={{ color: 'var(--night-muted)' }}><BookOpenIcon width={14} style={{ verticalAlign: '-2px' }} /> Rule set {rules.versionLabel}</div>
            <h1 className="display d-lg" style={{ marginTop: 8 }}>Fees and rules</h1>
            <p className="lead" style={{ color: 'var(--night-muted)', marginTop: 12 }}>One rulebook prices every lot, every commit screen and every invoice, so they can never disagree.</p>
          </div>
        </div>
      </section>
      <div className="wrap rules-layout">
        <nav className="rail-filters" aria-label="Sections">
          {rules.sections.map((s) => (
            <a key={s.section} href={`#${slug(s.section)}`} className="row between" style={{ padding: '10px 0', borderTop: '1px solid var(--line)', color: 'var(--ink-2)', fontWeight: 500 }}>
              {s.section}<ChevronRightIcon width={16} style={{ color: 'var(--muted)' }} />
            </a>
          ))}
        </nav>
        <div className="stack">
          {rules.sections.map((s) => (
            <section key={s.section} id={slug(s.section)} className="panel">
              <div className="panel-head"><h2>{s.section}</h2><span className="badge">{s.rules.length}</span></div>
              <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
                {s.rules.map((r) => (
                  <div key={r.key} style={{ padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600 }}>{r.title}</h3>
                    <p className="ink-2" style={{ marginTop: 4, maxWidth: '72ch' }}>{r.text}</p>
                    {r.overrides.map((o, i) => <p key={i} className="small ink-2" style={{ marginTop: 4, paddingLeft: 12, borderLeft: '2px solid var(--line)' }}>{o.text}</p>)}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
