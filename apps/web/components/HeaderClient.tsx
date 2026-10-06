'use client';

import { BookOpenIcon, MagnifyingGlassIcon, QuestionMarkCircleIcon, RectangleStackIcon, TagIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

const NAV = [
  { href: '/auctions', label: 'Auctions', icon: RectangleStackIcon, match: ['/auctions', '/lots'] },
  { href: '/sell', label: 'Sell', icon: TagIcon, match: ['/sell'] },
  { href: '/rules', label: 'Fees and rules', icon: BookOpenIcon, match: ['/rules'] },
  { href: '/help', label: 'Help', icon: QuestionMarkCircleIcon, match: ['/help'] },
];

export function HeaderNav() {
  const path = usePathname();
  return (
    <nav className="topnav" aria-label="Main">
      {NAV.map(({ href, label, icon: Icon, match }) => (
        <Link key={href} href={href} className={match.some((m) => path.startsWith(m)) ? 'active' : ''}>
          <Icon width={16} />
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Search across lots; "/" or Ctrl+K focuses it from anywhere. */
export function SearchBox() {
  const ref = useRef<HTMLInputElement>(null);
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <form
      className="searchbox"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = ref.current?.value.trim();
        router.push(q ? `/auctions?q=${encodeURIComponent(q)}` : '/auctions');
      }}
    >
      <MagnifyingGlassIcon />
      <input ref={ref} name="q" placeholder="Search make, model or lot number" aria-label="Search lots" />
      <kbd>Ctrl K</kbd>
    </form>
  );
}
