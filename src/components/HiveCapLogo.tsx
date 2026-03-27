type Size = 'sm' | 'md' | 'lg';
type Variant = 'light' | 'dark';

interface HiveCapLogoProps {
  size?: Size;
  variant?: Variant;
  markOnly?: boolean;
}

const sizeDims = {
  sm: { beeH: 28, fontSize: '1rem',    gap: '8px'  },
  md: { beeH: 40, fontSize: '1.4rem',  gap: '10px' },
  lg: { beeH: 60, fontSize: '2.1rem',  gap: '14px' },
};

export function HiveCapLogo({
  size = 'md',
  variant = 'dark',
  markOnly = false,
}: HiveCapLogoProps) {
  const dims = sizeDims[size];
  const beeW = Math.round((dims.beeH / 66) * 50);
  // clipPath IDs are unique per size so multiple sizes on same page don't collide
  const clipId = `hc-body-${size}`;

  // "HIVE" text inherits currentColor by default; variant provides an explicit
  // override when the logo is rendered on a surface with known fixed color.
  const hiveColor =
    variant === 'light' ? '#F5F2EC' : variant === 'dark' ? '#FFFFFF' : 'inherit';
  const capColor =
    variant === 'dark' ? '#F5C800' : '#E8A800';
  const beeStroke = variant === 'dark' ? { stroke: '#FFFFFF', strokeWidth: 1.5 } : {};

  const beeSvg = (
    <svg
      width={beeW}
      height={dims.beeH}
      viewBox="0 0 50 66"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* ── Wings (rendered behind body) ── */}
      <ellipse
        cx="6" cy="36" rx="10" ry="5"
        fill="#E8A800" fillOpacity="0.28"
        transform="rotate(-25 6 36)"
      />
      <ellipse
        cx="44" cy="36" rx="10" ry="5"
        fill="#E8A800" fillOpacity="0.28"
        transform="rotate(25 44 36)"
      />

      {/* ── Body ── */}
      <ellipse cx="25" cy="48" rx="14" ry="17" fill="#E8A800" {...beeStroke} />

      {/* ── Black stripes clipped to body ── */}
      <defs>
        <clipPath id={clipId}>
          <ellipse cx="25" cy="48" rx="14" ry="17" />
        </clipPath>
      </defs>
      <rect x="11" y="40"   width="28" height="3.5" fill="#100F0A" fillOpacity="0.62" clipPath={`url(#${clipId})`} />
      <rect x="11" y="46.5" width="28" height="3.5" fill="#100F0A" fillOpacity="0.62" clipPath={`url(#${clipId})`} />
      <rect x="11" y="53"   width="28" height="3.5" fill="#100F0A" fillOpacity="0.62" clipPath={`url(#${clipId})`} />

      {/* ── Head ── */}
      <circle cx="25" cy="25" r="12" fill="#F0B800" {...beeStroke} />

      {/* ── Crown (3-pointed, white) ── */}
      <path d="M17,18 L18.5,9 L22,14 L25,6 L28,14 L31.5,9 L33,18 Z" fill="white" />
      {/* Crown jewels */}
      <circle cx="18.5" cy="9"  r="1.8" fill="#F5C800" />
      <circle cx="25"   cy="6"  r="1.8" fill="#F5C800" />
      <circle cx="31.5" cy="9"  r="1.8" fill="#F5C800" />

      {/* ── Wayfarer sunglasses ── */}
      {/* Left lens — trapezoidal (wider at top) */}
      <path d="M14,20 L22.5,20 L21.5,26 L15,26 Z" fill="#111111" />
      {/* Right lens */}
      <path d="M27.5,20 L36,20 L35,26 L28.5,26 Z" fill="#111111" />
      {/* Arched bridge */}
      <path
        d="M22.5,23 Q25,21 27.5,23"
        fill="none"
        stroke="#111111"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Glare marks */}
      <line x1="15.5" y1="21.5" x2="18"   y2="21.5" stroke="white" strokeWidth="1" strokeOpacity="0.75" strokeLinecap="round" />
      <line x1="29"   y1="21.5" x2="31.5" y2="21.5" stroke="white" strokeWidth="1" strokeOpacity="0.75" strokeLinecap="round" />
    </svg>
  );

  if (markOnly) return beeSvg;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dims.gap,
      }}
    >
      {beeSvg}
      <span
        style={{
          fontFamily: 'var(--font-space-grotesk), sans-serif',
          fontWeight: 700,
          fontSize: dims.fontSize,
          letterSpacing: '-0.01em',
          lineHeight: 1,
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: hiveColor }}>HIVE</span>
        <span style={{ color: capColor }}>CAP</span>
      </span>
    </div>
  );
}
