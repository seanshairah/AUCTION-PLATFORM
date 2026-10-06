'use client';

import { usePathname } from 'next/navigation';

/** The public header and footer, left out of the staff console (which has its own chrome). */
export function PublicChrome({ children }: { children: React.ReactNode }) {
  return usePathname().startsWith('/staff') ? null : <>{children}</>;
}
