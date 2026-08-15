import type { ReactNode } from 'react';
import { Heart, RejectIcon, Star } from './MetadataRows';
import { TAG_ASSIGN_DISABLED_REASON } from '../lib/featureFlags';

// Floating action bar shown above the grid whenever the selection is
// non-empty - ported from the design prototype's selection bar (§1.2/§6 in
// requirements.md), scoped to only the actions that are real today: Stack,
// Smart Stack, Favorite, Add/Remove to/from Album, Paste Image Processing/
// Metadata, and Move to Trash.
// No Copy buttons here - Copy Image Processing/Metadata is inherently
// single-source, so it lives in the context menu/Viewer toolbar instead.
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
  canOpenInRawEditor,
  onOpenInRawEditor,
  onOpenInExternalEditor,
  canPasteImageProcessing,
  onPasteImageProcessing,
  canPasteMetadata,
  onPasteMetadata,
  rawSelectedCount,
  onBatchArtRoundTrip,
  rawEditorBusy,
  onAddToAlbum,
  onRemoveFromAlbum,
  onAddToTag,
  onRemoveFromTag,
}: {
  count: number;
  onCancel: () => void;
  // Stack/Smart Stack aren't a meaningful concept everywhere this bar is
  // reused (e.g. AlbumsBrowser's album-detail grid) - omit to hide both
  // buttons entirely rather than just disabling them.
  onStack?: () => void;
  onSmartStack?: () => void;
  onFavorite: () => void;
  allFavorited: boolean;
  onRate: (rating: number) => void;
  // How many of the current selection have a rating and/or description
  // sitting in a local sidecar/embedded file that Immich doesn't have yet -
  // see checkSidecarMetadata.
  unsyncedCount: number;
  onSyncMetadata: () => void;
  onDelete: () => void;
  // Whether the single selected asset (if any) is RAW - mirrors Viewer.tsx's
  // header, which likewise only shows the Tweak RAW Roundtrip button for RAW
  // assets.
  canOpenInRawEditor: boolean;
  onOpenInRawEditor: () => void;
  // Omit to hide "Open in Ext. Editor" entirely - same reasoning as
  // onStack/onSmartStack above.
  onOpenInExternalEditor?: () => void;
  // Something's been Copy Image Processing'd AND at least one selected asset
  // is RAW - a non-RAW member of the selection is just silently skipped as a
  // paste target, not a reason to disable the whole button. Omitting
  // onPasteImageProcessing/onPasteMetadata hides those buttons entirely.
  canPasteImageProcessing?: boolean;
  onPasteImageProcessing?: () => void;
  canPasteMetadata?: boolean;
  onPasteMetadata?: () => void;
  // How many of the current selection are RAW - "Headless RAW Roundtrip"
  // (only shown when rawRoundTripEnabled, gated by the caller) needs 1+ RAW
  // assets selected, whether that's a single photo or a batch.
  rawSelectedCount?: number;
  onBatchArtRoundTrip?: () => void;
  // True while ART itself is open for the selected asset (and briefly after,
  // while the export is resolved and handed off to the background) -
  // disables/relabels "Tweak RAW Roundtrip" so a second click can't overlap
  // a second launch for the *same* asset, same as Viewer.tsx's own artBusy.
  // Not held for the ART-cli conversion itself - see Viewer.tsx's artBusy
  // doc comment.
  rawEditorBusy?: boolean;
  // Opens AddToAlbumDialog for the current selection - shown in Photos/
  // Folders (add to any album) and AlbumsBrowser's album detail (add to a
  // *different* album than the one currently open).
  onAddToAlbum?: () => void;
  // Only ever provided by AlbumsBrowser's album detail view - removes the
  // selection from the album currently open (the assets themselves aren't
  // touched, unlike onDelete's Move to Trash).
  onRemoveFromAlbum?: () => void;
  // Opens AddToTagDialog for the current selection - same shape as
  // onAddToAlbum, offered everywhere that is (Photos/Folders/AlbumsBrowser/
  // PeopleBrowser/TagsBrowser).
  onAddToTag?: () => void;
  // Only ever provided by TagsBrowser's tag detail view - removes the
  // selection from the tag currently open, same reasoning as
  // onRemoveFromAlbum.
  onRemoveFromTag?: () => void;
}) {
  const canStack = count >= 2;
  // Both editors are a single-file launch (see Viewer.tsx's handleLaunch) -
  // there's no meaningful "open N files in the RAW editor" batch action, so
  // both are scoped to exactly one selected asset rather than the whole
  // selection like the other bar actions.
  const singleSelected = count === 1;
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
      <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{count} selected</span>
      <div style={{ flex: 1 }} />
      <RatingGroup onRate={onRate} />
      {unsyncedCount > 0 && (
        <BarButton onClick={onSyncMetadata} title="Apply the rating/description found in each photo's local sidecar or embedded file">
          <SyncIcon />
          Sync {unsyncedCount} Item{unsyncedCount === 1 ? '' : 's'}
        </BarButton>
      )}
      <BarButton onClick={onFavorite} title={allFavorited ? 'Remove from favorites' : 'Add to favorites'}>
        <Heart filled={allFavorited} size={13} dimColor="rgba(255,255,255,0.3)" />
        Favorite
      </BarButton>
      {onAddToAlbum && (
        <BarButton onClick={onAddToAlbum} title="Add this selection to an album">
          <AlbumIcon />
          Add to Album
        </BarButton>
      )}
      {onAddToTag && (
        <BarButton
          onClick={onAddToTag}
          disabled={!!TAG_ASSIGN_DISABLED_REASON}
          title={TAG_ASSIGN_DISABLED_REASON ?? 'Add this selection to a tag'}
        >
          <TagIcon />
          Add to Tag
        </BarButton>
      )}
      {onStack && (
        <BarButton onClick={onStack} disabled={!canStack}>
          <StackIcon />
          Stack {count} Photos
        </BarButton>
      )}
      {onSmartStack && (
        <BarButton onClick={onSmartStack} disabled={!canStack}>
          <StackIcon />
          Smart Stack
        </BarButton>
      )}
      {singleSelected && canOpenInRawEditor && (
        <BarButton onClick={onOpenInRawEditor} disabled={rawEditorBusy} title={rawEditorBusy ? 'Waiting on ART…' : undefined}>
          {rawEditorBusy ? 'Working…' : 'Tweak RAW Roundtrip'}
        </BarButton>
      )}
      {onBatchArtRoundTrip && (
        <BarButton
          onClick={onBatchArtRoundTrip}
          disabled={(rawSelectedCount ?? 0) < 1}
          title={(rawSelectedCount ?? 0) < 1 ? 'Select a RAW photo to roundtrip' : undefined}
        >
          Headless RAW Roundtrip
        </BarButton>
      )}
      {onOpenInExternalEditor && (
        <BarButton onClick={onOpenInExternalEditor} disabled={!singleSelected} title={singleSelected ? undefined : 'Select a single photo to open it in an editor'}>
          Open in Ext. Editor
        </BarButton>
      )}
      {(onPasteImageProcessing || onPasteMetadata) && (
        <>
          <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.12)' }} />
          {onPasteImageProcessing && (
            <BarButton onClick={onPasteImageProcessing} disabled={!canPasteImageProcessing} title="Paste image processing onto the RAW photos in this selection">
              Paste Image Processing
            </BarButton>
          )}
          {onPasteMetadata && (
            <BarButton onClick={onPasteMetadata} disabled={!canPasteMetadata} title="Paste rating/favorite/description onto this selection">
              Paste Metadata
            </BarButton>
          )}
        </>
      )}
      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.12)' }} />
      {onRemoveFromAlbum && (
        <BarButton onClick={onRemoveFromAlbum} color="#ff8080">
          Remove from Album
        </BarButton>
      )}
      {onRemoveFromTag && (
        <BarButton onClick={onRemoveFromTag} color="#ff8080">
          Remove from Tag
        </BarButton>
      )}
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
            <Star filled={false} size={14} dimColor="rgba(255,255,255,0.3)" />
          </button>
        ))}
      </div>
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />
      <button
        onClick={() => onRate(-1)}
        title="Reject"
        style={{ border: 'none', background: 'none', padding: 0, cursor: 'default' }}
      >
        <RejectIcon active={false} size={14} dimColor="rgba(255,255,255,0.3)" />
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

function AlbumIcon() {
  return (
    <div style={{ position: 'relative', width: 13, height: 12, flexShrink: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 13, height: 12, border: '1.6px solid currentColor', borderRadius: 3 }} />
      <div style={{ position: 'absolute', left: 3, top: 5.2, width: 7, height: 1.6, background: 'currentColor', borderRadius: 1 }} />
      <div style={{ position: 'absolute', left: 5.7, top: 2.5, width: 1.6, height: 7, background: 'currentColor', borderRadius: 1 }} />
    </div>
  );
}

function TagIcon() {
  return (
    <div style={{ position: 'relative', width: 13, height: 12, flexShrink: 0 }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 1,
          width: 10,
          height: 10,
          border: '1.6px solid currentColor',
          borderRadius: '2px 5px 5px 2px',
          transform: 'rotate(-45deg)',
          transformOrigin: 'left center',
        }}
      />
      <div style={{ position: 'absolute', left: 1.5, top: 3, width: 2.2, height: 2.2, borderRadius: '50%', background: 'currentColor' }} />
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
