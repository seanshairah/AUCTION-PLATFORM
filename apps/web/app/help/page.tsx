import { ChevronDownIcon, QuestionMarkCircleIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { WhatsAppMark } from '@/components/Marks';

export const metadata = { title: 'Help' };

const QA: Array<{ id: string; q: string; a: React.ReactNode }> = [
  { id: 'all-in', q: 'Is the price I see the price I pay?', a: <>Yes. Before you bid, the commit screen shows the hammer price plus every levy, tax and fee, from the same rulebook that writes your invoice. If anything changes between your screen and our server, your bid is refused and you see the new total. <Link className="link" href="/rules">Fees and rules</Link></> },
  { id: 'proxy', q: 'How does automatic bidding work?', a: 'You set a maximum. We bid for you only as much as needed to keep you in the lead, up to that maximum. Nobody sees it. If two people set the same maximum, the earlier one wins.' },
  { id: 'soft-close', q: 'Why did the end time move?', a: 'A bid in the last minutes extends the lot by ten minutes, so everyone has a fair chance to respond. Lots also close a few minutes apart rather than all at once.' },
  { id: 'deposit', q: 'Do I lose my deposit if I do not win?', a: 'No. The deposit is held in your wallet, not spent, and released when the auction settles. If you win and pay, it counts towards your invoice. It is forfeited only if you win and do not pay.' },
  { id: 'viewing', q: 'Can I see a vehicle before I bid?', a: 'Yes. Book a viewing slot on the lot page. Every vehicle also has a published 29-point inspection report, the standard photo set and a walk-around video.' },
  { id: 'collection', q: 'How do I collect what I bought?', a: 'Pay from your wallet within 48 hours of the close and you get a QR gate pass. Show it at the branch within the collection window. Vehicles are released once the police, ZIMRA and CVR transfer steps are complete.' },
  { id: 'remedy', q: 'What if a vehicle is not as described?', a: 'If the chassis or engine number differs, the odometer is off by more than 10 %, or a key item reported fine is failing, you are covered by the gross-inaccuracy remedy: a refund through your wallet, and the vehicle goes back to the seller.' },
  { id: 'bulk', q: 'What columns does a bulk upload need?', a: 'external_ref, title, description, category, item_state, condition, condition_notes, currency, starting_bid, reserve, estimate_low, estimate_high, quantity. Up to 2,000 rows per file.' },
];

export default function HelpPage() {
  return (
    <section className="section">
      <div className="wrap" style={{ maxWidth: 880 }}>
        <div className="micro"><QuestionMarkCircleIcon width={14} style={{ verticalAlign: '-2px' }} /> Help centre</div>
        <h1 className="display d-lg" style={{ margin: '8px 0 24px' }}>Questions, answered</h1>
        <div className="card">
          {QA.map((x, i) => (
            <details key={x.id} id={x.id} className="fgroup" style={{ borderTop: i ? undefined : 0, padding: '0 20px' }}>
              <summary style={{ fontFamily: 'var(--sans)', fontSize: 15, letterSpacing: 0, textTransform: 'none', color: 'var(--ink)', fontWeight: 500 }}>{x.q}<ChevronDownIcon /></summary>
              <div className="fbody ink-2" style={{ maxWidth: '70ch' }}>{x.a}</div>
            </details>
          ))}
        </div>
        <div className="notice neutral" style={{ marginTop: 16 }}>
          <WhatsAppMark size={18} />
          <span>Still stuck? Message us on WhatsApp, or visit the Harare or Bulawayo branch, Monday to Friday 9:00–15:00 and Saturday 9:00–12:00.</span>
        </div>
      </div>
    </section>
  );
}
