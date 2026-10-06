import { siFord, siHonda, siMastercard, siNissan, siToyota, siVisa, siVolkswagen, siWhatsapp } from 'simple-icons';

/**
 * Real marks where a published one exists (Simple Icons); a plain wordmark otherwise.
 * EcoCash, OneMoney, InnBucks and ZimSwitch marks come from the partners at contract
 * time, so until then they are set as text, never redrawn.
 */
type Icon = { path: string; hex: string; title: string };

const MAKES: Record<string, Icon> = { Toyota: siToyota, Honda: siHonda, Ford: siFord, Nissan: siNissan, Volkswagen: siVolkswagen };

function Svg({ icon, size = 16, colour }: { icon: Icon; size?: number; colour?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={icon.title} fill={colour ?? `#${icon.hex}`}>
      <path d={icon.path} />
    </svg>
  );
}

export function MakeMark({ make, size = 16 }: { make: string; size?: number }) {
  const icon = MAKES[make];
  if (!icon) return <span className="micro" style={{ color: 'var(--ink-2)' }}>{make}</span>;
  return <Svg icon={icon} size={size} colour="currentColor" />;
}

export function WhatsAppMark({ size = 16 }: { size?: number }) {
  return <Svg icon={siWhatsapp} size={size} />;
}

export function PayMarks({ night = false }: { night?: boolean }) {
  return (
    <div className={`paymarks${night ? ' on-night-marks' : ''}`} aria-label="Ways to pay">
      {['EcoCash', 'OneMoney', 'InnBucks', 'ZimSwitch'].map((m) => <span key={m} className="paymark">{m}</span>)}
      <span className="paymark"><Svg icon={siVisa} size={30} colour={night ? '#f4f1ea' : '#1A1F71'} /></span>
      <span className="paymark"><Svg icon={siMastercard} size={22} /></span>
      <span className="paymark">Cash at branch</span>
    </div>
  );
}
