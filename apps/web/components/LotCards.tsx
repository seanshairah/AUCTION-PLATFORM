import { CameraIcon, CheckBadgeIcon, HandRaisedIcon, TruckIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { km, titleCase } from '@/lib/format';
import { sized } from '@/lib/media';
import type { LotCard as Lot } from '@/lib/types';
import { Countdown } from './Countdown';
import { MakeMark } from './Marks';

const RESERVE: Record<Lot['reserveStatus'], [string, string]> = {
  no_reserve: ['No reserve', 'good'],
  met: ['Reserve met', 'good'],
  not_met: ['Reserve not met', 'neutral'],
};

function lotNumber(ref: string): string {
  const n = ref.split('-').pop();
  return n && /^\d+$/.test(n) ? `Lot ${n.padStart(3, '0')}` : ref;
}

export function ReserveStatus({ status }: { status: Lot['reserveStatus'] }) {
  const [text, tone] = RESERVE[status];
  return (
    <span className={`status ${tone}`}>
      {tone === 'neutral' ? <span className="ring" /> : <CheckBadgeIcon />}
      {text}
    </span>
  );
}

function Photo({ lot }: { lot: Lot }) {
  return (
    <div className="lot-photo">
      {lot.cover ? <img src={sized(lot.cover, 800)} alt={lot.title} loading="lazy" /> : null}
      <div className="tl">
        {lot.viewer?.leading && <span className="tag lead"><CheckBadgeIcon /> You lead</span>}
        {lot.vehicle && !lot.vehicle.zimbabweRegistered && <span className="tag">Import</span>}
        {lot.extended && <span className="tag">Extended</span>}
      </div>
      <div className="br"><span className="tag dark"><CameraIcon /> {lot.photoCount}</span></div>
    </div>
  );
}

function Specs({ lot }: { lot: Lot }) {
  const v = lot.vehicle;
  if (!v) return <div className="spec-line"><span>{lot.category.name}</span></div>;
  return (
    <div className="spec-line">
      <span>{km(v.odometerKm)}</span>
      <span>{titleCase(v.transmission)}</span>
      <span>{titleCase(v.fuel)}</span>
      {v.drive && <span>{v.drive.toUpperCase()}</span>}
    </div>
  );
}

export function LotCard({ lot }: { lot: Lot }) {
  return (
    <Link href={`/lots/${encodeURIComponent(lot.ref)}`} className="lot">
      <Photo lot={lot} />
      <div className="lot-rule">
        <span className="mono">{lotNumber(lot.ref)} · {lot.branch.code}</span>
        <ReserveStatus status={lot.reserveStatus} />
      </div>
      <div className="lot-body">
        <div className="lot-title">
          {lot.title}
          {lot.vehicle && <small className="row" style={{ gap: 6 }}><MakeMark make={lot.vehicle.make} size={13} /> {lot.vehicle.colour} · {lot.vehicle.bodyStyle ? titleCase(lot.vehicle.bodyStyle) : lot.category.name}</small>}
        </div>
        <Specs lot={lot} />
        <div className="price-block">
          <span className="micro">{lot.currentPrice ? 'Current bid' : 'Starting bid'}</span>
          <span />
          <span className="p">{(lot.currentPrice ?? lot.startingBid).text}</span>
          <span />
          <span className="allin">{lot.allInAtNextMinimum ? <>All-in at next bid <b>{lot.allInAtNextMinimum.text}</b></> : 'Full price unavailable: bidding paused'}</span>
        </div>
      </div>
      <div className="lot-foot">
        <span className="row"><HandRaisedIcon /> {lot.bids} {lot.bids === 1 ? 'bid' : 'bids'} · {lot.bidders} {lot.bidders === 1 ? 'bidder' : 'bidders'}</span>
        <Countdown endsAt={lot.endsAt} />
      </div>
    </Link>
  );
}

export function LotRow({ lot }: { lot: Lot }) {
  return (
    <Link href={`/lots/${encodeURIComponent(lot.ref)}`} className="lot-row">
      <Photo lot={lot} />
      <div className="mid">
        <div className="row between"><span className="micro">{lotNumber(lot.ref)} · {lot.branch.name.replace('ABC Auctions ', '')}</span><ReserveStatus status={lot.reserveStatus} /></div>
        <div className="lot-title">{lot.title}</div>
        <Specs lot={lot} />
        {lot.inspectionSummary && <p className="small ink-2" style={{ maxWidth: '70ch' }}>{lot.inspectionSummary.split('\n')[0]}</p>}
        {lot.vehicle && <span className="row small muted" style={{ gap: 6 }}><TruckIcon width={14} /> Collect from {lot.branch.name.replace('ABC Auctions ', '')}; towing partners listed</span>}
      </div>
      <div className="side">
        <div>
          <div className="micro">{lot.currentPrice ? 'Current bid' : 'Starting bid'}</div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 500 }}>{(lot.currentPrice ?? lot.startingBid).text}</div>
          {lot.allInAtNextMinimum && <div className="small ink-2">All-in at next bid <b className="mono w500">{lot.allInAtNextMinimum.text}</b></div>}
        </div>
        <div className="row between small ink-2"><span>{lot.bids} bids</span><Countdown endsAt={lot.endsAt} /></div>
      </div>
    </Link>
  );
}
