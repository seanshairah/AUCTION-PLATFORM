import { InformationCircleIcon } from '@heroicons/react/20/solid';
import { OtpSignIn } from '@/components/account/OtpSignIn';
import { DemoSignIn } from '@/components/DemoSignIn';
import { apiOrNull } from '@/lib/api';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const accounts = await apiOrNull<Array<{ id: string; name: string; kind?: string }>>('/session/demo-accounts');
  const safeNext = next?.startsWith('/') && !next.startsWith('//') ? next : '/auctions';
  return (
    <section className="section">
      <div className="wrap split" style={{ maxWidth: 1080, alignItems: 'start' }}>
        <div className="stack">
          <div>
            <div className="micro">Your account</div>
            <h1 className="display d-lg" style={{ margin: '8px 0 8px' }}>Sign in or register</h1>
            <p className="lead">One code to your phone or email. New here? The same code creates your account.</p>
          </div>
          <OtpSignIn next={safeNext} demo={Boolean(accounts)} />
        </div>
        {accounts && (
          <div className="stack">
            <div className="notice"><InformationCircleIcon /><span><strong className="w600">Demo environment.</strong> Or act as a demo person: bidders have wallets, deposits and bids; Tendai has a paid invoice; Borrowdale Motors sells.</span></div>
            <DemoSignIn accounts={accounts} next={safeNext} />
          </div>
        )}
      </div>
    </section>
  );
}
