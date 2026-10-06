'use client';

import { ArrowRightStartOnRectangleIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';

export function StaffSignOut() {
  const router = useRouter();
  return (
    <button type="button" className="btn sm outline-night" onClick={async () => {
      await fetch('/api/session/sign-out', { method: 'POST' });
      router.push('/staff/sign-in');
      router.refresh();
    }}>
      <ArrowRightStartOnRectangleIcon /> Sign out
    </button>
  );
}
