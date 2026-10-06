import { InformationCircleIcon } from '@heroicons/react/20/solid';
import { DemoSignIn } from '@/components/DemoSignIn';
import { apiOrNull } from '@/lib/api';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const accounts = await apiOrNull<Array<{ id: string; name: string; kind?: string }>>('/session/demo-accounts');
  const safeNext = next?.startsWith('/') && !next.startsWith('//') ? next : '/auctions';
  return (
    <section className="section">
      <div className="wrap" style={{ maxWidth: 760 }}>
        <div className="micro">Your account</div>
        <h1 className="display d-lg" style={{ margin: '8px 0 16px' }}>Sign in</h1>
        {accounts ? (
          <div className="stack">
            <div className="notice"><InformationCircleIcon /><span><strong className="w600">Demo environment.</strong> Choose a demo bidder or the demo seller. Bidders have a wallet, deposits held and bids placed; Tendai has an unpaid invoice from a closed auction.</span></div>
            <DemoSignIn accounts={accounts} next={safeNext} />
          </div>
        ) : (
          <div className="notice neutral"><InformationCircleIcon /><span>Sign-in with a one-time code by WhatsApp, SMS or email is not enabled in this environment.</span></div>
        )}
      </div>
    </section>
  );
}
