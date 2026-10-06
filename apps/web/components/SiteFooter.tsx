import Link from 'next/link';
import { PayMarks, WhatsAppMark } from './Marks';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="cols">
          <div className="stack" style={{ gap: 12 }}>
            <span className="wordmark"><b>ABC Auctions</b><i>Harare · Bulawayo</i></span>
            <p style={{ maxWidth: '36ch' }}>Timed online auctions of vehicles, equipment and goods. Every price shown is the price you pay.</p>
            <PayMarks night />
          </div>
          <div>
            <h5>Buy</h5>
            <Link href="/auctions">Live auctions</Link>
            <Link href="/auctions?category=vehicles">Vehicles</Link>
            <Link href="/rules">Fees and rules</Link>
            <Link href="/account/bids">My bids</Link>
          </div>
          <div>
            <h5>Sell</h5>
            <Link href="/sell">Consign with ABC</Link>
            <Link href="/sell#institutions">Banks, insurers and customs</Link>
            <Link href="/rules">Commission and payouts</Link>
          </div>
          <div>
            <h5>Branches</h5>
            <p style={{ margin: '0 0 8px' }}>Harare and Bulawayo<br />Mon–Fri 9:00–15:00 · Sat 9:00–12:00</p>
            <a href="https://wa.me/" className="row" style={{ gap: 8 }}><WhatsAppMark size={14} /> WhatsApp us</a>
            <Link href="/help">Help centre</Link>
          </div>
        </div>
        <div className="legal">
          <span>© {new Date().getFullYear()} ABC Auctions</span>
          <span><Link href="/credits" style={{ display: 'inline' }}>Photo credits</Link> · Demo environment: listings and bidders are illustrative.</span>
        </div>
      </div>
    </footer>
  );
}
