import { Topbar } from '@/components/Topbar';
import { DemoSignIn } from '@/components/DemoSignIn';
import { apiOrNull } from '@/lib/api';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const accounts = await apiOrNull<Array<{ id: string; name: string }>>('/session/demo-accounts');
  return (
    <>
      <Topbar title="Sign in" me={null} />
      <div className="content stack" style={{ maxWidth: 760 }}>
        {accounts ? (
          <>
            <div className="notice">
              <strong>Demo environment.</strong> Sign-in by phone and email one-time code comes with the identity module. Here you can act as one of the demo bidders.
            </div>
            <DemoSignIn accounts={accounts} next={next?.startsWith('/') ? next : '/auctions'} />
          </>
        ) : (
          <div className="card section">
            <h2>Sign-in is not available yet</h2>
            <p className="muted" style={{ margin: 0 }}>Signing in with a one-time code by SMS, WhatsApp or email arrives with the identity module.</p>
          </div>
        )}
      </div>
    </>
  );
}
