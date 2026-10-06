import { redirect } from 'next/navigation';
import { AccountNav } from '@/components/AccountNav';
import { SignOutButton } from '@/components/SignOutButton';
import { apiOrNull } from '@/lib/api';
import type { Me, MyBid } from '@/lib/types';

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const me = await apiOrNull<Me>('/me');
  if (!me) redirect('/sign-in?next=/account/bids');
  const [bidsOrNull, purchases, feed, cases] = await Promise.all([
    apiOrNull<MyBid[]>('/me/bids'),
    apiOrNull<Array<{ status: string }>>('/me/purchases'),
    apiOrNull<{ unread: number }>('/me/notifications?limit=1'),
    apiOrNull<Array<{ status: string }>>('/me/defaults'),
  ]);
  const unread = feed?.unread ?? 0;
  const defaults = (cases ?? []).filter((c) => c.status === 'open').length;
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
            { title: 'Messages', links: [
              { href: '/account/notifications', label: 'Notifications', icon: 'notifications', count: unread, urgent: unread > 0 },
              { href: '/account/preferences', label: 'Preferences', icon: 'preferences' },
            ] },
            { title: 'Help', links: [
              { href: '/account/support', label: 'Support', icon: 'support' },
              ...(defaults > 0 ? [{ href: '/account/defaults', label: 'Late payments', icon: 'purchases' as const, count: defaults, urgent: true }] : []),
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
