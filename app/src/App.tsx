import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { LibraryStatusProvider } from './lib/libraryStatus';
import { isTypingTarget, matchesShortcut, ShortcutsProvider, useShortcuts } from './lib/shortcuts';
import { SmartStackSettingsProvider } from './lib/smartStackSettings';
import { ApplicationsProvider } from './lib/applications';
import { RawOverridesProvider } from './lib/rawOverrides';
import { EditQueueProvider } from './lib/editQueue';
import { ImportQueueProvider } from './lib/importQueue';
import { ClipboardProvider } from './lib/clipboard';
import { ProcessingQueueProvider } from './lib/processingQueue';
import { ArtQueueProvider } from './lib/artQueue';
import { ExportQueueProvider } from './lib/exportQueue';
import { forceQuit } from './lib/api';
import TitleBar from './components/TitleBar';
import MenuBar from './components/MenuBar';
import Sidebar, { type LeftTab } from './components/Sidebar';
import PreferencesOverlay from './components/PreferencesOverlay';
import PlaceholderView from './components/PlaceholderView';
import ActivityPanel from './components/ActivityPanel';
import ImportDialog from './components/ImportDialog';
import ConfirmDialog from './components/ConfirmDialog';
import PhotosBrowser, { type PhotosBrowserHandle } from './pages/PhotosBrowser';
import FoldersBrowser, { type FoldersBrowserHandle } from './pages/FoldersBrowser';
import TrashBrowser from './pages/TrashBrowser';
import AlbumsBrowser, { type AlbumsBrowserHandle } from './pages/AlbumsBrowser';
import { DEFAULT_FILTERS } from './lib/filters';

export default function App() {
  return (
    <ShortcutsProvider>
      <SmartStackSettingsProvider>
        <ApplicationsProvider>
          <RawOverridesProvider>
            <ClipboardProvider>
              <EditQueueProvider>
                <ImportQueueProvider>
                  <ProcessingQueueProvider>
                    <ArtQueueProvider>
                      <ExportQueueProvider>
                        <LibraryStatusProvider>
                          <AppShell />
                        </LibraryStatusProvider>
                      </ExportQueueProvider>
                    </ArtQueueProvider>
                  </ProcessingQueueProvider>
                </ImportQueueProvider>
              </EditQueueProvider>
            </ClipboardProvider>
          </RawOverridesProvider>
        </ApplicationsProvider>
      </SmartStackSettingsProvider>
    </ShortcutsProvider>
  );
}

function AppShell() {
  const [leftTab, setLeftTab] = useState<LeftTab>('photos');
  const [prefsOpen, setPrefsOpen] = useState(false);
  // Which tab Preferences opens on next - reset to 'library' once closed so
  // a later plain "Preferences…" open doesn't strand the user on whichever
  // tab a redirect (e.g. an editor button with no app chosen yet) last used.
  const [prefsInitialTab, setPrefsInitialTab] = useState<'library' | 'applications' | 'sharing'>('library');
  const openPreferencesTab = (tab: 'library' | 'applications' | 'sharing') => {
    setPrefsInitialTab(tab);
    setPrefsOpen(true);
  };
  const [importOpen, setImportOpen] = useState(false);
  // Folders is mounted lazily on its first visit (unlike Photos, the default
  // tab, which is always mounted from the start) rather than eagerly at
  // startup - avoids firing its getFolderPaths/listStacks fetches before the
  // user has ever asked to see that tab. Once true it stays true, so the
  // component then stays mounted (just hidden) rather than being torn down
  // again on every subsequent switch away - see the render below.
  const [foldersVisited, setFoldersVisited] = useState(false);
  useEffect(() => {
    if (leftTab === 'folders') setFoldersVisited(true);
  }, [leftTab]);
  // Same lazy-mount-once-then-stay-mounted treatment as Folders, for the same
  // reason - avoids firing listAlbums before the user has ever asked to see
  // the Albums tab.
  const [albumsVisited, setAlbumsVisited] = useState(false);
  useEffect(() => {
    if (leftTab === 'albums') setAlbumsVisited(true);
  }, [leftTab]);
  const [albumsCount, setAlbumsCount] = useState(0);
  const [photosCount, setPhotosCount] = useState(0);
  // Shared by both PhotosBrowser and FoldersBrowser - bumping it forces
  // whichever is currently mounted to fully remount (clearing its
  // assetCache/unsyncedMetadata/etc.), since neither view otherwise has any
  // way to know a local sidecar or the path-mapping config changed
  // underneath it. Previously only applied to PhotosBrowser, so Refresh
  // Timeline silently did nothing while looking at the Folders tab.
  const [dataKey, setDataKey] = useState(0);
  const [metaOpen, setMetaOpen] = useState(false);
  const [trashCount, setTrashCount] = useState(0);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [activityOpen, setActivityOpen] = useState(false);
  // Set from the one deliberate Tauri event in this design (see lib.rs's
  // `on_window_event` - it fires only when the user actually tries to close
  // with edits still in flight). Holds the pending count at the moment of
  // that attempt so the warning dialog can report it; null means no close
  // attempt is currently being blocked.
  const [closeBlockedCount, setCloseBlockedCount] = useState<number | null>(null);
  const photosRef = useRef<PhotosBrowserHandle>(null);
  const foldersRef = useRef<FoldersBrowserHandle>(null);
  const albumsRef = useRef<AlbumsBrowserHandle>(null);
  const { shortcuts, capturing } = useShortcuts();

  const refreshTimeline = () => setDataKey((k) => k + 1);

  useEffect(() => {
    const unlisten = listen<number>('queue-close-blocked', (e) => setCloseBlockedCount(e.payload));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Global-level shortcuts (not owned by any single view): Refresh Timeline
  // and Open Preferences. Skipped while typing, while Preferences is already
  // open, or while the Shortcuts pane is capturing a new binding.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || prefsOpen || capturing) return;
      if (matchesShortcut(e, shortcuts.refreshTimeline)) {
        e.preventDefault();
        refreshTimeline();
      } else if (matchesShortcut(e, shortcuts.openPreferences)) {
        e.preventDefault();
        setPrefsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefsOpen, shortcuts, capturing]);

  return (
    <div
      style={{
        height: '100vh',
        width: '100%',
        background: '#1c1c1c',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <TitleBar activeTab={leftTab} onOpenActivity={() => setActivityOpen(true)} />
      <MenuBar
        onOpenPreferences={() => setPrefsOpen(true)}
        onRefreshTimeline={refreshTimeline}
        onOpenImport={() => setImportOpen(true)}
        onOpenActivity={() => setActivityOpen(true)}
        onQuit={() => getCurrentWindow().close()}
        metaOpen={metaOpen}
        onToggleMetadata={() => setMetaOpen((v) => !v)}
        onSelectAll={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.selectAll()}
        onDeselectAll={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.deselectAll()}
        onStackSelected={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.stackSelected()}
        onSmartStack={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.openSmartStack()}
        onToggleRawOverride={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.toggleRawOverrideForSelection()}
        onSyncSidecarRatings={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.syncAllUnsyncedMetadata()}
        onCopyImageProcessing={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.copyImageProcessing()}
        onPasteImageProcessing={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.pasteImageProcessing()}
        onCopyMetadata={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.copyMetadata()}
        onPasteMetadata={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.pasteMetadata()}
        onPrint={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.openPrint()}
        onExportToFolder={() =>
          (leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : photosRef).current?.openExportToFolder()
        }
        onShareToFlickr={() =>
          (leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : photosRef).current?.openExportToFlickr()
        }
        filters={filters}
        onFiltersChange={setFilters}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0, background: '#242424', position: 'relative' }}>
        <Sidebar active={leftTab} onSelect={setLeftTab} photosCount={photosCount} trashCount={trashCount} albumsCount={albumsCount} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#1c1c1c', position: 'relative' }}>
          {/* Photos and Folders stay mounted (just hidden) once visited, rather
              than being unmounted on every tab switch - each keeps its own
              assetCache of everything already fetched from Immich this
              session, so switching back doesn't re-fetch the whole timeline/
              folder tree from scratch. `key={dataKey}` still forces a full
              remount (and so a full refetch) on an explicit Refresh Timeline.
              `active` gates each one's global keydown shortcuts so a
              backgrounded tab doesn't react to keys meant for the visible
              one. */}
          <div style={{ display: leftTab === 'photos' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <PhotosBrowser
              key={dataKey}
              ref={photosRef}
              active={leftTab === 'photos'}
              onTotalCount={setPhotosCount}
              metaOpen={metaOpen}
              onCloseMetadata={() => setMetaOpen(false)}
              filters={filters}
              onOpenApplicationsPreferences={() => openPreferencesTab('applications')}
            />
          </div>
          {albumsVisited && (
            <div style={{ display: leftTab === 'albums' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <AlbumsBrowser
                ref={albumsRef}
                metaOpen={metaOpen}
                onCloseMetadata={() => setMetaOpen(false)}
                onCount={setAlbumsCount}
                active={leftTab === 'albums'}
              />
            </div>
          )}
          {leftTab === 'people' && <PlaceholderView label="People" />}
          {foldersVisited && (
            <div style={{ display: leftTab === 'folders' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <FoldersBrowser
                key={dataKey}
                ref={foldersRef}
                active={leftTab === 'folders'}
                metaOpen={metaOpen}
                onCloseMetadata={() => setMetaOpen(false)}
                filters={filters}
                onOpenApplicationsPreferences={() => openPreferencesTab('applications')}
              />
            </div>
          )}
          {leftTab === 'trash' && <TrashBrowser onCount={setTrashCount} />}
        </div>
      </div>

      {prefsOpen && (
        <PreferencesOverlay
          initialTab={prefsInitialTab}
          onClose={() => {
            setPrefsOpen(false);
            setPrefsInitialTab('library');
          }}
        />
      )}
      {activityOpen && <ActivityPanel onClose={() => setActivityOpen(false)} />}
      {importOpen && (
        <ImportDialog onClose={() => setImportOpen(false)} onOpenLibraryPreferences={() => openPreferencesTab('library')} />
      )}
      {closeBlockedCount != null && (
        <ConfirmDialog
          title="Still syncing"
          message={`${closeBlockedCount} edit/import job${closeBlockedCount === 1 ? '' : 's'} still in progress. Quitting now may leave a change unsaved or an import incomplete.`}
          confirmLabel="Quit anyway"
          cancelLabel="Wait"
          danger
          onConfirm={forceQuit}
          onClose={() => setCloseBlockedCount(null)}
        />
      )}
    </div>
  );
}
