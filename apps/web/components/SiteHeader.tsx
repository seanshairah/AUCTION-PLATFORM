import { BellIcon, ChevronDownIcon, PlusIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import type { Me, Wallet } from '@/lib/types';
import { HeaderNav, SearchBox } from './HeaderClient';

export function Wordmark() {
  return (
    <Link href="/" className="wordmark" aria-label="ABC Auctions home">
      <b>ABC Auctions</b>
      <i>Harare · Bulawayo</i>
    </Link>
  );
}

export function SiteHeader({ me, wallet, unread = 0 }: { me: Me | null; wallet: Wallet | null; unread?: number }) {
  const usd = wallet?.balances.find((b) => b.currency === 'USD');
  return (
    <header className="site-header on-night">
      <div className="wrap bar">
        <Wordmark />
        <HeaderNav />
        <SearchBox />
        <div className="header-actions">
          {me ? (
            <>
              <Link href="/account/wallet" className="balance-pill" title="Wallet: available to spend">
                <span className="micro">Wallet</span>
                <span className="mono">{usd ? usd.available.text : 'US$0.00'}</span>
                <span className="btn sm" style={{ height: 28 }}><PlusIcon /> Top up</span>
              </Link>
              <Link href="/account/notifications" className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
                <BellIcon />
                {unread > 0 && <span className={`badge${unread > 0 ? ' urgent' : ''}`}>{unread}</span>}
              </Link>
              <Link href="/account/bids" className="row" style={{ gap: 6 }} aria-label="Your account">
                <span className="avatar">{me.name.slice(0, 1)}</span>
                <ChevronDownIcon width={16} style={{ color: 'var(--muted)' }} />
              </Link>
            </>
          ) : (
            <>
              <Link href="/sign-in" className="btn outline-night">Sign in</Link>
              <Link href="/sign-in?next=/auctions" className="btn hide-sm">Register to bid</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
