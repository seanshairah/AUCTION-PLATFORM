'use client';

import { CheckBadgeIcon, DevicePhoneMobileIcon, ExclamationTriangleIcon, PlusIcon, XMarkIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const METHODS = [
  ['ecocash', 'EcoCash'],
  ['onemoney', 'OneMoney'],
  ['innbucks', 'InnBucks'],
  ['zimswitch', 'ZimSwitch'],
  ['card', 'Card'],
] as const;

type State =
  | { step: 'form' }
  | { step: 'waiting'; paymentId: string; message: string; simulated: boolean }
  | { step: 'done'; ok: boolean; message: string };

/**
 * Wallet top-up: the gateway prompts the payer's phone, the server credits the wallet
 * only after the gateway confirms it. In development an in-memory gateway stands in,
 * and a button plays the phone's approval.
 */
export function TopUp() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('100');
  const [method, setMethod] = useState<(typeof METHODS)[number][0]>('ecocash');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<State>({ step: 'form' });
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);

  useEffect(() => {
    if (state.step !== 'waiting') return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/me/top-ups/${state.paymentId}`, { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { status: string; amount: { text: string } };
      if (j.status === 'succeeded') {
        setState({ step: 'done', ok: true, message: `${j.amount.text} added to your wallet.` });
        router.refresh();
      } else if (['failed', 'cancelled', 'expired'].includes(j.status)) {
        setState({ step: 'done', ok: false, message: 'The payment was not completed. Nothing was taken from your account.' });
      }
    }, 2500);
    return () => clearInterval(t);
  }, [state, router]);

  async function start() {
    const minor = Math.round(Number(amount) * 100);
    if (!Number.isFinite(minor) || minor < 100) return;
    setBusy(true);
    key.current ??= crypto.randomUUID();
    const r = await fetch('/api/me/top-ups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountMinor: String(minor), method, phone: method !== 'card' && phone.replace(/\D/g, '').length >= 9 ? phone.replace(/\s/g, '') : undefined, clientKey: key.current }),
    });
    setBusy(false);
    const j = (await r.json()) as { paymentId: string | null; status: string; message: string; simulated?: boolean };
    if (j.paymentId && (j.status === 'pending' || j.status === 'unknown')) setState({ step: 'waiting', paymentId: j.paymentId, message: j.message, simulated: Boolean(j.simulated) });
    else setState({ step: 'done', ok: false, message: j.message ?? 'Could not start the payment.' });
  }

  async function simulate(approve: boolean) {
    if (state.step !== 'waiting') return;
    await fetch(`/api/dev/fake-gateway/payments/${state.paymentId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve }) });
  }

  function reset() {
    key.current = null;
    setState({ step: 'form' });
  }

  if (!open) return <button className="btn" onClick={() => setOpen(true)}><PlusIcon /> Top up</button>;
  return (
    <div className="topup-pop card" role="dialog" aria-label="Top up your wallet">
      <div className="panel-head"><h2><PlusIcon /> Top up</h2><button className="icon-btn" style={{ width: 32, height: 32 }} onClick={() => { setOpen(false); reset(); }} aria-label="Close"><XMarkIcon /></button></div>
      <div className="panel-body stack">
        {state.step === 'form' && (
          <>
            <div className="field">
              <label htmlFor="tu-amt">Amount</label>
              <div className="amount"><span className="cur">US$</span><input id="tu-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            </div>
            <div className="field">
              <span className="label">Pay with</span>
              <div className="btn-group" role="radiogroup" style={{ flexWrap: 'wrap' }}>
                {METHODS.map(([v, l]) => <button key={v} type="button" className="btn sm ghost" aria-pressed={method === v} onClick={() => setMethod(v)}>{l}</button>)}
              </div>
            </div>
            {method !== 'card' && (
              <div className="field">
                <label htmlFor="tu-phone">Mobile number</label>
                <input id="tu-phone" className="input mono" value={phone} placeholder="+263 77 123 4567" onChange={(e) => setPhone(e.target.value)} />
              </div>
            )}
            <button className="btn block lg" onClick={start} disabled={busy}>{busy ? 'Starting…' : `Top up US$${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}</button>
          </>
        )}
        {state.step === 'waiting' && (
          <>
            <div className="notice info"><DevicePhoneMobileIcon /><span>{state.message} We add it to your wallet as soon as the payment is confirmed.</span></div>
            {state.simulated && (
              <div className="stack-8">
                <span className="micro">Demo: play the phone</span>
                <div className="btn-group">
                  <button className="btn ghost" onClick={() => simulate(true)}>Approve on phone</button>
                  <button className="btn ghost" onClick={() => simulate(false)}>Decline</button>
                </div>
              </div>
            )}
          </>
        )}
        {state.step === 'done' && (
          <>
            <div className={`notice ${state.ok ? 'good' : 'bad'}`}>{state.ok ? <CheckBadgeIcon /> : <ExclamationTriangleIcon />}<span>{state.message}</span></div>
            <button className="btn ghost" onClick={reset}>Make another top-up</button>
          </>
        )}
      </div>
    </div>
  );
}
