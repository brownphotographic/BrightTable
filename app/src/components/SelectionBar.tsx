import type { ReactNode } from 'react';
import { Heart, RejectIcon, Star } from './MetadataRows';

// Floating action bar shown above the grid whenever the selection is
// non-empty - ported from the design prototype's selection bar (§1.2/§6 in
// requirements.md), scoped to only the actions that are real today: Stack,
// Smart Stack, Favorite, and Move to Trash. Paste Settings and Add to Album
// are left out since Copy/Paste Settings and Albums don't exist in the real
// app yet.
export default function SelectionBar({
  count,
  onCancel,
  onStack,
  onSmartStack,
  onFavorite,
  allFavorited,
  onRate,
  unsyncedCount,
  onSyncMetadata,
  onDelete,
}: {
  count: number;
  onCancel: () => void;
  onStack: () => void;
  onSmartStack: () => void;
  onFavorite: () => void;
  allFavorited: boolean;
  onRate: (rating: number) => void;
  // How many of the current selection have a rating and/or description
  // sitting in a local sidecar/embedded file that Immich doesn't have yet -
  // see checkSidecarMetadata.
  unsyncedCount: number;
  onSyncMetadata: () => void;
  onDelete: () => void;
}) {
  const canStack = count >= 2;
  return (
    <div
      style={{
        height: 46,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 14px',
        background: '#26313f',
        borderBottom: '1px solid rgba(53,132,228,0.4)',
      }}
    >
      <div
        onClick={onCancel}
        title="Deselect"
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'default',
          position: 'relative',
          flexShrink: 0,
        }}
      >
        <div style={{ position: 'absolute', width: 12, height: 1.7, background: '#fff', transform: 'rotate(45deg)', borderRadius: 1 }} />
        <div style={{ position: 'absolute', width: 12, height: 1.7, background: '#fff', transform: 'rotate(-45deg)', borderRadius: 1 }} />
      </div>
      <span style={{ fontSize: 14, fontWeight: 700 }}>{count} selected</span>
      <div style={{ flex: 1 }} />
      <RatingGroup onRate={onRate} />
      {unsyncedCount > 0 && (
        <BarButton onClick={onSyncMetadata} title="Apply the rating/description found in each photo's local sidecar or embedded file">
          <SyncIcon />
          Sync {unsyncedCount} Item{unsyncedCount === 1 ? '' : 's'}
        </BarButton>
      )}
      <BarButton onClick={onFavorite} title={allFavorited ? 'Remove from favorites' : 'Add to favorites'}>
        <Heart filled={allFavorited} size={13} />
        Favorite
      </BarButton>
      <BarButton onClick={onStack} disabled={!canStack}>
        <StackIcon />
        Stack {count} Photos
      </BarButton>
      <BarButton onClick={onSmartStack} disabled={!canStack}>
        <StackIcon />
        Smart Stack
      </BarButton>
      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.12)' }} />
      <BarButton onClick={onDelete} color="#ff8080">
        Move to Trash
      </BarButton>
    </div>
  );
}

function BarButton({
  onClick,
  disabled,
  color,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  color?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 13px',
        border: 'none',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.08)',
        color: color ?? '#fff',
        fontSize: 12.5,
        cursor: 'default',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

// No "current value" to reflect here - the selection can have mixed ratings,
// so this is a plain set-rating input (all stars unfilled at rest) rather
// than a display of any one asset's rating, unlike MetadataRows' single-asset
// rating row.
function RatingGroup({ onRate }: { onRate: (rating: number) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.08)',
      }}
    >
      <button
        onClick={() => onRate(0)}
        title="Clear rating"
        style={{
          border: 'none',
          background: 'none',
          padding: 0,
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.55)',
          cursor: 'default',
        }}
      >
        0
      </button>
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />
      <div style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3, 4, 5].map((v) => (
          <button
            key={v}
            onClick={() => onRate(v)}
            title={`Rate ${v} star${v === 1 ? '' : 's'}`}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'default' }}
          >
            <Star filled={false} size={14} />
          </button>
        ))}
      </div>
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />
      <button
        onClick={() => onRate(-1)}
        title="Reject"
        style={{ border: 'none', background: 'none', padding: 0, cursor: 'default' }}
      >
        <RejectIcon active={false} size={14} />
      </button>
    </div>
  );
}

function SyncIcon() {
  return (
    <div style={{ position: 'relative', width: 12, height: 12, flexShrink: 0 }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          border: '1.6px solid currentColor',
          borderLeftColor: 'transparent',
          borderRadius: '50%',
          transform: 'rotate(45deg)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: -0.5,
          top: -1.5,
          width: 0,
          height: 0,
          borderLeft: '3px solid transparent',
          borderRight: '3px solid transparent',
          borderBottom: '3.5px solid currentColor',
          transform: 'rotate(140deg)',
        }}
      />
    </div>
  );
}

function StackIcon() {
  return (
    <div style={{ position: 'relative', width: 13, height: 12, flexShrink: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 9, height: 9, border: '1.6px solid currentColor', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: 4, top: 3, width: 9, height: 9, border: '1.6px solid currentColor', borderRadius: 2, background: '#26313f' }} />
    </div>
  );
}
