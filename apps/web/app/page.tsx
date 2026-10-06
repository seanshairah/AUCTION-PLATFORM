import { BanknotesIcon, CalendarDaysIcon, ChevronRightIcon, ClipboardDocumentCheckIcon, CameraIcon, EyeIcon, HandRaisedIcon, MapPinIcon, ReceiptPercentIcon, RectangleStackIcon, ShieldCheckIcon, TruckIcon, WalletIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { SegmentClock } from '@/components/Countdown';
import { LotCard } from '@/components/LotCards';
import { PayMarks, WhatsAppMark } from '@/components/Marks';
import { api } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { HERO_PHOTO } from '@/lib/media';
import type { AuctionSummary, LotCard as Lot, Money } from '@/lib/types';

function minus(a: Money, b: Money): string {
  const d = BigInt(a.minor) - BigInt(b.minor);
  const whole = d / 100n;
  const cents = (d % 100n).toString().padStart(2, '0');
  return `US$${whole.toLocaleString('en-US')}.${cents}`;
}

export default async function Home() {
  const [auctions, closing] = await Promise.all([
    api<AuctionSummary[]>('/auctions'),
    api<{ lots: Lot[]; total: number }>('/lots?sort=ending_soon'),
  ]);
  const a = auctions[0] ?? null;
  const demo = a ? /\(demo\)\s*$/i.test(a.title) : false;
  const title = a ? a.title.replace(/\s*\(demo\)\s*$/i, '') : 'Timed online auctions';
  const [headline, place] = title.includes(':') ? title.split(/:\s*/, 2) : [title, ''];
  const sample = closing.lots.find((l) => l.allInAtNextMinimum && l.vehicle) ?? closing.lots[0];
  const photos = closing.lots.find((l) => l.isVehicle)?.photoCount ?? 38;

  return (
    <>
      <section className="hero">
        <div className="hero-photo" style={{ backgroundImage: `url(${HERO_PHOTO})` }} aria-hidden />
        <div className="wrap hero-inner">
          <div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className="chip accent">Now taking registrations</span>
              {a?.depositRequired && <span className="chip night"><WalletIcon /> Refundable deposit</span>}
              {demo && <span className="chip night">Demo auction</span>}
            </div>
            <h1 className="display d-xl">{headline}{place && <><br /><em>{place}</em></>}</h1>
            {a && (
              <div className="meta">
                <span><CalendarDaysIcon /> Closing from {shortDate(a.firstCloseAt)}</span>
                <span><MapPinIcon /> {a.branch.name}</span>
                <span><RectangleStackIcon /> {a.liveLots} lots · {a.bids} bids</span>
              </div>
            )}
            <div className="ctas">
              <Link href="/auctions" className="btn lg">Browse the docket <ChevronRightIcon /></Link>
              <div className="btn-group">
                <Link href="/sign-in?next=/auctions" className="btn lg outline-night">Register to bid</Link>
                <Link href="/sell" className="btn lg outline-night">Consign a vehicle</Link>
              </div>
            </div>
          </div>
          {a && <SegmentClock to={a.firstCloseAt} label="First lot closes in" />}
        </div>
        <nav className="eventnav" aria-label="This auction">
          <div className="wrap">
            <Link href="/auctions" className="active"><RectangleStackIcon /> Docket <span className="badge" style={{ background: 'rgba(255,255,255,.1)', color: 'inherit' }}>{a?.liveLots ?? closing.total}</span></Link>
            <Link href="#how"><ClipboardDocumentCheckIcon /> How it works</Link>
            <Link href="/rules"><ReceiptPercentIcon /> Fees</Link>
            <Link href="/help#viewing"><EyeIcon /> Viewing</Link>
            <Link href="/help#collection"><TruckIcon /> Collection</Link>
          </div>
        </nav>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="section-head">
            <div>
              <div className="micro"><HandRaisedIcon /> Closing next</div>
              <h2 className="display d-lg">Ending soonest</h2>
            </div>
            <Link href="/auctions" className="btn ghost">See all {closing.total} lots <ChevronRightIcon /></Link>
          </div>
          <div className="rail">
            {closing.lots.slice(0, 8).map((l) => <LotCard key={l.id} lot={l} />)}
          </div>
        </div>
      </section>

      <section className="section" id="how" style={{ paddingTop: 16 }}>
        <div className="wrap">
          <div className="section-head">
            <div>
              <div className="micro"><ShieldCheckIcon /> Why bid here</div>
              <h2 className="display d-lg">Bid on evidence.<br />Pay what you saw.</h2>
            </div>
            <p className="lead" style={{ maxWidth: '44ch' }}>Levy, VAT and fees are worked out before you bid, from the same rules that write your invoice. Nothing is added afterwards.</p>
          </div>
          <div className="bento">
            <div className="cell flood c-8 r-2" style={{ minHeight: 340 }}>
              <span className="eyebrow"><ReceiptPercentIcon /> All-in price</span>
              <h3 className="display d-md" style={{ maxWidth: '14ch', marginTop: 12 }}>The total you see is the total you pay</h3>
              <p style={{ maxWidth: '40ch' }}>Type your maximum and the full amount appears as you type. Confirm it, and the server checks it again before your bid counts.</p>
              {sample?.allInAtNextMinimum && (
                <div className="frag frag-commit" aria-hidden>
                  <div className="micro" style={{ marginBottom: 6 }}>{sample.title}</div>
                  <div className="lines">
                    <div className="l"><span>Hammer price</span><span>{sample.nextMinimum.text}</span></div>
                    <div className="l"><span>{sample.vehicle?.zimbabweRegistered ? "Purchaser's levy 15%" : 'Levy and VAT'}</span><span>{minus(sample.allInAtNextMinimum, sample.nextMinimum)}</span></div>
                    <div className="l total"><span>You pay if you win</span><span>{sample.allInAtNextMinimum.text}</span></div>
                  </div>
                </div>
              )}
            </div>
            <div className="cell stat-cell c-4"><b>{photos}</b><span className="micro">Photos per vehicle</span></div>
            <div className="cell stat-cell c-4"><b>29</b><span className="micro">Point inspection, published</span></div>
            <div className="cell c-6" style={{ minHeight: 260 }}>
              <span className="eyebrow"><HandRaisedIcon /> Automatic bidding</span>
              <h3>Set a maximum. We bid only what is needed.</h3>
              <p style={{ maxWidth: '40ch' }}>Nobody sees your maximum. A late bid extends the lot by ten minutes, so nobody is sniped.</p>
              <div className="frag frag-history" aria-hidden>
                <div className="timeline">
                  <div className="tl-item top"><span className="who">You</span><span className="amt">US$19,200.00</span><span className="when">Leading · just now</span></div>
                  <div className="tl-item"><span className="who">Bidder 2 · automatic</span><span className="amt">US$19,100.00</span><span className="when">2 min ago</span></div>
                  <div className="tl-item"><span className="who">Bidder 1</span><span className="amt">US$19,000.00</span><span className="when">6 min ago</span></div>
                </div>
              </div>
            </div>
            <div className="cell c-6" style={{ minHeight: 260 }}>
              <span className="eyebrow"><BanknotesIcon /> One wallet</span>
              <h3>Top up once. Deposits are held, never spent.</h3>
              <p style={{ maxWidth: '44ch' }}>Pay by mobile money, card or cash at a branch. A deposit you don&apos;t use comes back when the auction settles; your winnings are paid in one tap.</p>
              <div style={{ marginTop: 'auto', paddingTop: 20 }}><PayMarks /></div>
            </div>
          </div>
        </div>
      </section>

      <section className="night-section section">
        <div className="wrap">
          <div className="section-head">
            <div>
              <div className="micro"><CameraIcon /> For sellers</div>
              <h2 className="display d-lg">Sell to more bidders,<br />get paid sooner</h2>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Link href="/sell" className="btn lg">Start a consignment <ChevronRightIcon /></Link>
              <a href="https://wa.me/" className="btn lg outline-night"><WhatsAppMark /> Consign on WhatsApp</a>
            </div>
          </div>
          <div className="steps">
            <div className="step"><b>01</b><h4>Consign by app or WhatsApp</h4><p>Send photos and your reserve. Staff value it from comparable past sales.</p></div>
            <div className="step"><b>02</b><h4>Inspected and photographed</h4><p>Vehicles get a 29-point report and the standard photo set before they list.</p></div>
            <div className="step"><b>03</b><h4>Watch the bids live</h4><p>See price, bidders and whether your reserve is met, as it happens.</p></div>
            <div className="step"><b>04</b><h4>Paid on a known date</h4><p>Your payout date is set the moment the buyer collects and the claim window ends.</p></div>
          </div>
        </div>
      </section>
    </>
  );
}
