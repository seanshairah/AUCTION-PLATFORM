import { Search } from 'lucide-react';
import Link from 'next/link';
import type { Me } from '@/lib/types';
import { SignOutButton } from './SignOutButton';

export function Topbar({ title, sub, me, q }: { title: string; sub?: string; me: Me | null; q?: string }) {
  return (
    <header className="topbar">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <form className="search" action="/auctions" role="search">
        <Search size={16} />
        <input name="q" defaultValue={q} placeholder="Search make, model or lot number" aria-label="Search lots" />
      </form>
      {me ? (
        <div className="user">
          <span className="avatar">{me.name.slice(0, 1)}</span>
          <div>
            <div className="name">{me.name}</div>
            <div className="meta">{me.verification === 'full' ? 'Fully verified' : 'Email and phone verified'}{me.tier === 'trusted' ? ' · trusted' : ''}</div>
          </div>
          <SignOutButton />
        </div>
      ) : (
        <Link href="/sign-in" className="btn">Sign in</Link>
      )}
    </header>
  );
}
