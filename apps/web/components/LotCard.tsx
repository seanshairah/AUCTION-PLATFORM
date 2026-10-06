import { Camera, Fuel, Gauge, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { km, titleCase } from '@/lib/format';
import type { LotCard as Lot } from '@/lib/types';
import { CarArt } from './CarArt';
import { Countdown } from './Countdown';

const RESERVE: Record<Lot['reserveStatus'], [string, string]> = {
  no_reserve: ['No reserve', 'good'],
  met: ['Reserve met', 'good'],
  not_met: ['Reserve not met', 'muted'],
};

export function LotCard({ lot }: { lot: Lot }) {
  const v = lot.vehicle;
  const [reserveText, reserveTone] = RESERVE[lot.reserveStatus];
  return (
    <Link href={`/lots/${encodeURIComponent(lot.ref)}`} className="card lot-card">
      <div className="lot-media">
        <div className="tags">
          {lot.viewer?.leading && <span className="tag lead">You lead</span>}
          {v?.zimbabweRegistered === false && <span className="tag">Import</span>}
          {lot.extended && <span className="tag">Extended</span>}
        </div>
        <CarArt body={v?.bodyStyle ?? null} colour={v?.colour ?? null} />
        <span className="photos"><Camera size={12} /> {lot.photoCount}</span>
      </div>
      <div className="lot-body">
        <div>
          <div className="lot-title">{lot.title}</div>
          <div className="lot-ref">Lot {lot.ref} · {lot.branch.name.replace('ABC Auctions ', '')}</div>
        </div>
        {v && (
          <div className="specs">
            <span><Gauge size={13} /> {km(v.odometerKm)}</span>
            <span><Settings2 size={13} /> {titleCase(v.transmission)}</span>
            <span><Fuel size={13} /> {titleCase(v.fuel)}</span>
          </div>
        )}
        <div className="price-row">
          <div>
            <div className="price-label">{lot.currentPrice ? 'Current bid' : 'Starting bid'}</div>
            <div className="price">{(lot.currentPrice ?? lot.startingBid).text}</div>
          </div>
          <span className={`pill ${reserveTone}`}>{reserveText}</span>
        </div>
        <div className="allin">
          {lot.allInAtNextMinimum
            ? <>All-in at next bid <b>{lot.allInAtNextMinimum.text}</b></>
            : <span className="muted">Full price not available: bidding paused</span>}
        </div>
        <div className="lot-foot">
          <span>{lot.bids} {lot.bids === 1 ? 'bid' : 'bids'} · {lot.bidders} {lot.bidders === 1 ? 'bidder' : 'bidders'}</span>
          <Countdown endsAt={lot.endsAt} />
        </div>
      </div>
    </Link>
  );
}
