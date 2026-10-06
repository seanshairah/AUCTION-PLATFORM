'use client';

import { CheckCircle2, Info, ShieldCheck } from 'lucide-react';
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

  return (
    <aside className="card bid-panel" aria-label="Bid">
      <div className="now">
        <div>
          <div className="price-label">{lot.currentPrice ? 'Current bid' : 'Starting bid'}</div>
          <div className="big">{now.text}</div>
          <div className="small muted">{lot.bids} bids · {lot.bidders} bidders</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="price-label">Ends in</div>
          <div style={{ fontSize: 16 }}><Countdown endsAt={lot.endsAt} /></div>
          {lot.rules && <div className="small muted">Extends {Math.round(lot.rules.softCloseSeconds / 60)} min on late bids</div>}
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        {lot.reserveStatus === 'no_reserve' && <span className="pill good">No reserve</span>}
        {lot.reserveStatus === 'met' && <span className="pill good">Reserve met</span>}
        {lot.reserveStatus === 'not_met' && <span className="pill muted">Reserve not met yet</span>}
        {lot.viewer?.leading && <span className="pill good"><CheckCircle2 size={12} /> You are leading</span>}
        {lot.viewer?.yourMax && <span className="pill info">Your maximum {lot.viewer.yourMax.text}</span>}
      </div>

      {result && <div className={`notice ${result.ok ? 'good' : 'bad'}`} role="status">{result.message}</div>}

      {lot.closed ? (
        <div className="notice info">Bidding has closed on this lot.</div>
      ) : !signedIn ? (
        <>
          <AllIn lot={lot} />
          <Link href={`/sign-in?next=/lots/${encodeURIComponent(lot.ref)}`} className="btn block lg">Sign in to bid</Link>
        </>
      ) : pending ? (
        <div className="notice">Your registration for this auction is being reviewed. We will message you when you can bid.</div>
      ) : !registered ? (
        <>
          <AllIn lot={lot} />
          <JoinAuction lot={lot} />
        </>
      ) : step === 'enter' ? (
        <>
          <div className="field">
            <label htmlFor="max">Your maximum bid</label>
            <div className="amount-input">
              <span className="cur">US$</span>
              <input id="max" inputMode="decimal" autoComplete="off" placeholder={lot.nextMinimum.text.replace('US$', '')} value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
            <div className="quick">
              {quick.map((m) => (
                <button key={m.minor} type="button" onClick={() => setTyped((Number(m.minor) / 100).toString())}>Next minimum {m.text}</button>
              ))}
            </div>
          </div>
          {preview && preview.status !== 'empty' && (
            <div className={preview.status === 'ok' ? '' : `notice ${preview.status === 'over_limit' ? '' : 'bad'}`}>
              {preview.lines && (
                <div style={{ marginBottom: preview.status === 'ok' ? 0 : 8 }}>
                  {preview.lines.map((l) => <div key={l.type} className="kv"><span>{l.description}</span><span>{l.amount.text}</span></div>)}
                  <div className="kv total"><span>You pay if you win at this</span><span>{preview.total!.text}</span></div>
                </div>
              )}
              <div className={preview.status === 'ok' ? 'small muted' : 'small'}>{preview.message}</div>
            </div>
          )}
          {preview?.availableToBid && <div className="small muted">You can bid up to {preview.availableToBid.text} all-in across your leading lots.</div>}
          <button className="btn block lg" disabled={preview?.status !== 'ok'} onClick={() => setStep('confirm')}>Review bid</button>
        </>
      ) : (
        <>
          <div className="notice info">
            <strong>Bid up to {preview!.amount!.text}?</strong>
            <div>We bid for you only as much as needed to keep you in the lead. If you win at your maximum, you pay <strong>{preview!.total!.text}</strong> in total. A winning bid is binding.</div>
          </div>
          <div className="row">
            <button className="btn ghost" style={{ flex: 1 }} onClick={() => setStep('enter')} disabled={busy}>Change</button>
            <button className="btn lg" style={{ flex: 2 }} onClick={confirm} disabled={busy}>{busy ? 'Placing bid…' : 'Confirm bid'}</button>
          </div>
        </>
      )}

      <div className="small muted row" style={{ alignItems: 'flex-start' }}>
        <ShieldCheck size={16} style={{ flex: 'none', marginTop: 2 }} />
        <span>
          Pay within {lot.rules?.payWindowHours ?? 48} hours of the close from your wallet. Collect from {lot.branch.name} within {lot.rules?.collectWindowHours ?? 48} hours.
          {lot.isVehicle && ' Released after police, ZIMRA and CVR transfer are complete.'}
        </span>
      </div>
    </aside>
  );
}

function AllIn({ lot }: { lot: LotDetail }) {
  if (!lot.breakdown) return <div className="notice">The full price for this lot is not available right now, so bidding is paused.</div>;
  return (
    <div>
      <div className="small muted row" style={{ marginBottom: 6 }}><Info size={14} /> If you win at the next minimum bid</div>
      {lot.breakdown.lines.map((l) => <div key={l.type} className="kv"><span>{l.description}</span><span>{l.amount.text}</span></div>)}
      <div className="kv total"><span>Total you pay</span><span>{lot.breakdown.total.text}</span></div>
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
        Join <strong>{lot.auction.title}</strong> to bid.
        {lot.auction.depositRequired && min && <> This auction needs a refundable deposit of at least {min.text}, held from your wallet. You can bid up to 10 times your deposit.</>}
      </div>
      {lot.auction.depositRequired && (
        <div className="field">
          <label htmlFor="deposit">Deposit (US$)</label>
          <div className="amount-input">
            <span className="cur">US$</span>
            <input id="deposit" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </div>
        </div>
      )}
      {error && <div className="notice bad">{error}</div>}
      <button className="btn block lg" onClick={join} disabled={busy}>{busy ? 'Joining…' : 'Join auction'}</button>
    </div>
  );
}
