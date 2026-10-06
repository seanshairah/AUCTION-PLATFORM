import { SignalSlashIcon } from '@heroicons/react/20/solid';

export const metadata = { title: 'Offline' };
export const dynamic = 'force-static';

export default function Offline() {
  return (
    <section className="section">
      <div className="wrap" style={{ maxWidth: 640 }}>
        <div className="card empty">
          <SignalSlashIcon />
          <h1 className="w600" style={{ fontSize: 18 }}>You are offline</h1>
          <p>Pages you opened recently still work. Bids, payments and your account need a connection; nothing is sent until you are back online.</p>
        </div>
      </div>
    </section>
  );
}
