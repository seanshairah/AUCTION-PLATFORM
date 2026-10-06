import { MagnifyingGlassIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="section">
      <div className="wrap" style={{ maxWidth: 640 }}>
        <div className="card empty">
          <MagnifyingGlassIcon />
          <h1 className="w600" style={{ fontSize: 18 }}>We could not find that page</h1>
          <p>It may have closed or moved.</p>
          <Link className="btn sm" href="/auctions">Back to the docket</Link>
        </div>
      </div>
    </section>
  );
}
