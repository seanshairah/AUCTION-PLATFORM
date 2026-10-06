'use client';

import { CameraIcon, CheckCircleIcon, NoSymbolIcon, QrCodeIcon } from '@heroicons/react/20/solid';
import { useEffect, useRef, useState } from 'react';

interface Result { released: boolean; message?: string; reason?: string; collectionId?: string; payouts?: string[]; payoutsBlocked?: Array<{ reason: string }>; amount?: { text: string } }
type Detector = { detect(v: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };

/**
 * Gate release (deliverable 15): scan the buyer's QR pass with the device camera where
 * the browser can read QR codes, or with a USB scanner / paste into the field. The
 * server re-checks the pass, title steps and storage charges before anything leaves.
 */
export function GateScanner() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [camera, setCamera] = useState<'off' | 'on' | 'unsupported'>('off');
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  async function release(t: string) {
    if (!t.trim()) return;
    setBusy(true);
    setResult(null);
    const res = await fetch('/api/staff/gate/release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t.trim() }) });
    const json = (await res.json().catch(() => null)) as Result | null;
    setBusy(false);
    setResult(json ?? { released: false, message: `Refused (${res.status}).` });
    if (!res.ok && json && !('released' in json)) setResult({ released: false, message: (json as { message?: string }).message ?? 'Refused.' });
  }

  function stop() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCamera('off');
  }

  async function start() {
    const Ctor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!Ctor || !navigator.mediaDevices) { setCamera('unsupported'); return; }
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).catch(() => null);
    if (!s) { setCamera('unsupported'); return; }
    stream.current = s;
    setCamera('on');
    const detector = new Ctor({ formats: ['qr_code'] });
    requestAnimationFrame(async function loop() {
      if (!stream.current || !video.current) return;
      if (video.current.readyState >= 2) {
        const codes = await detector.detect(video.current).catch(() => []);
        if (codes[0]?.rawValue) { setToken(codes[0].rawValue); stop(); void release(codes[0].rawValue); return; }
      }
      requestAnimationFrame(loop);
    });
  }

  useEffect(() => {
    if (camera === 'on' && video.current && stream.current) { video.current.srcObject = stream.current; void video.current.play(); }
  }, [camera]);
  useEffect(() => stop, []);

  return (
    <div className="gate">
      <div className="scanner">
        <div className="row between" style={{ position: 'relative' }}>
          <span className="micro" style={{ color: 'var(--night-muted)' }}>Gate scanner</span>
          {camera === 'on'
            ? <button type="button" className="btn sm outline-night" onClick={stop}>Stop camera</button>
            : <button type="button" className="btn sm outline-night" onClick={start}><CameraIcon /> Use camera</button>}
        </div>
        <div className="viewfinder">
          {camera === 'on' && <video ref={video} muted playsInline />}
          <div className="corners"><i /><i /><i /><i /></div>
          {camera === 'on' && <div className="scanline" />}
          {camera !== 'on' && (
            <div className="hint">
              <QrCodeIcon width={40} style={{ display: 'block', margin: '0 auto 10px', color: 'var(--night-muted)' }} />
              {camera === 'unsupported' ? 'This browser cannot read QR codes from the camera. Use a USB scanner or paste the pass below.' : 'Point the camera at the buyer’s pass, or scan with a USB reader into the field below.'}
            </div>
          )}
        </div>
        <form className="row" style={{ position: 'relative', gap: 8 }} onSubmit={(e) => { e.preventDefault(); void release(token); }}>
          <input className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Gate pass" aria-label="Gate pass" autoFocus />
          <button className="btn" disabled={busy || token.trim().length < 10}>{busy ? 'Checking…' : 'Release'}</button>
        </form>
      </div>
      {!result ? (
        <div className="verdict">
          <span className="micro">Waiting for a pass</span>
          <div className="big" style={{ color: 'var(--line)' }}>Ready</div>
          <p className="ink-2">Before releasing, the server checks that the pass is genuine and unused, that vehicle title steps are complete, and that storage is paid. If storage is due it is taken from the buyer’s wallet first.</p>
          <ul className="small ink-2" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Check the buyer’s ID matches the name on the pass.</li>
            <li>A pass works once. A second scan is refused.</li>
          </ul>
        </div>
      ) : result.released ? (
        <div className="verdict ok">
          <CheckCircleIcon className="icon" style={{ color: 'var(--good)' }} />
          <div className="big">Release</div>
          <p>Hand the goods over. The collection is recorded as released{result.payouts?.length ? ` and ${result.payouts.length} seller payout${result.payouts.length === 1 ? ' is' : 's are'} now due` : ''}.</p>
          {result.payoutsBlocked?.length ? <div className="notice small">Seller payout held: {result.payoutsBlocked.map((b) => b.reason.replaceAll('_', ' ')).join(', ')}</div> : null}
          <span className="micro">Collection {result.collectionId?.slice(0, 8)}</span>
          <button type="button" className="btn ghost" onClick={() => { setResult(null); setToken(''); }}>Next buyer</button>
        </div>
      ) : (
        <div className="verdict no">
          <NoSymbolIcon className="icon" style={{ color: 'var(--bad)' }} />
          <div className="big">Do not release</div>
          <p>{result.message ?? 'The pass was refused.'}</p>
          {result.amount && <div className="mono" style={{ fontSize: 22 }}>{result.amount.text} due</div>}
          <button type="button" className="btn ghost" onClick={() => { setResult(null); setToken(''); }}>Scan again</button>
        </div>
      )}
    </div>
  );
}
