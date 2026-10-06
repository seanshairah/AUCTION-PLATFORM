import Link from 'next/link';
import { NotificationList } from '@/components/account/NotificationList';
import { apiOrNull } from '@/lib/api';

export const metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
  const feed = (await apiOrNull<{ unread: number; items: Array<{ id: string; kind: string; title: string | null; text: string; at: string; read: boolean }> }>('/me/notifications?limit=50')) ?? { unread: 0, items: [] };
  return (
    <>
      <div className="acc-title">
        <div><h1>Notifications</h1><p>{feed.unread ? `${feed.unread} unread.` : 'All read.'} Choose how each kind reaches you in <Link className="link" href="/account/preferences">preferences</Link>.</p></div>
      </div>
      <NotificationList items={feed.items} />
    </>
  );
}
