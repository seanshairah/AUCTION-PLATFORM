import { demoCredits } from '@/lib/media';
import credits from '@/public/media/demo/vehicles/credits.json';

export const metadata = { title: 'Photo credits' };

export default function CreditsPage() {
  const sets = Object.keys(credits as Record<string, unknown>);
  return (
    <section className="section">
      <div className="wrap" style={{ maxWidth: 880 }}>
        <div className="micro">Demo environment</div>
        <h1 className="display d-lg" style={{ margin: '8px 0 12px' }}>Photo credits</h1>
        <p className="lead" style={{ marginBottom: 24 }}>Demo listings use photos of the same models from Wikimedia Commons, resized. They are not photos of the listed vehicles.</p>
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Set</th><th>File</th><th>Author</th><th>Licence</th></tr></thead>
            <tbody>
              {sets.flatMap((s) => demoCredits(s).map((c) => (
                <tr key={s + c.file}>
                  <td className="micro">{s}</td>
                  <td><a className="link" href={c.source} target="_blank" rel="noreferrer">{c.title}</a></td>
                  <td>{c.artist || '—'}</td>
                  <td>{c.licenseUrl ? <a className="link" href={c.licenseUrl} target="_blank" rel="noreferrer">{c.license}</a> : c.license}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
