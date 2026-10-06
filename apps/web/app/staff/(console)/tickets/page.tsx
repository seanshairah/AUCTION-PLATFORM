import { ChatBubbleLeftRightIcon, ClockIcon, ExclamationTriangleIcon, InboxIcon, UserPlusIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { WhatsAppMark } from '@/components/Marks';
import { Action } from '@/components/staff/Action';
import { Compose } from '@/components/staff/Compose';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { plainName, relative, staffMe, words } from '@/lib/staff';

export const metadata = { title: 'Tickets' };

interface Ticket {
  id: string; number: string; account: { id: string; name: string }; channel: string; category: string; subject: string; priority: string; status: string;
  owner: { id: string; name: string } | null; firstResponseDueAt: string; resolutionDueAt: string; firstRespondedAt: string | null;
  breached: { firstResponse: boolean; resolution: boolean }; createdAt: string;
  messages: Array<{ id: string; author: string; authorName: string; body: string; internal: boolean; at: string }>;
}

const TABS = [['active', 'Active'], ['open', 'New'], ['pending_customer', 'Waiting on customer'], ['resolved', 'Resolved']] as const;

function Due({ t }: { t: Ticket }) {
  if (t.status === 'resolved' || t.status === 'closed') return <span className="status good">Resolved</span>;
  if (!t.firstRespondedAt) {
    return t.breached.firstResponse
      ? <span className="status bad"><ExclamationTriangleIcon /> Reply overdue</span>
      : <span className="status warn"><ClockIcon /> Reply {relative(t.firstResponseDueAt)}</span>;
  }
  return t.breached.resolution ? <span className="status bad"><ExclamationTriangleIcon /> Past resolution time</span> : <span className="status neutral"><ClockIcon /> Resolve {relative(t.resolutionDueAt)}</span>;
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<{ status?: string; t?: string }> }) {
  const me = (await staffMe())!;
  const { status = 'active', t } = await searchParams;
  const list = await apiOrNull<Ticket[]>(`/staff/tickets?status=${encodeURIComponent(status)}`);
  if (!list) return <div className="notice bad">Your role cannot see the support queue.</div>;
  const selectedId = t ?? list[0]?.id;
  const ticket = selectedId ? await apiOrNull<Ticket>(`/staff/tickets/${selectedId}`) : null;
  const q = (id: string) => `/staff/tickets?status=${status}&t=${id}`;
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><ChatBubbleLeftRightIcon /> Deliverable 17</span>
          <h1>Tickets</h1>
          <p>One queue for web and WhatsApp. Every ticket has an owner, a first-reply time and a resolution time; the worker flags the ones that slip.</p>
        </div>
        <nav className="seg-tabs" aria-label="Status">
          {TABS.map(([k, label]) => <Link key={k} href={`/staff/tickets?status=${k}`} className={status === k ? 'on' : ''}>{label}</Link>)}
        </nav>
      </div>

      <div className="inbox">
        <div className="list" role="list">
          {list.length === 0 && <div className="empty"><InboxIcon /><b>Inbox zero</b><span>No tickets in this view.</span></div>}
          {list.map((x) => (
            <Link key={x.id} href={q(x.id)} className={`item${x.id === selectedId ? ' on' : ''}`} role="listitem">
              <div className="row between" style={{ marginBottom: 4 }}>
                <span className="row" style={{ gap: 6 }}>{x.channel === 'whatsapp' ? <WhatsAppMark size={14} /> : <ChatBubbleLeftRightIcon width={14} className="muted" />}<span className="micro">{x.number} · {x.account.name}</span></span>
                <span className="micro">{relative(x.createdAt)}</span>
              </div>
              <div className="s">{x.subject}</div>
              <div className="p">{x.messages.at(-1)?.body}</div>
              <div className="row between" style={{ marginTop: 8 }}>
                <Due t={x} />
                <span className="small muted">{x.owner ? plainName(x.owner.name) : 'Unassigned'}</span>
              </div>
            </Link>
          ))}
        </div>
        <div className="thread">
          {!ticket ? <div className="empty" style={{ margin: 'auto' }}><ChatBubbleLeftRightIcon /><b>Pick a ticket</b></div> : (
            <>
              <header>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="chip">{words(ticket.category)}</span>
                    <span className="chip">{ticket.channel === 'whatsapp' ? <><WhatsAppMark size={12} /> WhatsApp</> : words(ticket.channel)}</span>
                    <span className={`chip${ticket.priority === 'urgent' || ticket.priority === 'high' ? ' accent' : ''}`}>{words(ticket.priority)} priority</span>
                    <Due t={ticket} />
                  </div>
                  <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 10 }}>{ticket.subject}</h2>
                  <div className="small muted" style={{ marginTop: 4 }}>{ticket.number} · {ticket.account.name} · opened {shortDateTime(ticket.createdAt)}</div>
                </div>
                <div className="stack-8" style={{ alignItems: 'flex-end', flex: 'none' }}>
                  <span className="micro">Owner</span>
                  <span className="w500">{ticket.owner ? plainName(ticket.owner.name) : 'Unassigned'}</span>
                  {ticket.owner?.id !== me.id && <Action url={`/staff/tickets/${ticket.id}/assign`} body={{ ownerStaffId: me.id }} label="Take it" icon={<UserPlusIcon />} done="Assigned to you." />}
                </div>
              </header>
              <div className="msgs">
                {ticket.messages.map((m) => (
                  <div key={m.id} className={`msg${m.author === 'customer' ? '' : ' staff'}${m.internal ? ' internal' : ''}`}>
                    <div className="bubble">{m.body}</div>
                    <span className="by">{m.author === 'customer' ? m.authorName : plainName(m.authorName)}{m.internal ? ' · internal note' : ''} · {shortDateTime(m.at)}</span>
                  </div>
                ))}
              </div>
              {ticket.status !== 'closed' && <div className="compose"><Compose url={`/staff/tickets/${ticket.id}/messages`} /></div>}
            </>
          )}
        </div>
      </div>
    </>
  );
}
