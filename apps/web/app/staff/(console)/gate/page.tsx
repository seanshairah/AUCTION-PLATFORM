import { QrCodeIcon } from '@heroicons/react/20/solid';
import { GateScanner } from '@/components/staff/GateScanner';
import { canSee, staffMe } from '@/lib/staff';

export const metadata = { title: 'Gate release' };

export default async function GatePage() {
  const me = (await staffMe())!;
  if (!canSee(me, 'gate')) return <div className="notice bad">Your role cannot release goods at the gate.</div>;
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><QrCodeIcon /> Deliverable 15 · Collection</span>
          <h1>Gate release</h1>
          <p>Scan the buyer’s QR pass. Green means hand over; red says exactly why not and what the buyer must do.</p>
        </div>
      </div>
      <GateScanner />
    </>
  );
}
