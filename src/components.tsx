import type { ReactNode } from 'react';
import { ChevronsDown, X } from 'lucide-react';

export function BrandMark({ small = false }: { small?: boolean }) {
  return <img className={small ? 'brand-mark small' : 'brand-mark'} src="./screenprof-icon.png" alt="" aria-hidden="true" />;
}

export function WindowBar({ onCollapse }: { onCollapse: () => void }) {
  return (
    <header className="window-bar">
      <div className="window-brand"><BrandMark small /><span>ScreenProf</span><em>Beta</em></div>
      <div className="window-actions">
        <button onClick={onCollapse} aria-label="Minimize to floating logo"><ChevronsDown size={14} /></button>
        <button onClick={() => window.screenProf?.hide()} aria-label="Close"><X size={15} /></button>
      </div>
    </header>
  );
}

export function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <button type="button" className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked} aria-label={label}><span /></button>;
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{action}</div>;
}
