import { useEffect, useState } from 'react';
import type { TargetBounds } from './types';

interface OverlayData { target: TargetBounds; label: string }

export function Overlay() {
  const [data, setData] = useState<OverlayData | null>(null);
  useEffect(() => window.screenProf?.onOverlay((payload) => setData(payload)), []);
  if (!data) return null;
  const labelBelow = data.target.y < window.innerHeight - 130;
  return (
    <div className="screen-overlay" aria-hidden="true">
      <div
        className="target-ring"
        style={{ left: data.target.x - 8, top: data.target.y - 8, width: data.target.width + 16, height: data.target.height + 16 }}
      >
        <span className="corner corner-a" /><span className="corner corner-b" />
        <span className="corner corner-c" /><span className="corner corner-d" />
      </div>
      <div
        className={`overlay-label ${labelBelow ? 'below' : 'above'}`}
        style={{ left: Math.max(16, Math.min(window.innerWidth - 280, data.target.x + data.target.width / 2 - 120)), top: labelBelow ? data.target.y + data.target.height + 22 : data.target.y - 78 }}
      >
        <span className="overlay-step-dot">1</span>
        <span>{data.label}</span>
      </div>
    </div>
  );
}
