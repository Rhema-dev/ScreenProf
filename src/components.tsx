import type { ReactNode } from 'react';
import { ChevronsDown, X } from 'lucide-react';

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? 'brand-mark small' : 'brand-mark'} viewBox="0 0 48 48" aria-hidden="true">
      <path d="M8 5.5h32a5 5 0 0 1 5 5v23a5 5 0 0 1-5 5H25.8L16 45l1.9-6.5H8a5 5 0 0 1-5-5v-23a5 5 0 0 1 5-5Z" fill="currentColor" />
      <path d="m11.5 20.1 12.7-6.8 12.7 6.8-12.7 6.8-12.7-6.8Z" fill="#fff" />
      <path d="M16.7 23.1v5.1c0 2.2 3.4 4 7.5 4s7.5-1.8 7.5-4v-5.1l-7.5 4-7.5-4Z" fill="#fff" opacity=".92" />
      <path d="M36.9 20.2v7.2" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
      <circle cx="36.9" cy="29.4" r="2" fill="#fff" />
    </svg>
  );
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
