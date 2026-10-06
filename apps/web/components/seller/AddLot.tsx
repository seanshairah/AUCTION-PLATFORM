'use client';

import { CalculatorIcon, PlusIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Option = { code: string; label: string };
interface Money { text: string }

const toMinor = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 100)) : null;
};

/** Adds a draft lot, showing the valuation range and what the seller receives at the reserve. */
export function AddLot({ consignmentId, vocab }: { consignmentId: string; vocab: { categories: Option[]; itemStates: Option[]; conditions: Option[] } }) {
  const router = useRouter();
  const [f, setF] = useState({ title: '', description: '', category: 'general', itemState: 'used', condition: 'working', conditionNotes: '', start: '', reserve: '' });
  const [valuation, setValuation] = useState<{ low: Money; median: Money; high: Money; comparables: number } | null | undefined>(undefined);
  const [proceeds, setProceeds] = useState<{ lines: Array<{ description: string; amount: Money }>; net: Money | null; message?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    let live = true;
    void fetch(`/api/seller/valuation?category=${f.category}&currency=USD`)
      .then(async (r) => (r.ok ? ((await r.json()) as { range: typeof valuation }).range ?? null : null))
      .catch(() => null)
      .then((v) => live && setValuation(v));
    return () => { live = false; };
  }, [f.category]);

  useEffect(() => {
    const at = toMinor(f.reserve || f.start);
    if (!at) { setProceeds(null); return; }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/seller/proceeds?category=${f.category}&currency=USD&hammerMinor=${at}`);
      if (r.ok) setProceeds(await r.json());
    }, 250);
    return () => clearTimeout(t);
  }, [f.reserve, f.start, f.category]);

  async function add() {
    const start = toMinor(f.start);
    if (!start) { setError('Enter a starting bid.'); return; }
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/seller/consignments/${consignmentId}/lots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: f.title, description: f.description, category: f.category, itemState: f.itemState, condition: f.condition, conditionNotes: f.conditionNotes || undefined, startingBidMinor: start, reserveMinor: toMinor(f.reserve) ?? undefined }),
    });
    setBusy(false);
    if (r.ok) {
      setF({ ...f, title: '', description: '', conditionNotes: '', start: '', reserve: '' });
      router.refresh();
    } else setError(((await r.json()) as { message?: string }).message ?? 'Could not add the lot.');
  }

  return (
    <div className="nest" style={{ marginBottom: 16 }}>
      <div className="nest-head"><PlusIcon /><h3>Add a lot</h3></div>
      <div className="nest-body split">
        <div className="stack">
          <div className="field"><label htmlFor="al-title">Title</label><input id="al-title" className="input" value={f.title} onChange={set('title')} placeholder="2017 Toyota Corolla 1.6 or Honda EU22i generator" /></div>
          <div className="field"><label htmlFor="al-desc">Description</label><textarea id="al-desc" className="input" style={{ height: 96, padding: 12 }} value={f.description} onChange={set('description')} placeholder="What it is, what works, what does not, and what is included." /></div>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="field grow"><label htmlFor="al-cat">Category</label><select id="al-cat" className="input" value={f.category} onChange={set('category')}>{vocab.categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></div>
            <div className="field grow"><label htmlFor="al-state">State</label><select id="al-state" className="input" value={f.itemState} onChange={set('itemState')}>{vocab.itemStates.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></div>
            <div className="field grow"><label htmlFor="al-cond">Condition</label><select id="al-cond" className="input" value={f.condition} onChange={set('condition')}>{vocab.conditions.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></div>
          </div>
          <div className="field"><label htmlFor="al-notes">Condition notes</label><input id="al-notes" className="input" value={f.conditionNotes} onChange={set('conditionNotes')} placeholder="Faults, missing parts, marks" /></div>
          <div className="row" style={{ gap: 12 }}>
            <div className="field grow"><label htmlFor="al-start">Starting bid (US$)</label><div className="amount"><span className="cur">US$</span><input id="al-start" inputMode="decimal" value={f.start} onChange={set('start')} /></div></div>
            <div className="field grow"><label htmlFor="al-res">Your reserve (US$, optional)</label><div className="amount"><span className="cur">US$</span><input id="al-res" inputMode="decimal" value={f.reserve} onChange={set('reserve')} /></div></div>
          </div>
          {error && <div className="notice bad">{error}</div>}
          <div><button className="btn" onClick={add} disabled={busy}><PlusIcon /> {busy ? 'Adding…' : 'Add lot'}</button></div>
        </div>
        <div className="stack">
          <div className="card" style={{ padding: 16 }}>
            <div className="micro" style={{ marginBottom: 8 }}>Valuation from past sales</div>
            {valuation === undefined ? <p className="small muted">Checking…</p> : valuation === null ? <p className="small ink-2">Too few comparable sales in the last 12 months for a range. Staff will value this lot.</p> : (
              <>
                <div className="mono" style={{ fontSize: 18, fontWeight: 500 }}>{valuation.low.text} – {valuation.high.text}</div>
                <p className="small muted">Middle half of {valuation.comparables} comparable sales; median {valuation.median.text}. A guide, not a guarantee.</p>
              </>
            )}
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div className="micro" style={{ marginBottom: 8 }}><CalculatorIcon width={13} style={{ verticalAlign: '-2px' }} /> You receive at {f.reserve ? 'your reserve' : 'the starting bid'}</div>
            {!proceeds ? <p className="small muted">Enter a price to see what you receive.</p> : proceeds.net === null ? <p className="small ink-2">{proceeds.message}</p> : (
              <div className="lines">
                {proceeds.lines.map((l) => <div key={l.description} className="l"><span>{l.description}</span><span>{l.amount.text}</span></div>)}
                <div className="l total"><span>You receive</span><span>{proceeds.net.text}</span></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
