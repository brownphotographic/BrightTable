import { useState, type CSSProperties, type ReactNode } from 'react';
import { prettyShortcut, useShortcuts } from '../lib/shortcuts';
import { activeFilterCount, DEFAULT_FILTERS, type FileTypeFilter, type Filters, type MediaTypeFilter } from '../lib/filters';
import { Star } from './MetadataRows';
import Switch from './Switch';

type MenuKey = 'file' | 'edit' | 'view' | 'help' | 'filter' | null;

export default function MenuBar({
  onOpenPreferences,
  onRefreshTimeline,
  onOpenImport,
  onQuit,
  onOpenActivity,
  metaOpen,
  onToggleMetadata,
  onSelectAll,
  onDeselectAll,
  onStackSelected,
  onSmartStack,
  // onToggleRawOverride - unused while "Toggle Canon RAW" is disabled, see below
  onSyncSidecarRatings,
  onCopyImageProcessing,
  onPasteImageProcessing,
  onCopyMetadata,
  onPasteMetadata,
  onPrint,
  onRotateLeft,
  onRotateRight,
  onExportToFolder,
  onShareToFlickr,
  onOpenAbout,
  filters,
  onFiltersChange,
  searchQuery,
  onSearchQueryChange,
  onSearchSubmit,
  onClearSearch,
  thumbSize,
  onThumbSizeChange,
  showThumbSize,
}: {
  onOpenPreferences: () => void;
  onRefreshTimeline: () => void;
  onOpenImport: () => void;
  onQuit: () => void;
  onOpenActivity: () => void;
  metaOpen: boolean;
  onToggleMetadata: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onStackSelected: () => void;
  onSmartStack: () => void;
  onToggleRawOverride: () => void;
  onSyncSidecarRatings: () => void;
  onCopyImageProcessing: () => void;
  onPasteImageProcessing: () => void;
  onCopyMetadata: () => void;
  onPasteMetadata: () => void;
  onPrint: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onExportToFolder: () => void;
  onShareToFlickr: () => void;
  onOpenAbout: () => void;
  filters: Filters;
  onFiltersChange: (next: Filters) => void;
  // Live text currently typed in the search box - controlled by the parent
  // so a sidebar tab switch (or anything else) can clear it from outside.
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  // Fires on Enter - kicks off the actual `searchAssets` call and switches
  // the content area to search results (see App.tsx). Typing alone doesn't
  // search-as-you-type, since Immich's smart search is a real network call.
  onSearchSubmit: () => void;
  onClearSearch: () => void;
  // Grid thumbnail size slider, formerly in each grid view's own bottom
  // status bar (now removed) - shown here instead, to the left of the
  // search box, only while a view that has a thumbnail grid is active.
  thumbSize: number;
  onThumbSizeChange: (n: number) => void;
  showThumbSize: boolean;
}) {
  const [open, setOpen] = useState<MenuKey>(null);
  const { shortcuts } = useShortcuts();

  const toggle = (key: MenuKey) => setOpen((cur) => (cur === key ? null : key));
  const hoverTo = (key: MenuKey) => {
    // Matches native menu-bar behavior: hovering another menu button only
    // switches to it while a menu is already open, not on every hover.
    setOpen((cur) => (cur ? key : cur));
  };
  const close = () => setOpen(null);

  return (
    <div
      style={{
        height: 33,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        padding: '0 6px',
        background: 'var(--panel-3)',
        borderBottom: '1px solid var(--border-strong)',
        position: 'relative',
        zIndex: 60,
      }}
      onMouseLeave={close}
    >
      <TopMenu label="File" isOpen={open === 'file'} onClick={() => toggle('file')} onEnter={() => hoverTo('file')}>
        <MenuItem label="Upload…" shortcut="Ctrl+U" onClick={close} />
        <MenuItem
          label="Refresh Timeline"
          shortcut={prettyShortcut(shortcuts.refreshTimeline)}
          onClick={() => {
            close();
            onRefreshTimeline();
          }}
        />
        <MenuItem
          label="Import from SD Card/Disk…"
          onClick={() => {
            close();
            onOpenImport();
          }}
        />
        <Divider />
        <MenuItem
          label="Print…"
          shortcut={prettyShortcut(shortcuts.print)}
          onClick={() => {
            close();
            onPrint();
          }}
        />
        <MenuItem
          label="Export to Folder…"
          onClick={() => {
            close();
            onExportToFolder();
          }}
        />
        <MenuItem
          label="Share to Flickr…"
          onClick={() => {
            close();
            onShareToFlickr();
          }}
        />
        <MenuItem
          label="Recent Activity…"
          onClick={() => {
            close();
            onOpenActivity();
          }}
        />
        <Divider />
        <MenuItem
          label="Quit"
          shortcut="Ctrl+Q"
          onClick={() => {
            close();
            onQuit();
          }}
        />
      </TopMenu>

      <TopMenu label="Edit" isOpen={open === 'edit'} onClick={() => toggle('edit')} onEnter={() => hoverTo('edit')}>
        <MenuItem
          label="Select All"
          shortcut={prettyShortcut(shortcuts.selectAll)}
          onClick={() => {
            close();
            onSelectAll();
          }}
        />
        <MenuItem
          label="Deselect All"
          shortcut={prettyShortcut(shortcuts.deselect)}
          onClick={() => {
            close();
            onDeselectAll();
          }}
        />
        <MenuItem
          label="Stack Selected"
          shortcut={prettyShortcut(shortcuts.stack)}
          onClick={() => {
            close();
            onStackSelected();
          }}
        />
        <MenuItem
          label="Smart Stack…"
          onClick={() => {
            close();
            onSmartStack();
          }}
        />
        <Divider />
        {/* Toggle Canon RAW - disabled for now; TIF/TIFF is treated uniformly
            as non-RAW instead of relying on a manual per-asset override. */}
        {/* <MenuItem
          label="Toggle Canon RAW"
          onClick={() => {
            close();
            onToggleRawOverride();
          }}
        /> */}
        <MenuItem
          label="Sync Metadata from Sidecar"
          onClick={() => {
            close();
            onSyncSidecarRatings();
          }}
        />
        <Divider />
        <MenuItem
          label="Copy Image Processing"
          shortcut={prettyShortcut(shortcuts.copyImageProcessing)}
          onClick={() => {
            close();
            onCopyImageProcessing();
          }}
        />
        <MenuItem
          label="Paste Image Processing"
          shortcut={prettyShortcut(shortcuts.pasteImageProcessing)}
          onClick={() => {
            close();
            onPasteImageProcessing();
          }}
        />
        <MenuItem
          label="Copy Metadata"
          shortcut={prettyShortcut(shortcuts.copyMetadata)}
          onClick={() => {
            close();
            onCopyMetadata();
          }}
        />
        <MenuItem
          label="Paste Metadata"
          shortcut={prettyShortcut(shortcuts.pasteMetadata)}
          onClick={() => {
            close();
            onPasteMetadata();
          }}
        />
        <Divider />
        <MenuItem
          label="Rotate Left"
          onClick={() => {
            close();
            onRotateLeft();
          }}
        />
        <MenuItem
          label="Rotate Right"
          onClick={() => {
            close();
            onRotateRight();
          }}
        />
        <Divider />
        <MenuItem
          label="Preferences"
          shortcut={prettyShortcut(shortcuts.openPreferences)}
          onClick={() => {
            close();
            onOpenPreferences();
          }}
        />
      </TopMenu>

      <TopMenu label="View" isOpen={open === 'view'} onClick={() => toggle('view')} onEnter={() => hoverTo('view')}>
        {/* Show Filmstrip/Show Info Panel disabled - not wired to anything
            (the real toggles are Viewer-only: filmstripOpen/infoOpen in
            Viewer.tsx, with their own header buttons and shortcuts), and
            this menu has no way to know whether the Viewer is even open. */}
        {/* <MenuItem label="Show Filmstrip" onClick={close} />
        <MenuItem label="Show Info Panel" onClick={close} />
        <Divider /> */}
        <MenuItem label="Zoom In" shortcut="Ctrl++" onClick={close} />
        <MenuItem label="Zoom Out" shortcut="Ctrl+-" onClick={close} />
        {/* Sort Photos By disabled - none of these are wired to anything, so
            picking any of them had no effect and the grid stayed on its
            current (always-on) order regardless. */}
        {/* <Divider />
        <div style={{ padding: '3px 11px 5px', fontSize: 11, letterSpacing: '.04em', color: 'var(--text-dimmer)' }}>
          SORT PHOTOS BY
        </div>
        <MenuItem label="Newest first" onClick={close} />
        <MenuItem label="Oldest first" onClick={close} />
        <MenuItem label="Name" onClick={close} />
        <MenuItem label="Rating" onClick={close} /> */}
      </TopMenu>

      <TopMenu label="Help" isOpen={open === 'help'} onClick={() => toggle('help')} onEnter={() => hoverTo('help')}>
        {/* Keyboard Shortcuts disabled - not wired to anything, and already
            covered by Preferences -> Shortcuts (PreferencesShortcuts.tsx). */}
        {/* <MenuItem label="Keyboard Shortcuts" shortcut="?" onClick={close} /> */}
        <MenuItem
          label="About BrightTable"
          onClick={() => {
            close();
            onOpenAbout();
          }}
        />
      </TopMenu>

      <div style={{ width: 1, height: 18, background: 'var(--overlay-medium)', margin: '0 6px' }} />

      <div style={{ position: 'relative' }}>
        {(() => {
          const hasFilters = activeFilterCount(filters) > 0;
          return (
            <button
              onClick={() => toggle('filter')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 27,
                padding: '0 10px',
                border: 'none',
                borderRadius: 7,
                background: open === 'filter' ? '#3584e4' : hasFilters ? 'rgba(53,132,228,0.32)' : 'transparent',
                color: open === 'filter' ? '#fff' : 'var(--text)',
                fontSize: 13,
                cursor: 'default',
              }}
            >
              <div
                style={{
                  width: 0,
                  height: 0,
                  borderLeft: '5px solid transparent',
                  borderRight: '5px solid transparent',
                  borderTop: '6px solid currentColor',
                }}
              />
              Filters
              {hasFilters && (
                <span
                  style={{
                    minWidth: 16,
                    height: 16,
                    padding: '0 4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    background: '#fff',
                    color: '#3584e4',
                    fontSize: 10.5,
                    fontWeight: 700,
                  }}
                >
                  {activeFilterCount(filters)}
                </span>
              )}
            </button>
          );
        })()}
        {open === 'filter' && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 5px)',
              left: 0,
              width: 280,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              boxShadow: '0 12px 34px rgba(0,0,0,0.6)',
              padding: 14,
              zIndex: 70,
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'var(--text-dimmer)', marginBottom: 8 }}>
              MINIMUM RATING
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 15 }}>
              {[1, 2, 3, 4, 5].map((v) => (
                <div
                  key={v}
                  onClick={() => onFiltersChange({ ...filters, minRating: filters.minRating === v ? 0 : v })}
                  style={{ cursor: 'default' }}
                >
                  <Star filled={v <= filters.minRating} size={18} />
                </div>
              ))}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {filters.minRating > 0 ? `${filters.minRating}+ stars` : 'Any rating'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 15 }}>
              <span style={{ fontSize: 13 }}>Favorites only</span>
              <Switch checked={filters.favOnly} onChange={(v) => onFiltersChange({ ...filters, favOnly: v })} />
            </div>

            <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'var(--text-dimmer)', marginBottom: 8 }}>
              MEDIA TYPE
            </div>
            <div style={{ display: 'flex', gap: 5, marginBottom: 13 }}>
              {(
                [
                  ['all', 'All Media'],
                  ['photos', 'Photos'],
                  ['videos', 'Videos'],
                ] as [MediaTypeFilter, string][]
              ).map(([mt, label]) => (
                <div
                  key={mt}
                  onClick={() =>
                    // RAW/JPEG only ever discriminate within photos - picking
                    // Videos while one was set would otherwise silently zero
                    // out the grid instead of showing the dimmed, disabled
                    // control below actually doing something.
                    onFiltersChange({ ...filters, mediaType: mt, format: mt === 'videos' ? 'all' : filters.format })
                  }
                  style={segStyle(filters.mediaType === mt)}
                >
                  {label}
                </div>
              ))}
            </div>

            {(() => {
              const imageTypeDisabled = filters.mediaType === 'videos';
              return (
                <div style={{ opacity: imageTypeDisabled ? 0.4 : 1, pointerEvents: imageTypeDisabled ? 'none' : 'auto' }}>
                  <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'var(--text-dimmer)', marginBottom: 8 }}>
                    IMAGE TYPE
                  </div>
                  <div style={{ display: 'flex', gap: 5, marginBottom: 13 }}>
                    {(
                      [
                        ['all', 'RAW + JPEG'],
                        ['raw', 'RAW'],
                        ['jpeg', 'JPEG'],
                      ] as [FileTypeFilter, string][]
                    ).map(([fmt, label]) => (
                      <div
                        key={fmt}
                        onClick={() => onFiltersChange({ ...filters, format: fmt })}
                        style={segStyle(filters.format === fmt)}
                      >
                        {label}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            <div style={{ height: 1, background: 'var(--border)', margin: '0 -4px 11px' }} />
            <div
              onClick={() => onFiltersChange(DEFAULT_FILTERS)}
              style={{
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 8,
                background: 'var(--overlay-weak)',
                fontSize: 12.5,
                cursor: 'default',
              }}
            >
              Clear all filters
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {showThumbSize && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', marginRight: 12 }}>
          <div style={{ position: 'relative', width: 12, height: 12, flexShrink: 0 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, width: 8, height: 8, border: '1.5px solid currentColor', borderRadius: '50%' }} />
            <div
              style={{
                position: 'absolute',
                left: 6.6,
                top: 6.6,
                width: 4,
                height: 1.5,
                background: 'currentColor',
                borderRadius: 1,
                transformOrigin: 'left center',
                transform: 'rotate(45deg)',
              }}
            />
          </div>
          <input
            type="range"
            min={100}
            max={320}
            step={4}
            value={thumbSize}
            onChange={(e) => onThumbSizeChange(Number(e.target.value))}
            style={{ width: 104 }}
          />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          height: 24,
          padding: '0 8px 0 9px',
          background: 'var(--overlay-medium)',
          border: '1px solid var(--border)',
          borderRadius: 7,
          width: 230,
        }}
      >
        <div
          style={{
            width: 11,
            height: 11,
            border: '1.6px solid var(--text-dim)',
            borderRadius: '50%',
            position: 'relative',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              position: 'absolute',
              width: 5,
              height: 1.6,
              background: 'var(--text-dim)',
              transform: 'rotate(45deg)',
              right: -3,
              bottom: 0,
            }}
          />
        </div>
        <input
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSearchSubmit();
            else if (e.key === 'Escape') onClearSearch();
          }}
          placeholder="Search your photos…"
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text)',
            fontSize: 12.5,
          }}
        />
        {searchQuery && (
          <div
            onClick={onClearSearch}
            title="Clear search"
            style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-dim)', cursor: 'default' }}
          >
            ✕
          </div>
        )}
      </div>

      <div style={{ width: 1, height: 18, background: 'var(--overlay-medium)', margin: '0 6px' }} />

      <div
        onClick={onToggleMetadata}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          height: 30,
          padding: '0 13px',
          borderRadius: 8,
          fontSize: 12.5,
          cursor: 'default',
          background: metaOpen ? '#3584e4' : 'var(--overlay-medium)',
        }}
      >
        Metadata
      </div>
    </div>
  );
}

function TopMenu({
  label,
  isOpen,
  onClick,
  onEnter,
  children,
}: {
  label: string;
  isOpen: boolean;
  onClick: () => void;
  onEnter: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={onClick}
        onMouseEnter={onEnter}
        style={{
          height: 27,
          padding: '0 12px',
          border: 'none',
          borderRadius: 7,
          background: isOpen ? 'var(--overlay-medium)' : 'transparent',
          color: 'var(--text)',
          fontSize: 13,
          cursor: 'default',
        }}
      >
        {label}
      </button>
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 5px)',
            left: 0,
            minWidth: 236,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 11,
            boxShadow: '0 12px 34px rgba(0,0,0,0.6)',
            padding: 6,
            zIndex: 70,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, shortcut, onClick }: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 31,
        padding: '0 11px',
        borderRadius: 7,
        fontSize: 13.5,
        cursor: 'default',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#3584e4')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
      {shortcut && <span style={{ opacity: 0.45, fontSize: 12 }}>{shortcut}</span>}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '6px 9px' }} />;
}

function segStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    height: 30,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    borderRadius: 7,
    cursor: 'default',
    color: active ? '#fff' : 'var(--text-dim)',
    background: active ? '#3584e4' : 'var(--overlay-weak)',
    // Segment labels are meant to be short - if a panel/window ever gets
    // narrow enough that one doesn't fit, degrade to an ellipsis instead of
    // silently wrapping onto a second line and breaking the fixed height.
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    padding: '0 4px',
  };
}
