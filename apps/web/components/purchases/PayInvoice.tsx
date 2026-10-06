'use client';

import { CheckBadgeIcon, ExclamationTriangleIcon, QrCodeIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useRef, useState } from 'react';

/**
 * One-tap payment from the wallet (the auction deposit counts towards it). The QR gate
 * pass is shown once, straight after payment: only its hash is stored.
 */
export function PayInvoice({ invoiceId, total }: { invoiceId: string; total: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; qr?: string; shortfall?: string } | null>(null);
  const key = useRef<string | null>(null);
  async function pay() {
    setBusy(true);
    key.current ??= crypto.randomUUID();
    const r = await fetch(`/api/me/invoices/${invoiceId}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: key.current }) });
    const j = (await r.json()) as { paid?: boolean; message: string; gatePassToken?: string | null; shortfall?: { text: string } };
    let qr: string | undefined;
    if (j.gatePassToken) qr = await QRCode.toString(j.gatePassToken, { type: 'svg', margin: 1, color: { dark: '#0e0d2b', light: '#ffffff' } });
    setResult({ ok: Boolean(j.paid), message: j.message, ...(qr ? { qr } : {}), ...(j.shortfall ? { shortfall: j.shortfall.text } : {}) });
    setBusy(false);
  }
  if (result?.ok) {
    return (
      <div className="stack">
        <div className="notice good"><CheckBadgeIcon /><span>{result.message}</span></div>
        {result.qr && (
          <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
            <div style={{ width: 168, height: 168, border: '1px solid var(--line)', borderRadius: 8, padding: 8, background: '#fff' }} dangerouslySetInnerHTML={{ __html: result.qr }} aria-label="QR gate pass" />
            <div className="small ink-2" style={{ maxWidth: '40ch' }}>
              <div className="w600" style={{ color: 'var(--ink)', marginBottom: 4 }}><QrCodeIcon width={16} style={{ verticalAlign: '-3px' }} /> Your gate pass</div>
              Show this at the branch gate. Save a screenshot now: for your security we keep only a fingerprint of it. If you lose it, the branch can verify you with your ID.
            </div>
          </div>
        )}
        <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => router.refresh()}>Done</button>
      </div>
    );
  }
  return (
    <div className="stack-8">
      {result && !result.ok && (
        <div className="notice bad"><ExclamationTriangleIcon /><span>{result.message} {result.shortfall && <Link className="link" href="/account/wallet">Top up</Link>}</span></div>
      )}
      <button className="btn lg" onClick={pay} disabled={busy}>{busy ? 'Paying…' : `Pay ${total} from wallet`}</button>
      <span className="small muted">Your deposit for this auction counts towards it.</span>
    </div>
  );
}
