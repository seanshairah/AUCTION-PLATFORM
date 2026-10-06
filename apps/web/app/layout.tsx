import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import type { Metadata, Viewport } from 'next';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { apiOrNull } from '@/lib/api';
import type { Me, Wallet } from '@/lib/types';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ABC Auctions: timed online auctions in Harare and Bulawayo', template: '%s · ABC Auctions' },
  description: 'Bid on inspected vehicles and equipment. The total you see before you bid is the total on your invoice.',
};

export const viewport: Viewport = { themeColor: '#0a0927' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const me = await apiOrNull<Me>('/me').catch(() => null);
  const [wallet, unread] = me
    ? await Promise.all([
        apiOrNull<Wallet>('/me/wallet').catch(() => null),
        apiOrNull<{ unread?: number }>('/me/notifications/unread-count').catch(() => null),
      ])
    : [null, null];
  return (
    <html lang="en-ZW">
      <body>
        <SiteHeader me={me} wallet={wallet} unread={unread?.unread ?? 0} />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
