'use client';

import { AdjustmentsHorizontalIcon, BellIcon, BuildingStorefrontIcon, ChatBubbleLeftRightIcon, HandRaisedIcon, ShoppingBagIcon, WalletIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface AccountLink {
  href: string;
  label: string;
  icon: 'bids' | 'purchases' | 'wallet' | 'notifications' | 'preferences' | 'support' | 'selling';
  count?: number;
  urgent?: boolean;
}

const ICONS = { bids: HandRaisedIcon, purchases: ShoppingBagIcon, wallet: WalletIcon, notifications: BellIcon, preferences: AdjustmentsHorizontalIcon, support: ChatBubbleLeftRightIcon, selling: BuildingStorefrontIcon };

export function AccountNav({ sections }: { sections: Array<{ title: string; links: AccountLink[] }> }) {
  const path = usePathname();
  return (
    <>
      {sections.map((s) => (
        <div key={s.title} style={{ display: 'contents' }}>
          <div className="sect">{s.title}</div>
          {s.links.map((l) => {
            const Icon = ICONS[l.icon];
            return (
              <Link key={l.href} href={l.href} className={path.startsWith(l.href) ? 'on' : ''}>
                <Icon />
                {l.label}
                {l.count ? <span className={`badge${l.urgent ? ' urgent' : ''}`}>{l.count}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}
