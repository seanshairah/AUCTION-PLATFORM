import { AlertTriangle, Calendar, Camera, Check, ChevronRight, FileCheck2, Fuel, Gauge, MapPin, Minus, Phone, Settings2, Truck, Video, X } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BidPanel } from '@/components/BidPanel';
import { CarArt } from '@/components/CarArt';
import { Topbar } from '@/components/Topbar';
import { apiOrNull } from '@/lib/api';
import { BODY_LABEL, km, shortDateTime, titleCase } from '@/lib/format';
import type { InspectionItem, LotDetail, Me } from '@/lib/types';

type Props = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const lot = await apiOrNull<LotDetail>(`/lots/${encodeURIComponent((await params).ref)}`);
  return lot ? { title: lot.title, description: `${lot.title}. ${lot.inspectionSummary ?? lot.description}`.slice(0, 160) } : { title: 'Lot not found' };
}

const SECTION_LABEL: Record<string, string> = {
  identity: 'Identity', documents: 'Documents', exterior: 'Exterior', interior: 'Interior', mechanical: 'Mechanical', structure: 'Structure', road_test: 'Road test',
};

function Answer({ item }: { item: InspectionItem }) {
  const map = { ok: ['ok', <Check key="i" size={12} />], attention: ['attention', <AlertTriangle key="i" size={11} />], fail: ['fail', <X key="i" size={12} />], not_applicable: ['na', <Minus key="i" size={12} />], missing: ['na', <Minus key="i" size={12} />] } as const;
  const [cls, icon] = map[item.answer];
  return <span className={`dot ${cls}`} aria-label={item.answer.replace('_', ' ')}>{icon}</span>;
}

export default async function LotPage({ params }: Props) {
  const ref = decodeURIComponent((await params).ref);
  const [lot, me] = await Promise.all([apiOrNull<LotDetail>(`/lots/${encodeURIComponent(ref)}`), apiOrNull<Me>('/me')]);
  if (!lot) notFound();
  const v = lot.vehicle;
  const photos = lot.media.filter((m) => m.kind === 'photo');
  const flagged = lot.inspection?.sections.flatMap((s) => s.items).filter((i) => i.answer === 'attention' || i.answer === 'fail') ?? [];

  return (
    <>
      <Topbar title={lot.title} sub={`Lot ${lot.ref} · ${lot.auction.title}`} me={me} />
      <div className="content">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/auctions">Auctions</Link><ChevronRight size={14} />
          <Link href={`/auctions?category=${lot.isVehicle ? 'vehicles' : 'other'}`}>{lot.category.name}</Link><ChevronRight size={14} />
          <span>{lot.ref}</span>
        </nav>
        <div className="lot-page">
          <div className="stack" style={{ gap: 20 }}>
            <section className="card gallery" aria-label="Photos">
              <div className="hero">
                <CarArt body={v?.bodyStyle ?? null} colour={v?.colour ?? null} size="hero" />
                <span className="photos" style={{ position: 'absolute', right: 14, bottom: 12, background: '#fff', padding: '4px 10px', borderRadius: 8, fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Camera size={14} /> {photos.length} photos{lot.media.some((m) => m.kind === 'video') && <> · <Video size={14} /> video</>}
                </span>
              </div>
              <div className="thumbs">
                {photos.slice(0, 6).map((p, i) => <div key={i} className="thumb">{p.role.replaceAll('_', ' ')}</div>)}
              </div>
            </section>

            {v && (
              <section className="card section">
                <h2>Vehicle</h2>
                <div className="spec-grid">
                  <div className="spec"><div className="k"><Calendar size={12} /> Year</div><div className="v">{v.year ?? '—'}</div></div>
                  <div className="spec"><div className="k"><Gauge size={12} /> Odometer</div><div className="v">{km(v.odometerKm)}</div></div>
                  <div className="spec"><div className="k"><Settings2 size={12} /> Transmission</div><div className="v">{titleCase(v.transmission)}</div></div>
                  <div className="spec"><div className="k"><Fuel size={12} /> Fuel</div><div className="v">{titleCase(v.fuel)}</div></div>
                  <div className="spec"><div className="k">Body</div><div className="v">{v.bodyStyle ? BODY_LABEL[v.bodyStyle] : '—'}</div></div>
                  <div className="spec"><div className="k">Drive</div><div className="v">{v.drive?.toUpperCase() ?? '—'}</div></div>
                  <div className="spec"><div className="k">Colour</div><div className="v">{v.colour ?? '—'}</div></div>
                  <div className="spec"><div className="k"><FileCheck2 size={12} /> Registration</div><div className="v">{v.zimbabweRegistered ? 'Zimbabwe' : 'Import'}</div></div>
                </div>
              </section>
            )}

            {lot.inspection && (
              <section className="card section">
                <div className="row between" style={{ marginBottom: 12 }}>
                  <h2 style={{ margin: 0 }}>Inspection report</h2>
                  <span className="pill good">{lot.inspection.identityVerified ? 'Chassis and engine numbers verified' : 'Identity check pending'}</span>
                </div>
                <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{lot.inspection.summary.split('\n')[0]}</p>
                <p className="small muted" style={{ margin: '0 0 8px' }}>
                  Checklist {lot.inspection.checklistVersion} · inspected {shortDateTime(lot.inspection.inspectedAt)} · {lot.inspection.photoCount} photos{lot.inspection.hasVideo ? ' and video' : ''}.
                  A published report never changes; if a material item proves wrong, you are covered by the gross-inaccuracy remedy.
                </p>
                {flagged.length > 0 && (
                  <div className="stack" style={{ gap: 6, margin: '10px 0' }}>
                    {flagged.map((i) => (
                      <div key={i.id} className={`notice ${i.answer === 'fail' ? 'bad' : ''}`}><strong>{i.label}:</strong> {i.note}</div>
                    ))}
                  </div>
                )}
                <div className="checklist">
                  {lot.inspection.sections.map((s) => (
                    <div key={s.section} style={{ display: 'contents' }}>
                      <div className="sect-label">{SECTION_LABEL[s.section] ?? s.section}</div>
                      {s.items.map((i) => (
                        <div key={i.id} className="check-item">
                          <Answer item={i} />
                          <span>{i.label}{i.material && <span className="muted small"> · key item</span>}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="card section">
              <h2>Description</h2>
              <p style={{ margin: 0, color: 'var(--ink-2)' }}>{lot.description}</p>
              <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                <span className="pill muted">{lot.itemState.label}</span>
                <span className="pill muted">{lot.condition.label}</span>
                <span className="pill muted"><MapPin size={12} /> {lot.branch.name}</span>
              </div>
            </section>

            <section className="card section">
              <h2>Bid history</h2>
              {lot.history.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>No bids yet. The starting bid is {lot.startingBid.text}.</p>
              ) : (
                <div className="history">
                  {lot.history.map((h) => (
                    <div key={h.seq} className="h">
                      <span><strong>{h.bidder}</strong>{h.auto && <span className="muted small"> · automatic</span>}</span>
                      <span className="muted small">{shortDateTime(h.at)}</span>
                      <strong>{h.amount.text}</strong>
                    </div>
                  ))}
                </div>
              )}
              <p className="small muted" style={{ margin: '10px 0 0' }}>Bidders are numbered in order of their first bid. Nobody sees anyone else&apos;s maximum.</p>
            </section>

            {lot.isVehicle && (
              <section className="card section">
                <h2>Collection and towing</h2>
                <p style={{ margin: '0 0 8px', color: 'var(--ink-2)' }}>Vehicles are collected from {lot.branch.name}. ABC does not deliver vehicles; these towing partners serve this branch.</p>
                {lot.towingPartners.length === 0 ? (
                  <p className="small muted" style={{ margin: 0 }}>No towing partners are listed for this branch yet.</p>
                ) : lot.towingPartners.map((p) => (
                  <div key={p.name} className="row" style={{ padding: '6px 0' }}><Truck size={16} /> <strong>{p.name}</strong> <a href={`tel:${p.phone}`} className="row muted"><Phone size={14} /> {p.phone}</a></div>
                ))}
              </section>
            )}
            {lot.rules && <p className="small muted" style={{ margin: 0 }}>Prices and terms on this page come from rule set {lot.rules.versionLabel}. See <Link href="/rules" style={{ color: 'var(--accent)' }}>fees and rules</Link>.</p>}
          </div>
          <BidPanel lot={lot} signedIn={Boolean(me)} />
        </div>
      </div>
    </>
  );
}
