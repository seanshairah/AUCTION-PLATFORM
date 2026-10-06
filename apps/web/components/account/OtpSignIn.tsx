'use client';

import { ChatBubbleBottomCenterTextIcon, ChevronRightIcon, DevicePhoneMobileIcon, EnvelopeIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Step = { s: 'contact' } | { s: 'code'; challengeId: string; sentTo: string; via: string; resendAfter: string } | { s: 'details'; challengeId: string; code: string };

function fingerprint(): string {
  try {
    const k = 'abc_device';
    const v = localStorage.getItem(k) ?? crypto.randomUUID();
    localStorage.setItem(k, v);
    return v;
  } catch {
    return crypto.randomUUID();
  }
}

/** Sign in or sign up with a one-time code by WhatsApp (falling back to SMS) or email (docs/16 §9). */
export function OtpSignIn({ next, demo }: { next: string; demo: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ s: 'contact' });
  const [contact, setContact] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState({ whatsapp: true, sms: true, email: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inbox, setInbox] = useState<Array<{ channel: string; text: string }>>([]);

  useEffect(() => {
    if (!demo || step.s !== 'code') return;
    const poll = async () => {
      const r = await fetch(`/api/dev/inbox?to=${encodeURIComponent(contact)}`, { cache: 'no-store' });
      if (r.ok) setInbox((await r.json()) as Array<{ channel: string; text: string }>);
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [demo, step, contact]);

  async function start() {
    setBusy(true); setError(null);
    const r = await fetch('/api/auth/otp/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact }) });
    const j = (await r.json()) as { challengeId?: string; sentTo?: string; via?: string; resendAfter?: string; message?: string };
    setBusy(false);
    if (j.challengeId) setStep({ s: 'code', challengeId: j.challengeId, sentTo: j.sentTo!, via: j.via!, resendAfter: j.resendAfter! });
    else setError(j.message ?? 'Could not send a code.');
  }

  async function verify(challengeId: string, theCode: string, withDetails: boolean) {
    setBusy(true); setError(null);
    const r = await fetch('/api/auth/otp/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, code: theCode, device: { fingerprint: fingerprint(), platform: 'web' }, ...(withDetails ? { displayName: name, consent: { ...consent, push: false } } : {}) }),
    });
    const j = (await r.json()) as { code?: string; message?: string };
    setBusy(false);
    if (r.ok) { router.push(next); router.refresh(); return; }
    if (j.code === 'details_required') { setStep({ s: 'details', challengeId, code: theCode }); return; }
    setError(j.message ?? 'Sign-in failed.');
  }

  return (
    <div className="card">
      <div className="panel-body stack">
        {step.s === 'contact' && (
          <>
            <div className="field">
              <label htmlFor="otp-contact">Mobile number or email</label>
              <input id="otp-contact" className="input" autoComplete="username" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+263 77 123 4567 or you@example.com" onKeyDown={(e) => e.key === 'Enter' && start()} />
            </div>
            <p className="small muted">We send a code by WhatsApp, or by SMS if WhatsApp does not reach you. No password needed.</p>
            {error && <div className="notice bad">{error}</div>}
            <button className="btn lg" disabled={busy || contact.trim().length < 5} onClick={start}>{busy ? 'Sending…' : 'Send me a code'} <ChevronRightIcon /></button>
          </>
        )}
        {step.s === 'code' && (
          <>
            <div className="notice info">{step.via === 'email' ? <EnvelopeIcon /> : <DevicePhoneMobileIcon />}<span>We sent a code to <span className="mono">{step.sentTo}</span>{step.via === 'email' ? ' by email' : ' by WhatsApp, or SMS'}.</span></div>
            <div className="field">
              <label htmlFor="otp-code">Code</label>
              <input id="otp-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 22, letterSpacing: '0.3em', height: 52 }} onKeyDown={(e) => e.key === 'Enter' && verify(step.challengeId, code, false)} />
            </div>
            {error && <div className="notice bad">{error}</div>}
            <div className="btn-group">
              <button className="btn ghost" onClick={() => { setStep({ s: 'contact' }); setCode(''); }}>Change number</button>
              <button className="btn" disabled={busy || code.length < 4} onClick={() => verify(step.challengeId, code, false)}>{busy ? 'Checking…' : 'Sign in'}</button>
            </div>
            {demo && (
              <div className="nest">
                <div className="nest-head"><ChatBubbleBottomCenterTextIcon /><h3>Demo phone</h3><span className="micro" style={{ marginLeft: 'auto' }}>messages this number would receive</span></div>
                <div className="nest-body stack-8">
                  {inbox.length === 0 ? <p className="small muted">Waiting for the message…</p> : inbox.map((m, i) => <p key={i} className="small"><span className="micro">{m.channel}</span> {m.text}</p>)}
                </div>
              </div>
            )}
          </>
        )}
        {step.s === 'details' && (
          <>
            <div className="notice info"><span>Welcome. Tell us your name and how we may contact you, and your account is ready.</span></div>
            <div className="field"><label htmlFor="otp-name">Your name</label><input id="otp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="stack-8">
              <span className="micro">Contact me about my bids, money and goods by</span>
              {(['whatsapp', 'sms', 'email'] as const).map((c) => <label key={c} className="check"><input type="checkbox" checked={consent[c]} onChange={(e) => setConsent({ ...consent, [c]: e.target.checked })} /> {c === 'sms' ? 'SMS' : c === 'whatsapp' ? 'WhatsApp' : 'Email'}</label>)}
            </div>
            {error && <div className="notice bad">{error}</div>}
            <button className="btn lg" disabled={busy || !name.trim()} onClick={() => verify(step.challengeId, step.code, true)}>{busy ? 'Creating…' : 'Create my account'}</button>
          </>
        )}
      </div>
    </div>
  );
}
