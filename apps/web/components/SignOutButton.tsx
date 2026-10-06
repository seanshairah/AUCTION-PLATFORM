'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="icon-btn"
      style={{ width: 34, height: 34, border: 0 }}
      title="Sign out"
      aria-label="Sign out"
      onClick={async () => {
        await fetch('/api/session/sign-out', { method: 'POST' });
        router.push('/auctions');
        router.refresh();
      }}
    >
      <LogOut size={16} />
    </button>
  );
}
