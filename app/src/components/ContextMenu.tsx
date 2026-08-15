import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

// The app's first right-click context menu - a dumb, reusable positioned
// popup. Callers own what items appear; this only handles placement,
// dismissal (outside click / Escape), and matching the existing dropdown
// look (see MenuBar.tsx's TopMenu/filter panels).
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        minWidth: 210,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 11,
        boxShadow: '0 12px 34px rgba(0,0,0,0.6)',
        padding: 6,
        zIndex: 120,
      }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onClick();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 31,
            padding: '0 11px',
            borderRadius: 7,
            fontSize: 13.5,
            cursor: 'default',
            color: item.disabled ? 'var(--text-dimmer)' : 'var(--text)',
            pointerEvents: item.disabled ? 'none' : 'auto',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#3584e4';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
