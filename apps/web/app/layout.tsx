import type { Metadata } from 'next';
import { Sidebar } from '@/components/Sidebar';
import { apiOrNull } from '@/lib/api';
import type { Me, MyBid } from '@/lib/types';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ABC Auctions', template: '%s · ABC Auctions' },
  description: 'Timed online auctions in Harare and Bulawayo. The price you see is the price you pay.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const me = await apiOrNull<Me>('/me').catch(() => null);
  const bids = me ? await apiOrNull<MyBid[]>('/me/bids').catch(() => null) : null;
  const active = bids?.filter((b) => b.status === 'leading' || b.status === 'outbid').length ?? 0;
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar signedIn={Boolean(me)} activeBids={active} />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
