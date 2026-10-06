'use client';

import { CheckBadgeIcon, ExclamationTriangleIcon, InformationCircleIcon, ShieldCheckIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { LotDetail, Preview } from '@/lib/types';
import { Countdown } from './Countdown';

/**
 * The commit screen (deliverable 7): the bidder types a maximum and sees, as they
 * type, the full amount they would pay if they win at it, from the server's quote.
 * Confirming sends that exact total back; the server refuses the bid if anything
 * changed in between ("price_changed"), so the screen never disagrees with the bill.
 */
export function BidPanel({ lot, signedIn }: { lot: LotDetail; signedIn: boolean }) {
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const requestId = useRef<string | null>(null);
  const seq = useRef(0);

  const registered = lot.viewer?.registration === 'approved';
  const pending = lot.viewer?.registration === 'pending_review';

  useEffect(() => {
    if (!registered || step !== 'enter') return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/lots/${encodeURIComponent(lot.ref)}/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ typed }),
      });
      if (mine === seq.current && res.ok) setPreview((await res.json()) as Preview);
    }, typed ? 220 : 0);
    return () => clearTimeout(t);
  }, [typed, registered, step, lot.ref]);

  async function confirm() {
    if (!preview?.amount || !preview.total || !preview.ruleVersionId) return;
    setBusy(true);
    requestId.current ??= crypto.randomUUID(); // one id per confirmed bid: retries are idempotent (R4)
    try {
      const res = await fetch(`/api/lots/${encodeURIComponent(lot.ref)}/bids`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxMinor: preview.amount.minor, quotedTotalMinor: preview.total.minor, quotedRuleVersionId: preview.ruleVersionId, clientRequestId: requestId.current }),
      });
      const body = (await res.json()) as { accepted?: boolean; message?: string };
      setResult({ ok: Boolean(body.accepted), message: body.message ?? 'Something went wrong. Try again.' });
      requestId.current = null;
      setStep('enter');
      setTyped('');
      router.refresh();
    } catch {
      setResult({ ok: false, message: 'No connection. Your bid may not have reached us; check My bids before trying again.' });
    } finally {
      setBusy(false);
    }
  }

  const now = lot.currentPrice ?? lot.startingBid;
  const quick = [lot.nextMinimum];
  const reserve = lot.reserveStatus === 'no_reserve' ? 'No reserve' : lot.reserveStatus === 'met' ? 'Reserve met' : 'Reserve not met';

  return (
    <aside className="bid" aria-label="Bid on this lot">
      <div className="top">
        <div className="row between">
          <span className="micro">{lot.currentPrice ? 'Current bid' : 'Starting bid'}</span>
          <span className="micro">{reserve}</span>
        </div>
        <div className="p">{now.text}</div>
        <div className="stats">
          <div><span className="micro">Time left</span><b><Countdown endsAt={lot.endsAt} icon={false} /></b></div>
          <div><span className="micro">Bids</span><b>{lot.bids}</b></div>
          <div><span className="micro">Bidders</span><b>{lot.bidders}</b></div>
        </div>
      </div>
      <div className="body">
        {(lot.viewer?.leading || lot.viewer?.yourMax) && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {lot.viewer?.leading ? <span className="status good"><CheckBadgeIcon /> You are leading</span> : <span className="status bad"><ExclamationTriangleIcon /> You have been outbid</span>}
            {lot.viewer?.yourMax && <span className="chip">Your maximum <span className="mono">{lot.viewer.yourMax.text}</span></span>}
          </div>
        )}
        {result && <div className={`notice ${result.ok ? 'good' : 'bad'}`} role="status">{result.ok ? <CheckBadgeIcon /> : <ExclamationTriangleIcon />}<span>{result.message}</span></div>}

        {lot.closed ? (
          <div className="notice neutral"><InformationCircleIcon /><span>Bidding has closed on this lot.</span></div>
        ) : !signedIn ? (
          <>
            <AllIn lot={lot} />
            <Link href={`/sign-in?next=/lots/${encodeURIComponent(lot.ref)}`} className="btn block lg">Sign in to bid</Link>
          </>
        ) : pending ? (
          <div className="notice"><InformationCircleIcon /><span>Your registration for this auction is being reviewed. We will message you when you can bid.</span></div>
        ) : !registered ? (
          <>
            <AllIn lot={lot} />
            <JoinAuction lot={lot} />
          </>
        ) : step === 'enter' ? (
          <>
            <div className="field">
              <label htmlFor="max">Your maximum bid</label>
              <div className="amount">
                <span className="cur">US$</span>
                <input id="max" inputMode="decimal" autoComplete="off" placeholder={lot.nextMinimum.text.replace('US$', '')} value={typed} onChange={(e) => setTyped(e.target.value)} />
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {quick.map((m) => (
                  <button key={m.minor} type="button" className="btn sm ghost" onClick={() => setTyped((Number(m.minor) / 100).toString())}>Next minimum <span className="mono">{m.text}</span></button>
                ))}
              </div>
            </div>
            {preview && preview.status !== 'empty' && (
              preview.lines ? (
                <div>
                  <div className="lines">
                    {preview.lines.map((l) => <div key={l.type} className="l"><span>{l.description}</span><span>{l.amount.text}</span></div>)}
                    <div className="l total"><span>You pay if you win at this</span><span>{preview.total!.text}</span></div>
                  </div>
                  <p className={`small ${preview.status === 'ok' ? 'muted' : ''}`} style={{ marginTop: 8, color: preview.status === 'over_limit' ? 'var(--bad)' : undefined }}>{preview.message}</p>
                </div>
              ) : (
                <div className="notice bad"><ExclamationTriangleIcon /><span>{preview.message}</span></div>
              )
            )}
            {preview?.availableToBid && <p className="small muted">You can bid up to <span className="mono">{preview.availableToBid.text}</span> all-in across the lots you lead.</p>}
            <button className="btn block lg" disabled={preview?.status !== 'ok'} onClick={() => setStep('confirm')}>Review bid</button>
          </>
        ) : (
          <>
            <div className="notice info">
              <InformationCircleIcon />
              <span><strong className="w600">Bid up to <span className="mono">{preview!.amount!.text}</span>?</strong> We bid for you only as much as needed to keep you in the lead. If you win at your maximum you pay <strong className="mono w500">{preview!.total!.text}</strong> in total. A winning bid is binding.</span>
            </div>
            <div className="btn-group" style={{ width: '100%' }}>
              <button className="btn ghost lg" style={{ flex: 1 }} onClick={() => setStep('enter')} disabled={busy}>Change</button>
              <button className="btn lg" style={{ flex: 2 }} onClick={confirm} disabled={busy}>{busy ? 'Placing bid…' : 'Confirm bid'}</button>
            </div>
          </>
        )}
      </div>
      <div className="reassure">
        <ShieldCheckIcon />
        <span>
          Pay within {lot.rules?.payWindowHours ?? 48} hours of the close from your wallet. Collect from {lot.branch.name} within {lot.rules?.collectWindowHours ?? 48} hours.
          {lot.isVehicle && ' Released once police, ZIMRA and CVR transfer are complete.'}
          {lot.rules && <> Late bids extend the lot by {Math.round(lot.rules.softCloseSeconds / 60)} minutes.</>}
        </span>
      </div>
    </aside>
  );
}

function AllIn({ lot }: { lot: LotDetail }) {
  if (!lot.breakdown) return <div className="notice"><InformationCircleIcon /><span>The full price for this lot is not available right now, so bidding is paused.</span></div>;
  return (
    <div>
      <div className="micro" style={{ marginBottom: 6 }}>If you win at the next minimum bid</div>
      <div className="lines">
        {lot.breakdown.lines.map((l) => <div key={l.type} className="l"><span>{l.description}</span><span>{l.amount.text}</span></div>)}
        <div className="l total"><span>Total you pay</span><span>{lot.breakdown.total.text}</span></div>
      </div>
    </div>
  );
}

function JoinAuction({ lot }: { lot: LotDetail }) {
  const router = useRouter();
  const min = lot.rules?.depositMinimum ?? null;
  const [deposit, setDeposit] = useState(min ? (Number(min.minor) / 100).toString() : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function join() {
    setBusy(true);
    setError(null);
    const minor = lot.auction.depositRequired ? Math.round(Number(deposit) * 100) : null;
    if (lot.auction.depositRequired && (!Number.isFinite(minor) || minor! <= 0)) {
      setError('Enter the deposit amount.');
      setBusy(false);
      return;
    }
    const res = await fetch(`/api/auctions/${lot.auction.id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minor ? { depositMinor: String(minor) } : {}),
    });
    const body = (await res.json()) as { ok?: boolean; message?: string };
    setBusy(false);
    if (body.ok) router.refresh();
    else setError(body.message ?? 'Could not join this auction.');
  }
  return (
    <div className="stack">
      <div className="notice info">
        <InformationCircleIcon />
        <span>Join <strong className="w600">{lot.auction.title}</strong> to bid.{lot.auction.depositRequired && min && <> It needs a refundable deposit of at least <span className="mono">{min.text}</span>, held from your wallet. You can bid up to ten times your deposit.</>}</span>
      </div>
      {lot.auction.depositRequired && (
        <div className="field">
          <label htmlFor="deposit">Deposit (US$)</label>
          <div className="amount">
            <span className="cur">US$</span>
            <input id="deposit" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </div>
        </div>
      )}
      {error && <div className="notice bad"><ExclamationTriangleIcon /><span>{error}</span></div>}
      <button className="btn block lg" onClick={join} disabled={busy}>{busy ? 'Joining…' : 'Join auction'}</button>
    </div>
  );
}
