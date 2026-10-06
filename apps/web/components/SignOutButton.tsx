'use client';

import { ArrowRightStartOnRectangleIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn sm ghost"
      style={{ marginTop: 10 }}
      onClick={async () => {
        await fetch('/api/session/sign-out', { method: 'POST' });
        router.push('/');
        router.refresh();
      }}
    >
      <ArrowRightStartOnRectangleIcon /> Sign out
    </button>
  );
}
