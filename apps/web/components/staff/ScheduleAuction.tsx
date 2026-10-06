'use client';

import { CalendarDaysIcon, CheckIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

interface Lot { id: string; ref: string; title: string; branch: string; state: string; seller: string; startingBid: { text: string } }
interface Attach { lotId: string; attached: boolean; lotNumber?: number; blockers: Array<{ message: string }> }

function local(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 16);
}

/**
 * Schedule a timed auction (docs/18 §5): create it, then attach lots. Each lot is
 * re-checked against listing readiness (published inspection, photos, rules in force)
 * and any blocker comes back in plain words next to the lot.
 */
export function ScheduleAuction({ lots, branches }: { lots: Lot[]; branches: Array<{ code: string; name: string }> }) {
  const router = useRouter();
  const start = useMemo(() => { const d = new Date(Date.now() + 86_400_000); d.setHours(9, 0, 0, 0); return d; }, []);
  const [branch, setBranch] = useState(branches[0]?.code ?? 'HRE');
  const [title, setTitle] = useState('Vehicles: Harare');
  const [opensAt, setOpensAt] = useState(local(start));
  const [closesAt, setClosesAt] = useState(local(new Date(start.getTime() + 3 * 86_400_000 + 9 * 3_600_000)));
  const [stagger, setStagger] = useState(120);
  const [deposit, setDeposit] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [blockers, setBlockers] = useState<Record<string, string>>({});
  const code = `${branch}-${closesAt.slice(0, 10).replaceAll('-', '')}-${title.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'GEN'}`;
  const branchLots = lots.filter((l) => l.branch === branch);

  async function submit() {
    setBusy(true);
    setMsg(null);
    setBlockers({});
    const res = await fetch('/api/staff/auctions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, title, branch, opensAt: new Date(opensAt).toISOString(), firstCloseAt: new Date(closesAt).toISOString(), staggerSeconds: stagger, depositRequired: deposit }),
    });
    const created = (await res.json().catch(() => null)) as { auctionId?: string; code?: string; created?: boolean; message?: string } | null;
    if (!res.ok || !created?.auctionId) { setBusy(false); setMsg({ ok: false, text: created?.message ?? 'Not created.' }); return; }
    let attached = 0;
    if (picked.length) {
      const a = await fetch(`/api/staff/auctions/${created.auctionId}/lots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lotIds: picked }) });
      const results = ((await a.json().catch(() => [])) as Attach[]) ?? [];
      attached = results.filter((r) => r.attached).length;
      setBlockers(Object.fromEntries(results.filter((r) => !r.attached).map((r) => [r.lotId, r.blockers.map((b) => b.message).join(' ')])));
    }
    setBusy(false);
    setMsg({ ok: true, text: `${created.created ? 'Scheduled' : 'Already scheduled'} ${created.code}${picked.length ? `: ${attached} of ${picked.length} lots attached` : ''}. Open it from the list when you are ready.` });
    router.refresh();
  }

  return (
    <div className="stack">
      <div className="cgrid" style={{ gap: 12 }}>
        <div className="field c-6"><label htmlFor="s-title">Title</label><input id="s-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field c-6"><label htmlFor="s-branch">Branch</label>
          <select id="s-branch" className="input" value={branch} onChange={(e) => { setBranch(e.target.value); setPicked([]); setTitle(`Vehicles: ${branches.find((b) => b.code === e.target.value)?.name.replace('ABC Auctions ', '') ?? ''}`); }}>
            {branches.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
        </div>
        <div className="field c-6"><label htmlFor="s-open">Opens</label><input id="s-open" type="datetime-local" className="input mono" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} /></div>
        <div className="field c-6"><label htmlFor="s-close">First lot closes</label><input id="s-close" type="datetime-local" className="input mono" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} /></div>
        <div className="field c-6"><label htmlFor="s-stagger">Stagger between lots</label>
          <select id="s-stagger" className="input" value={stagger} onChange={(e) => setStagger(Number(e.target.value))}>
            {[0, 60, 120, 180, 300].map((s) => <option key={s} value={s}>{s === 0 ? 'All close together' : `${s / 60} minute${s === 60 ? '' : 's'}`}</option>)}
          </select>
        </div>
        <label className="c-6 row" style={{ gap: 10, alignSelf: 'end', height: 40 }}>
          <input type="checkbox" checked={deposit} onChange={(e) => setDeposit(e.target.checked)} /> <span>Deposit required to bid</span>
        </label>
      </div>
      <div className="row between"><span className="micro">Code</span><span className="mono small">{code}</span></div>
      <div>
        <div className="row between" style={{ marginBottom: 8 }}><span className="micro">Lots ready at {branch}</span><span className="small muted">{picked.length} selected</span></div>
        {branchLots.length === 0 ? (
          <div className="notice neutral small">No lots are waiting at this branch. Sellers add lots in the seller portal; they appear here once the consignment is signed.</div>
        ) : (
          <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-ctl)', maxHeight: 260, overflowY: 'auto' }}>
            {branchLots.map((l) => (
              <label key={l.id} className="row" style={{ padding: '10px 12px', borderBottom: '1px solid var(--line-soft)', gap: 10, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))} style={{ marginTop: 3 }} />
                <span className="grow"><span className="w500">{l.title}</span><br /><span className="micro">{l.ref} · {l.seller} · from {l.startingBid.text}</span>
                  {blockers[l.id] && <><br /><span className="act-err">{blockers[l.id]}</span></>}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      {msg && <div className={`notice ${msg.ok ? 'good' : 'bad'} small`}>{msg.ok ? <CheckIcon /> : null}<span>{msg.text}</span></div>}
      <button type="button" className="btn ink" disabled={busy || title.trim().length < 3 || closesAt <= opensAt} onClick={submit}><CalendarDaysIcon /> {busy ? 'Scheduling…' : 'Schedule auction'}</button>
    </div>
  );
}
