'use client';

import { useRef, useState } from 'react';

/**
 * Small single-series charts for the analytics screen, built to the dataviz rules:
 * thin bars (20px) with 4px rounded data ends on a hairline grid, one series colour
 * (validated against the surface), text in text tokens, and a hover tooltip per mark.
 * Every chart sits beside a table view of the same numbers.
 */
interface Tip { x: number; y: number; title: string; lines: Array<[string, string]> }

function useTip() {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: React.MouseEvent | React.FocusEvent, title: string, lines: Array<[string, string]>) => {
    const host = box.current?.getBoundingClientRect();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!host) return;
    const x = 'clientX' in e ? (e as React.MouseEvent).clientX - host.left : r.left + r.width / 2 - host.left;
    setTip({ x: Math.max(80, Math.min(host.width - 80, x)), y: r.top - host.top, title, lines });
  };
  const node = tip ? (
    <div className="tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
      <b>{tip.title}</b>
      {tip.lines.map(([k, v]) => <div key={k}><span className="k">{k}</span> {v}</div>)}
    </div>
  ) : null;
  return { box, show, hide: () => setTip(null), node };
}

export interface BarRow { label: string; value: number; display: string; tip: Array<[string, string]> }

export function BarChart({ rows, max, ticks }: { rows: BarRow[]; max: number; ticks: string[] }) {
  const { box, show, hide, node } = useTip();
  return (
    <div ref={box} className="hbars" onMouseLeave={hide}>
      {rows.map((r) => (
        <div key={r.label} className="hbar" tabIndex={0} onMouseMove={(e) => show(e, r.label, r.tip)} onFocus={(e) => show(e, r.label, r.tip)} onBlur={hide}>
          <span className="lbl" title={r.label}>{r.label}</span>
          <span className="track"><span className="fill" style={{ width: `${max ? Math.min(100, (r.value / max) * 100) : 0}%` }} /></span>
          <span className="val">{r.display}</span>
        </div>
      ))}
      <div className="axis"><span /><span className="ticks">{ticks.map((t) => <span key={t}>{t}</span>)}</span><span /></div>
      {node}
    </div>
  );
}

export interface RangeRow { label: string; min: number; median: number; max: number; display: string; tip: Array<[string, string]> }

/** Low–high range with the median as a dot: the spread of realised prices in one row. */
export function RangeChart({ rows, max, ticks }: { rows: RangeRow[]; max: number; ticks: string[] }) {
  const { box, show, hide, node } = useTip();
  const at = (v: number) => `${max ? Math.min(100, (v / max) * 100) : 0}%`;
  return (
    <div ref={box} className="hbars" onMouseLeave={hide}>
      {rows.map((r) => (
        <div key={r.label} className="hbar" tabIndex={0} onMouseMove={(e) => show(e, r.label, r.tip)} onFocus={(e) => show(e, r.label, r.tip)} onBlur={hide}>
          <span className="lbl" title={r.label}>{r.label}</span>
          <span className="track" style={{ background: 'repeating-linear-gradient(90deg, var(--line-soft) 0 1px, transparent 1px 25%)' }}>
            <span className="rng" style={{ left: at(r.min), width: `calc(${at(r.max)} - ${at(r.min)})`, minWidth: 2 }} />
            <span className="dot" style={{ left: at(r.median) }} />
          </span>
          <span className="val">{r.display}</span>
        </div>
      ))}
      <div className="axis"><span /><span className="ticks">{ticks.map((t) => <span key={t}>{t}</span>)}</span><span /></div>
      {node}
    </div>
  );
}
