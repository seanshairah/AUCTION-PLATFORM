import { CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon, ClipboardDocumentCheckIcon, ClockIcon, DocumentTextIcon, ExclamationTriangleIcon, EyeIcon, MapPinIcon, MinusCircleIcon, PhoneIcon, Squares2X2Icon, TruckIcon, XCircleIcon } from '@heroicons/react/20/solid';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BidPanel } from '@/components/BidPanel';
import { Gallery, type GalleryPhoto } from '@/components/Gallery';
import { LiveRefresher } from '@/components/LiveRefresher';
import { ReserveStatus } from '@/components/LotCards';
import { MakeMark } from '@/components/Marks';
import { Viewings } from '@/components/Viewings';
import { api, apiOrNull } from '@/lib/api';
import { BODY_LABEL, km, shortDateTime, titleCase } from '@/lib/format';
import { demoCredits, demoPhotoCount, demoSet } from '@/lib/media';
import type { InspectionItem, LotCard, LotDetail, Me } from '@/lib/types';

type Props = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const lot = await apiOrNull<LotDetail>(`/lots/${encodeURIComponent(decodeURIComponent((await params).ref))}`);
  return lot ? { title: lot.title, description: `${lot.title}. ${lot.inspectionSummary?.split('\n')[0] ?? lot.description}`.slice(0, 160) } : { title: 'Lot not found' };
}

const SECTION: Record<string, string> = {
  identity: 'Identity', documents: 'Documents', exterior: 'Exterior', interior: 'Interior', mechanical: 'Mechanical', structure: 'Structure', road_test: 'Road test',
};

function Answer({ item }: { item: InspectionItem }) {
  switch (item.answer) {
    case 'ok': return <CheckCircleIcon className="ok" aria-label="Fine" />;
    case 'attention': return <ExclamationTriangleIcon className="attention" aria-label="Needs attention" />;
    case 'fail': return <XCircleIcon className="fail" aria-label="Failed" />;
    default: return <MinusCircleIcon className="na" aria-label="Not applicable" />;
  }
}

function lotNumber(ref: string): string {
  const n = ref.split('-').pop();
  return n && /^\d+$/.test(n) ? `Lot ${n.padStart(3, '0')}` : ref;
}

export default async function LotPage({ params }: Props) {
  const ref = decodeURIComponent((await params).ref);
  const [lot, me, siblings] = await Promise.all([
    apiOrNull<LotDetail>(`/lots/${encodeURIComponent(ref)}`),
    apiOrNull<Me>('/me'),
    api<{ lots: LotCard[] }>('/lots?sort=ending_soon').catch(() => ({ lots: [] as LotCard[] })),
  ]);
  if (!lot) notFound();
  const v = lot.vehicle;
  const idx = siblings.lots.findIndex((l) => l.ref === lot.ref);
  const prev = idx > 0 ? siblings.lots[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.lots.length - 1 ? siblings.lots[idx + 1] : null;

  const photos = lot.media.filter((m) => m.kind === 'photo');
  const set = demoSet(photos[0]?.url);
  const distinct: GalleryPhoto[] = (set ? photos.slice(0, demoPhotoCount(set)) : photos).map((p) => ({ url: p.url, role: p.role }));
  const flagged = lot.inspection?.sections.flatMap((s) => s.items).filter((i) => i.answer === 'attention' || i.answer === 'fail') ?? [];
  const demo = /\(demo\)\s*$/i.test(lot.auction.title);

  return (
    <>
      {!lot.closed && <LiveRefresher lotRef={lot.ref} />}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(lot.jsonLd).replace(/</g, '\\u003c') }} />
      <section className="lot-head">
        <div className="wrap inner">
          <div className="row between" style={{ flexWrap: 'wrap', gap: 16 }}>
            <div className="chips" style={{ marginBottom: 0 }}>
              <span className="chip accent">{lotNumber(lot.ref)}</span>
              <span className="chip night">{lot.closed ? 'Closed' : 'Live'}</span>
              <span className="chip night">{lot.reserveStatus === 'no_reserve' ? 'No reserve' : lot.reserveStatus === 'met' ? 'Reserve met' : 'Reserve not met'}</span>
              <span className="chip night"><MapPinIcon /> {lot.branch.name.replace('ABC Auctions ', '')}</span>
              {demo && <span className="chip night">Demo listing</span>}
            </div>
            <div className="btn-group">
              <Link href={prev ? `/lots/${encodeURIComponent(prev.ref)}` : '#'} aria-disabled={!prev} className="btn sm outline-night" aria-label="Previous lot" style={prev ? undefined : { opacity: 0.4, pointerEvents: 'none' }}><ChevronLeftIcon /></Link>
              <Link href="/auctions" className="btn sm outline-night"><Squares2X2Icon /> Back to docket</Link>
              <Link href={next ? `/lots/${encodeURIComponent(next.ref)}` : '#'} aria-disabled={!next} className="btn sm outline-night" aria-label="Next lot" style={next ? undefined : { opacity: 0.4, pointerEvents: 'none' }}><ChevronRightIcon /></Link>
            </div>
          </div>
          <h1 className="display d-lg" style={{ marginTop: 20 }}>{lot.title}</h1>
          <div className="sub row" style={{ gap: 14, flexWrap: 'wrap' }}>
            {v && <span className="row" style={{ gap: 6 }}><MakeMark make={v.make} size={14} /> {v.make}</span>}
            {v && <span>{km(v.odometerKm)}</span>}
            {v && <span>{v.zimbabweRegistered ? 'ZW-registered' : 'Imported'}</span>}
            <span>{lot.auction.title}</span>
          </div>
          <nav className="tabs" aria-label="Sections">
            <a href="#overview" className="on"><Squares2X2Icon /> Overview</a>
            {lot.inspection && <a href="#inspection"><ClipboardDocumentCheckIcon /> Inspection</a>}
            <a href="#history"><ClockIcon /> Bid history</a>
            <a href="#description"><DocumentTextIcon /> Description</a>
            {lot.isVehicle && !lot.closed && <a href="#viewing"><EyeIcon /> Viewing</a>}
            <a href="#collection"><TruckIcon /> Collection</a>
          </nav>
        </div>
      </section>

      <div className="wrap lot-layout">
        <div>
          <section id="overview">
            {distinct.length > 0 ? (
              <Gallery photos={distinct} total={photos.length} hasVideo={lot.media.some((m) => m.kind === 'video')} title={lot.title} />
            ) : (
              <div className="card empty"><p>Photos are being added to this lot.</p></div>
            )}
            {set && (
              <p className="credit">
                Demo photos of the same model, not this vehicle:{' '}
                {demoCredits(set).map((c, i) => (
                  <span key={c.file}>{i > 0 && '; '}<a href={c.source} rel="noreferrer" target="_blank">{c.artist || 'Wikimedia Commons'}</a>, {c.license}</span>
                ))}
                .
              </p>
            )}
          </section>

          {v && (
            <section className="panel" style={{ marginTop: 16 }}>
              <div className="panel-head"><h2>Vehicle</h2><span className="micro">{lot.category.name}</span></div>
              <div className="panel-body">
                <div className="spec-table">
                  <div className="r"><span>Year</span><span className="mono">{v.year ?? '—'}</span></div>
                  <div className="r"><span>Odometer</span><span className="mono">{km(v.odometerKm)}</span></div>
                  <div className="r"><span>Transmission</span><span>{titleCase(v.transmission)}</span></div>
                  <div className="r"><span>Fuel</span><span>{titleCase(v.fuel)}</span></div>
                  <div className="r"><span>Body</span><span>{v.bodyStyle ? BODY_LABEL[v.bodyStyle] : '—'}</span></div>
                  <div className="r"><span>Drive</span><span>{v.drive?.toUpperCase() ?? '—'}</span></div>
                  <div className="r"><span>Colour</span><span>{v.colour ?? '—'}</span></div>
                  <div className="r"><span>Registration</span><span>{v.zimbabweRegistered ? 'Zimbabwe' : 'Imported, ZIMRA cleared'}</span></div>
                  <div className="r"><span>Documents</span><span>{titleCase(lot.documentsStatus)}</span></div>
                  <div className="r"><span>Condition</span><span>{lot.itemState.label} · {lot.condition.label}</span></div>
                </div>
              </div>
            </section>
          )}

          {lot.inspection && (
            <section className="panel" id="inspection" style={{ marginTop: 16 }}>
              <div className="panel-head">
                <h2><ClipboardDocumentCheckIcon /> Inspection report</h2>
                <span className={`status ${lot.inspection.identityVerified ? 'good' : 'warn'}`}>
                  {lot.inspection.identityVerified ? <CheckCircleIcon /> : <ExclamationTriangleIcon />}
                  {lot.inspection.identityVerified ? 'Chassis and engine numbers verified' : 'Identity check pending'}
                </span>
              </div>
              <div className="panel-body stack">
                <div className="kpis" style={{ ['--n' as string]: 4 }}>
                  <div className="kpi"><span className="micro">Result</span><span className="v">{(() => {
                    const items = lot.inspection.sections.flatMap((x) => x.items);
                    const n = (a: string) => items.filter((i) => i.answer === a).length;
                    return `${n('ok')} fine · ${n('attention')} attention · ${n('fail')} failed`;
                  })()}</span></div>
                  <div className="kpi"><span className="micro">Odometer seen</span><span className="v">{km(lot.inspection.odometerKm)}</span></div>
                  <div className="kpi"><span className="micro">Evidence</span><span className="v">{lot.inspection.photoCount} photos{lot.inspection.hasVideo ? ' · video' : ''}</span></div>
                  <div className="kpi"><span className="micro">Inspected</span><span className="v">{shortDateTime(lot.inspection.inspectedAt)}</span></div>
                </div>
                {flagged.map((i) => (
                  <div key={i.id} className={`flag${i.answer === 'fail' ? ' bad' : ''}`}>
                    {i.answer === 'fail' ? <XCircleIcon /> : <ExclamationTriangleIcon />}
                    <span><strong className="w600">{i.label}.</strong> {i.note}</span>
                  </div>
                ))}
                <div className="checklist">
                  {lot.inspection.sections.map((s) => (
                    <div key={s.section} style={{ display: 'contents' }}>
                      <div className="sect-label">{SECTION[s.section] ?? s.section}</div>
                      {s.items.map((i) => (
                        <div key={i.id} className="ci"><Answer item={i} /><span>{i.label}{i.material && <span className="key">Key item</span>}</span></div>
                      ))}
                    </div>
                  ))}
                </div>
                <p className="small muted">
                  Checklist {lot.inspection.checklistVersion}. A published report never changes. If a key item, the odometer or an identity number proves wrong at collection, you are covered by the gross-inaccuracy remedy.
                </p>
              </div>
            </section>
          )}

          <section className="panel" id="history" style={{ marginTop: 16 }}>
            <div className="panel-head"><h2><ClockIcon /> Bid history</h2><span className="micro">{lot.bids} bids · {lot.bidders} bidders</span></div>
            <div className="panel-body">
              {lot.history.length === 0 ? (
                <p className="muted">No bids yet. Bidding starts at <span className="mono">{lot.startingBid.text}</span>.</p>
              ) : (
                <div className="timeline">
                  {lot.history.map((h, i) => (
                    <div key={h.seq} className={`tl-item${i === 0 ? ' top' : ''}`}>
                      <span className="who">{h.bidder}{h.auto && <span className="muted"> · automatic</span>}</span>
                      <span className="amt">{h.amount.text}</span>
                      <span className="when">{shortDateTime(h.at)}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="small muted" style={{ marginTop: 12 }}>Bidders are numbered in order of their first bid. Nobody sees anyone else&apos;s maximum.</p>
            </div>
          </section>

          <section className="panel" id="description" style={{ marginTop: 16 }}>
            <div className="panel-head"><h2><DocumentTextIcon /> Description</h2><ReserveStatus status={lot.reserveStatus} /></div>
            <div className="panel-body"><p className="ink-2" style={{ maxWidth: '70ch' }}>{lot.description}</p></div>
          </section>

          {lot.isVehicle && !lot.closed && (
            <section className="panel" id="viewing" style={{ marginTop: 16 }}>
              <div className="panel-head"><h2><EyeIcon /> Book a viewing</h2><span className="micro">30 minutes · bring your ID</span></div>
              <div className="panel-body"><Viewings lotRef={lot.ref} signedIn={Boolean(me)} branch={lot.branch.name.replace('ABC Auctions ', '')} /></div>
            </section>
          )}

          <section className="panel" id="collection" style={{ marginTop: 16 }}>
            <div className="panel-head"><h2><TruckIcon /> Collection</h2><span className="micro">{lot.branch.name}</span></div>
            <div className="panel-body stack">
              <p className="ink-2" style={{ maxWidth: '70ch' }}>
                {lot.isVehicle
                  ? `Vehicles are collected from ${lot.branch.name} once paid and once the police, ZIMRA and CVR transfer steps are complete. ABC does not deliver vehicles; the towing partners below serve this branch.`
                  : `Collect from ${lot.branch.name} with your QR gate pass, or choose delivery at checkout where available.`}
              </p>
              {lot.isVehicle && (lot.towingPartners.length === 0 ? (
                <p className="small muted">No towing partners are listed for this branch yet.</p>
              ) : (
                <div className="stack-8">
                  {lot.towingPartners.map((p) => (
                    <div key={p.name} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
                      <span className="row w500"><TruckIcon width={16} /> {p.name}</span>
                      <a className="link row mono small" href={`tel:${p.phone}`}><PhoneIcon width={14} /> {p.phone}</a>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
          {lot.rules && <p className="small muted" style={{ marginTop: 16 }}>Prices and terms on this page come from rule set {lot.rules.versionLabel}. <Link className="link" href="/rules">How fees work</Link></p>}
        </div>
        <BidPanel lot={lot} signedIn={Boolean(me)} />
      </div>
    </>
  );
}
