import { Topbar } from '@/components/Topbar';
import { api, apiOrNull } from '@/lib/api';
import type { Me, Rulebook } from '@/lib/types';

export const metadata = { title: 'Fees and rules' };

export default async function RulesPage() {
  const [rules, me] = await Promise.all([api<Rulebook>('/rules'), apiOrNull<Me>('/me')]);
  return (
    <>
      <Topbar title="Fees and rules" sub={`Plain-language rulebook · rule set ${rules.versionLabel}. The same rules price every lot and every invoice.`} me={me} />
      <div className="content stack" style={{ gap: 20 }}>
        {rules.sections.map((s) => (
          <section key={s.section} className="card rules-section">
            <h2 style={{ fontSize: 17, marginBottom: 6 }}>{s.section}</h2>
            {s.rules.map((r) => (
              <div key={r.key} className="rule">
                <h4>{r.title}</h4>
                <p>{r.text}</p>
                {r.overrides.map((o, i) => <p key={i} className="small" style={{ marginTop: 4 }}>{o.text}</p>)}
              </div>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
