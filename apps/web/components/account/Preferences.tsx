'use client';

import { CheckBadgeIcon, LockClosedIcon } from '@heroicons/react/20/solid';
import { useState } from 'react';

type Channel = 'whatsapp' | 'sms' | 'email' | 'push';
interface View { categories: Array<{ category: string; label: string; transactional: boolean; channels: Record<Channel, { enabled: boolean; consented: boolean }> }> }
const CHANNELS: Array<[Channel, string]> = [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email'], ['push', 'App']];

/** The preference centre: each kind of message by channel. Money and goods messages keep at least one channel. */
export function Preferences({ initial }: { initial: View }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function toggle(category: string, channel: Channel, enabled: boolean) {
    const r = await fetch('/api/me/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [{ category, channel, enabled }] }) });
    const j = (await r.json()) as View & { message?: string };
    if (r.ok) { setView(j); setMsg({ ok: true, text: 'Saved.' }); } else setMsg({ ok: false, text: j.message ?? 'Could not save.' });
  }
  return (
    <div className="stack">
      {msg && <div className={`notice ${msg.ok ? 'good' : 'bad'}`}><CheckBadgeIcon /><span>{msg.text}</span></div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>Message</th>{CHANNELS.map(([, l]) => <th key={l} style={{ textAlign: 'center' }}>{l}</th>)}</tr></thead>
          <tbody>
            {view.categories.map((c) => (
              <tr key={c.category}>
                <td><span className="w500">{c.label.charAt(0).toUpperCase() + c.label.slice(1)}</span>{c.transactional && <><br /><span className="small muted row" style={{ gap: 4 }}><LockClosedIcon width={12} /> Needs at least one channel</span></>}</td>
                {CHANNELS.map(([ch]) => {
                  const st = c.channels[ch];
                  return (
                    <td key={ch} style={{ textAlign: 'center' }}>
                      <input type="checkbox" aria-label={`${c.label} by ${ch}`} checked={st.enabled} disabled={!st.consented} title={st.consented ? '' : 'You have not agreed to this channel'} onChange={(e) => toggle(c.category, ch, e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--ink)' }} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Between 21:00 and 07:00 we hold WhatsApp, SMS and app messages until morning, except sign-in codes and lots closing overnight.</p>
    </div>
  );
}
