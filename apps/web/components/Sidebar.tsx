'use client';

import { BookOpen, Gavel, LayoutGrid, LogIn, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Only screens that exist are listed. The current app's "Soon" screens are a
 * finding in the blueprint (gap 5); nothing here is a placeholder.
 */
const NAV = [
  { href: '/auctions', label: 'Auctions', icon: LayoutGrid, match: ['/auctions', '/lots'] },
  { href: '/bids', label: 'My bids', icon: Gavel, match: ['/bids'] },
  { href: '/wallet', label: 'Wallet', icon: Wallet, match: ['/wallet'] },
  { href: '/rules', label: 'Fees and rules', icon: BookOpen, match: ['/rules'] },
];

export function Sidebar({ signedIn, activeBids }: { signedIn: boolean; activeBids: number }) {
  const path = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/auctions" className="brand">
        <span className="brand-mark">ABC</span>
        <span>
          ABC Auctions
          <small>Harare · Bulawayo</small>
        </span>
      </Link>
      <nav className="nav" aria-label="Main">
        <div className="nav-label">Buy</div>
        {NAV.map(({ href, label, icon: Icon, match }) => (
          <Link key={href} href={href} className={match.some((m) => path.startsWith(m)) ? 'active' : ''}>
            <Icon size={18} />
            {label}
            {href === '/bids' && activeBids > 0 && <span className="count">{activeBids}</span>}
          </Link>
        ))}
        {!signedIn && (
          <Link href="/sign-in" className={path.startsWith('/sign-in') ? 'active' : ''}>
            <LogIn size={18} />
            Sign in
          </Link>
        )}
      </nav>
      <div className="sidebar-card">
        <h4>Every price is all-in</h4>
        <p>The total you see before you bid is the total on your invoice: levy and VAT included.</p>
        <Link href="/rules" className="btn block">How fees work</Link>
      </div>
    </aside>
  );
}
