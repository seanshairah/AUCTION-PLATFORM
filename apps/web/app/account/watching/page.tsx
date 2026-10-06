import { BellAlertIcon, BookmarkIcon, ChevronRightIcon, HeartIcon, MagnifyingGlassIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { SavedSearchActions } from '@/components/account/SavedSearchActions';
import { LotCard } from '@/components/LotCards';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { sized } from '@/lib/media';
import type { LotCard as Lot, Money } from '@/lib/types';

export const metadata = { title: 'Watching' };

interface Watched extends Lot { result: string; currentPrice: Money | null }
interface Saved { id: string; name: string; query: Record<string, string>; alerts: boolean; createdAt: string; matches: number; preview: Array<{ ref: string; title: string; cover: string | null }> }

const RESULT: Record<string, string> = { sold: 'Sold', unsold: 'Unsold', reserve_not_met: 'Reserve not met', withdrawn: 'Withdrawn' };

export default async function WatchingPage() {
  const [watched, searches] = await Promise.all([apiOrNull<Watched[]>('/me/watch'), apiOrNull<Saved[]>('/me/saved-searches')]);
  const live = (watched ?? []).filter((w) => w.result === 'pending');
  const closed = (watched ?? []).filter((w) => w.result !== 'pending');
  return (
    <>
      <div className="acc-title">
        <div><h1>Watching</h1><p>Lots you saved for later and searches that tell you when something new matches. We remind you before a watched lot closes.</p></div>
        <Link href="/auctions" className="btn ghost"><MagnifyingGlassIcon /> Browse the docket</Link>
      </div>

      <div className="kpis" style={{ ['--n' as string]: 3, marginBottom: 24 }}>
        <div className="kpi"><span className="micro">Watching live</span><span className="v">{live.length}</span></div>
        <div className="kpi"><span className="micro">Saved searches</span><span className="v">{searches?.length ?? 0}</span></div>
        <div className="kpi"><span className="micro">With alerts</span><span className="v">{(searches ?? []).filter((s) => s.alerts).length}</span></div>
      </div>

      <div className="stack" style={{ gap: 24 }}>
        <div className="nest">
          <div className="nest-head"><HeartIcon /><h3>Watch list</h3><span className="badge">{live.length}</span></div>
          <div className="nest-body">
            {live.length === 0 ? (
              <div className="row" style={{ gap: 12 }}><HeartIcon width={20} className="muted" /><span className="ink-2">Tap the heart on any lot to keep it here. We send an ending-soon alert before it closes.</span></div>
            ) : <div className="lot-grid">{live.map((l) => <LotCard key={l.id} lot={l} />)}</div>}
          </div>
        </div>

        <div className="nest">
          <div className="nest-head"><BookmarkIcon /><h3>Saved searches</h3><span className="badge">{searches?.length ?? 0}</span></div>
          <div className="nest-body" style={{ padding: 0 }}>
            {(searches ?? []).length === 0 ? (
              <div className="row" style={{ gap: 12, padding: 16 }}><BellAlertIcon width={20} className="muted" /><span className="ink-2">Filter the docket, then choose “Save this search”. We tell you when new lots match, on the channels you pick under <Link href="/account/preferences" className="link">Preferences</Link>.</span></div>
            ) : searches!.map((s) => {
              const qs = new URLSearchParams(s.query).toString();
              return (
                <div key={s.id} className="saved-card">
                  <Link href={`/auctions?${qs}`} className="thumbs" aria-label={`Open ${s.name}`}>
                    {[0, 1, 2].map((i) => s.preview[i]?.cover ? <img key={i} src={sized(s.preview[i]!.cover!, 800)} alt="" /> : <span key={i} />)}
                  </Link>
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/auctions?${qs}`} className="w600 row" style={{ gap: 4 }}>{s.name} <ChevronRightIcon width={16} className="muted" /></Link>
                    <div className="small muted">{s.matches} live {s.matches === 1 ? 'lot matches' : 'lots match'} now · saved {shortDateTime(s.createdAt)}</div>
                  </div>
                  <SavedSearchActions id={s.id} alerts={s.alerts} />
                </div>
              );
            })}
          </div>
        </div>

        {closed.length > 0 && (
          <div className="nest">
            <div className="nest-head"><h3>Closed since you watched</h3><span className="badge">{closed.length}</span></div>
            <div className="nest-body" style={{ padding: 0 }}>
              <table className="table">
                <thead><tr><th>Lot</th><th>Result</th><th className="r">Final price</th><th>Closed</th></tr></thead>
                <tbody>{closed.map((l) => (
                  <tr key={l.id}>
                    <td><Link href={`/lots/${l.ref}`} className="thumbcell"><img src={l.cover ? sized(l.cover, 800) : ''} alt="" /><span className="w500">{l.title}</span></Link></td>
                    <td>{RESULT[l.result] ?? l.result}</td>
                    <td className="r mono">{l.currentPrice?.text ?? '—'}</td>
                    <td className="small">{shortDateTime(l.endsAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
