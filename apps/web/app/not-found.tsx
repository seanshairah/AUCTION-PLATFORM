import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="content" style={{ paddingTop: 40 }}>
      <div className="card empty">
        <h2>We could not find that page</h2>
        <p><Link href="/auctions" style={{ color: 'var(--accent)' }}>Back to live auctions</Link></p>
      </div>
    </div>
  );
}
