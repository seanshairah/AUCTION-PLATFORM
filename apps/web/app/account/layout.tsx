import { redirect } from 'next/navigation';
import { AccountNav } from '@/components/AccountNav';
import { SignOutButton } from '@/components/SignOutButton';
import { apiOrNull } from '@/lib/api';
import type { Me, MyBid } from '@/lib/types';

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const me = await apiOrNull<Me>('/me');
  if (!me) redirect('/sign-in?next=/account/bids');
  const [bidsOrNull, purchases] = await Promise.all([apiOrNull<MyBid[]>('/me/bids'), apiOrNull<Array<{ status: string }>>('/me/purchases')]);
  const bids = bidsOrNull ?? [];
  const unpaid = (purchases ?? []).filter((p) => p.status === 'issued' || p.status === 'overdue').length;
  const outbid = bids.filter((b) => b.status === 'outbid').length;
  const open = bids.filter((b) => b.status === 'leading' || b.status === 'outbid').length;
  return (
    <div className="account">
      <aside className="acc-side" aria-label="Account">
        <AccountNav
          sections={[
            { title: 'Buying', links: [
              { href: '/account/bids', label: 'My bids', icon: 'bids', count: outbid || open, urgent: outbid > 0 },
              { href: '/account/purchases', label: 'Purchases', icon: 'purchases', count: unpaid, urgent: unpaid > 0 },
              { href: '/account/wallet', label: 'Wallet', icon: 'wallet' },
            ] },
            { title: 'Help', links: [
              { href: '/account/support', label: 'Support', icon: 'support' },
            ] },
            { title: 'Selling', links: [
              { href: '/account/selling', label: 'Seller portal', icon: 'selling' },
            ] },
          ]}
        />
        <div className="foot">
          <div className="w500" style={{ color: 'var(--ink)' }}>{me.name}</div>
          <div>{me.verification === 'full' ? 'Fully verified' : 'Email and phone verified'}</div>
          <SignOutButton />
        </div>
      </aside>
      <div className="acc-main">{children}</div>
    </div>
  );
}
