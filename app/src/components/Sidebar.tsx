import { useLibraryStatus } from '../lib/libraryStatus';

export type LeftTab = 'photos' | 'albums' | 'people' | 'folders' | 'trash';

const navDefs: { id: LeftTab; label: string; color: string }[] = [
  { id: 'photos', label: 'Photos', color: '#62a0ea' },
  { id: 'albums', label: 'Albums', color: '#2ec27e' },
  { id: 'people', label: 'People', color: '#e5a50a' },
  { id: 'folders', label: 'Folders', color: '#9aa0a6' },
];

export default function Sidebar({
  active,
  onSelect,
  photosCount,
  trashCount,
}: {
  active: LeftTab;
  onSelect: (tab: LeftTab) => void;
  photosCount: number;
  trashCount: number;
}) {
  const { status, checking, error } = useLibraryStatus();

  const counts: Record<LeftTab, string> = {
    photos: photosCount ? String(photosCount) : '',
    albums: '',
    people: '',
    folders: photosCount ? String(photosCount) : '',
    trash: trashCount ? String(trashCount) : '',
  };

  const versionWarning = !!status && !status.serverVersionSupported;
  const dotColor = checking
    ? 'rgba(255,255,255,0.3)'
    : status
      ? versionWarning
        ? 'var(--warn)'
        : '#2ec27e'
      : error
        ? '#e01b24'
        : 'rgba(255,255,255,0.3)';
  const statusText = checking
    ? 'Connecting…'
    : status
      ? `Connected · ${status.via}${versionWarning ? ' · old server version' : ''}`
      : 'Not connected';

  return (
    <div
      style={{
        width: 212,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: '#303030',
        borderRight: '1px solid rgba(0,0,0,0.4)',
        padding: '10px 9px',
      }}
    >
      {navDefs.map((n) => {
        const isActive = active === n.id;
        return (
          <div
            key={n.id}
            onClick={() => onSelect(n.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              height: 36,
              padding: '0 11px',
              borderRadius: 9,
              cursor: 'default',
              marginBottom: 1,
              color: isActive ? '#fff' : 'rgba(255,255,255,0.85)',
              background: isActive ? 'rgba(53,132,228,0.28)' : 'transparent',
            }}
          >
            <div
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                flexShrink: 0,
                background: isActive ? '#7fb0f0' : n.color,
              }}
            />
            <span style={{ flex: 1, fontSize: 13.5 }}>{n.label}</span>
            <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>
              {counts[n.id]}
            </span>
          </div>
        );
      })}

      <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '7px 4px' }} />
      {(() => {
        const isActive = active === 'trash';
        return (
          <div
            onClick={() => onSelect('trash')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              height: 36,
              padding: '0 11px',
              borderRadius: 9,
              cursor: 'default',
              marginBottom: 1,
              color: isActive ? '#fff' : 'rgba(255,255,255,0.85)',
              background: isActive ? 'rgba(224,27,36,0.28)' : 'transparent',
            }}
          >
            <div
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                flexShrink: 0,
                background: isActive ? '#f47a80' : '#e01b24',
              }}
            />
            <span style={{ flex: 1, fontSize: 13.5 }}>Trash</span>
            <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>
              {counts.trash}
            </span>
          </div>
        );
      })()}

      <div style={{ flex: 1 }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11.5,
          color: 'rgba(255,255,255,0.5)',
          padding: '6px 6px 2px',
        }}
      >
        <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: dotColor }} />
        {statusText}
      </div>
    </div>
  );
}
