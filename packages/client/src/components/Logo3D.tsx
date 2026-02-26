import './Logo3D.css';

interface Logo3DProps {
  scale?: number;
  glow?: number;
}

// JoJo Steel Ball Run — saturated, dramatic palette
const SBR_COLORS = [
  { base: '#ff2d7b', glow: '#ff2d7b' }, // neon magenta
  { base: '#e6194b', glow: '#ff3366' }, // crimson
  { base: '#ff6f00', glow: '#ff8800' }, // deep orange
  { base: '#ffd600', glow: '#ffea00' }, // vivid gold
  { base: '#00e5a0', glow: '#00ffbb' }, // electric emerald
  { base: '#00bcd4', glow: '#00e5ff' }, // cyan
  { base: '#7b1fa2', glow: '#ba68c8' }, // royal purple
];

function Cube({ base, glow }: { base: string; glow: string }) {
  return (
    <div
      className="logo3d-cube"
      style={{ '--block-color': base, '--block-glow': glow } as React.CSSProperties}
    >
      <div className="logo3d-face logo3d-front" />
      <div className="logo3d-face logo3d-back" />
      <div className="logo3d-face logo3d-right" />
      <div className="logo3d-face logo3d-left" />
      <div className="logo3d-face logo3d-top" />
      <div className="logo3d-face logo3d-bottom" />
    </div>
  );
}

export function Logo3D({ scale = 1, glow = 1 }: Logo3DProps) {
  return (
    <div
      className="logo3d-wrapper"
      style={{ '--logo-scale': scale, '--logo-glow': glow } as React.CSSProperties}
    >
      <div className="logo3d-container">
        {SBR_COLORS.map((c, i) => (
          <div key={c.base} className={`logo3d-block logo3d-b${i + 1}`}>
            <Cube base={c.base} glow={c.glow} />
          </div>
        ))}
      </div>
    </div>
  );
}
