import { notFound } from 'next/navigation';
import { AddLot } from '@/components/seller/AddLot';
import { SignNote } from '@/components/seller/SignNote';
import { apiOrNull } from '@/lib/api';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Consignment' };

interface Consignment {
  id: string; status: string; type: string; branch: string; createdAt: string; signedAt: string | null;
  lots: Array<{ id: string; ref: string; title: string; category: string; state: string; condition: string; startingBid: Money; reserve: Money | null }>;
}
interface Vocabulary { categories: Array<{ code: string; label: string }>; itemStates: Array<{ code: string; label: string }>; conditions: Array<{ code: string; label: string }> }

export default async function ConsignmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [c, vocab] = await Promise.all([apiOrNull<Consignment>(`/seller/consignments/${id}`), apiOrNull<Vocabulary>('/seller/vocabulary')]);
  if (!c || !vocab) notFound();
  const open = c.status === 'draft' || c.status === 'submitted';
  return (
    <>
      <div className="acc-title">
        <div>
          <h1>Consignment · {c.branch === 'HRE' ? 'Harare' : 'Bulawayo'}</h1>
          <p>{c.type === 'commission' ? 'Commission sale' : 'Outright purchase'} · started {new Date(c.createdAt).toLocaleDateString('en-ZW', { day: 'numeric', month: 'long' })}{c.signedAt ? ` · signed ${new Date(c.signedAt).toLocaleDateString('en-ZW', { day: 'numeric', month: 'long' })}` : ''}</p>
        </div>
        <span className={`status ${c.status === 'signed' ? 'good' : 'neutral'}`}><span className="ring" style={c.status === 'signed' ? { background: 'currentColor' } : undefined} />{c.status === 'signed' ? 'Signed' : 'Draft'}</span>
      </div>
      <div className="nest" style={{ marginBottom: 16 }}>
        <div className="nest-head"><h3>Lots</h3><span className="badge">{c.lots.length}</span></div>
        <div className="nest-body" style={{ padding: c.lots.length ? 0 : 16 }}>
          {c.lots.length === 0 ? <p className="muted">No lots yet. Add the first one below.</p> : (
            <table className="table">
              <thead><tr><th>Lot</th><th>Category</th><th>Condition</th><th className="r">Starting bid</th><th className="r">Your reserve</th></tr></thead>
              <tbody>{c.lots.map((l) => <tr key={l.id}><td><span className="w500">{l.title}</span><br /><span className="micro">{l.ref}</span></td><td className="small">{vocab.categories.find((x) => x.code === l.category)?.label ?? l.category}</td><td className="small">{vocab.conditions.find((x) => x.code === l.condition)?.label ?? l.condition}</td><td className="r mono">{l.startingBid.text}</td><td className="r mono">{l.reserve?.text ?? 'None'}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
      {open && <AddLot consignmentId={c.id} vocab={vocab} />}
      {c.lots.length > 0 && <SignNote consignmentId={c.id} signed={!open} />}
    </>
  );
}
