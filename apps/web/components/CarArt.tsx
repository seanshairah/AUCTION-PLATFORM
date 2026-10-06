/**
 * Placeholder vehicle art until lot photos are served from object storage.
 * A side profile per body style, tinted with the vehicle's colour.
 */
const COLOURS: Record<string, string> = {
  white: '#f2f3f7', silver: '#c5cad6', grey: '#8d93a5', black: '#2b2f3e', 'obsidian black': '#23252f', blue: '#3c63d8',
  red: '#d6453d', beige: '#d9c7a3', green: '#3f8f5b',
};

const BODIES: Record<string, string> = {
  // load bed at the rear (left), cab and bonnet at the front (right)
  pickup: 'M14 66 L16 46 Q17 43 21 43 L108 43 L112 26 Q114 22 119 22 L156 22 Q162 22 166 28 L176 43 L204 45 Q212 46 212 54 L212 66 Z',
  suv: 'M16 66 L18 48 Q20 42 28 41 L50 39 L72 20 Q76 17 82 17 L168 17 Q176 17 180 23 L194 40 L204 42 Q212 44 212 52 L212 66 Z',
  sedan: 'M14 66 L16 54 Q18 48 26 47 L60 44 L86 27 Q91 24 98 24 L144 24 Q152 24 157 29 L176 44 L202 47 Q212 48 212 56 L212 66 Z',
  hatchback: 'M18 66 L20 52 Q22 46 30 45 L62 42 L86 24 Q90 21 96 21 L160 21 Q168 21 172 28 L184 46 Q186 48 190 49 L200 51 Q206 53 206 60 L206 66 Z',
};

function windows(body: string): string {
  switch (body) {
    case 'pickup':
      return 'M118 40 L121 28 Q122 26 125 26 L140 26 L140 40 Z M144 26 L156 26 Q160 26 162 30 L169 40 L144 40 Z';
    case 'suv':
      return 'M60 39 L78 23 Q80 21 84 21 L118 21 L118 39 Z M122 21 L164 21 Q170 21 173 26 L184 39 L122 39 Z';
    case 'sedan':
      return 'M72 43 L90 30 Q93 28 98 28 L118 28 L118 43 Z M122 28 L142 28 Q148 28 152 32 L164 43 L122 43 Z';
    default:
      return 'M72 42 L90 27 Q92 25 96 25 L124 25 L124 42 Z M128 25 L158 25 Q164 25 167 30 L176 42 L128 42 Z';
  }
}

export function CarArt({ body, colour, size = 'card' }: { body: string | null; colour: string | null; size?: 'card' | 'hero' }) {
  const b = body && BODIES[body] ? body : 'sedan';
  const fill = COLOURS[(colour ?? '').toLowerCase()] ?? '#9aa3c7';
  const dark = ['black', 'obsidian black', 'grey', 'blue', 'red', 'green'].includes((colour ?? '').toLowerCase());
  const width = size === 'hero' ? '70%' : '78%';
  return (
    <svg viewBox="0 0 228 86" width={width} role="img" aria-label={`${colour ?? ''} ${b} illustration`}>
      <ellipse cx="114" cy="76" rx="100" ry="5" fill="#161a35" opacity="0.08" />
      <path d={BODIES[b]} fill={fill} stroke={dark ? 'none' : '#c9cee0'} strokeWidth="1.2" />
      <path d={windows(b)} fill={dark ? '#cfd6ee' : '#3a4266'} opacity={dark ? 0.75 : 0.85} />
      <rect x="196" y="50" width="12" height="4" rx="2" fill="#ffd36b" />
      <rect x="18" y="52" width="8" height="4" rx="2" fill="#ff7a7a" />
      {[58, 170].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="66" r="13" fill="#20243a" />
          <circle cx={cx} cy="66" r="6" fill="#c9cee0" />
        </g>
      ))}
    </svg>
  );
}
