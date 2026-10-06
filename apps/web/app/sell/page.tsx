import { BuildingLibraryIcon, CameraIcon, ChartBarIcon, ChevronRightIcon, ClipboardDocumentCheckIcon, DocumentArrowUpIcon, PencilSquareIcon, ReceiptPercentIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { WhatsAppMark } from '@/components/Marks';
import { HERO_PHOTO } from '@/lib/media';

export const metadata = { title: 'Sell with ABC' };

export default function SellPage() {
  return (
    <>
      <section className="hero">
        <div className="hero-photo" style={{ backgroundImage: `url(${HERO_PHOTO})`, backgroundPosition: 'center 40%' }} aria-hidden />
        <div className="wrap hero-inner" style={{ paddingTop: 96 }}>
          <div>
            <span className="chip accent">For sellers</span>
            <h1 className="display d-xl">Sell to more<br /><em>bidders</em></h1>
            <p className="lead" style={{ color: 'var(--night-muted)', maxWidth: '52ch' }}>Consign by app or WhatsApp from anywhere in Zimbabwe. Watch the bids live, and know your payout date the moment the buyer collects.</p>
            <div className="ctas">
              <Link href="/sign-in?next=/sell" className="btn lg">Start a consignment <ChevronRightIcon /></Link>
              <a href="https://wa.me/" className="btn lg outline-night"><WhatsAppMark /> Consign on WhatsApp</a>
            </div>
          </div>
        </div>
      </section>
      <section className="section">
        <div className="wrap">
          <div className="bento">
            <div className="cell c-6 r-2">
              <span className="eyebrow"><PencilSquareIcon /> E-signed consignment note</span>
              <h3>Know what you will receive before you sign</h3>
              <p>The note is written from your lots and the published rulebook: each reserve, commission in plain words, when you are paid and what happens if the reserve is not met. Your signature binds the exact text you read.</p>
            </div>
            <div className="cell c-6">
              <span className="eyebrow"><ChartBarIcon /> Live bids</span>
              <h3>Price, bidders and your reserve, as it happens</h3>
              <p>No weekly report. See each lot&apos;s current price, how many people are bidding and whether your reserve is met.</p>
            </div>
            <div className="cell c-3 stat-cell"><b>29</b><span className="micro">Point vehicle inspection</span></div>
            <div className="cell c-3 stat-cell"><b>38</b><span className="micro">Photos per vehicle</span></div>
            <div className="cell c-4">
              <span className="eyebrow"><ReceiptPercentIcon /> Valuation</span>
              <h3>A range from real past sales</h3>
              <p>The middle half of comparable hammer prices from the last 12 months, shown as a guide.</p>
            </div>
            <div className="cell c-4">
              <span className="eyebrow"><CameraIcon /> Intake</span>
              <h3>Photos and condition, done once</h3>
              <p>Staff photograph and describe each lot to one standard, so buyers bid with confidence.</p>
            </div>
            <div className="cell c-4" id="institutions">
              <span className="eyebrow"><BuildingLibraryIcon /> Institutions</span>
              <h3>Banks, insurers and customs</h3>
              <p>Upload hundreds of lots in one CSV, priced lot by lot in US$ or ZiG. All or nothing, and never duplicated.</p>
            </div>
          </div>
          <div className="row" style={{ marginTop: 24, gap: 12, flexWrap: 'wrap' }}>
            <span className="row small ink-2"><ClipboardDocumentCheckIcon width={16} /> Commission is published before anyone signs.</span>
            <span className="row small ink-2"><DocumentArrowUpIcon width={16} /> Bulk upload format: <Link className="link" href="/help#bulk">see the column list</Link></span>
          </div>
        </div>
      </section>
    </>
  );
}
