import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { LibraryStatusProvider } from './lib/libraryStatus';
import { isTypingTarget, matchesShortcut, ShortcutsProvider, useShortcuts } from './lib/shortcuts';
import { SmartStackSettingsProvider } from './lib/smartStackSettings';
import { WindowControlsProvider } from './lib/windowControls';
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
import ResizeHandles from './components/ResizeHandles';
import MenuBar from './components/MenuBar';
import Sidebar, { type LeftTab } from './components/Sidebar';
import PreferencesOverlay from './components/PreferencesOverlay';
import ActivityPanel from './components/ActivityPanel';
import ImportDialog from './components/ImportDialog';
import ConfirmDialog from './components/ConfirmDialog';
import AboutDialog from './components/AboutDialog';
import PhotosBrowser, { type PhotosBrowserHandle } from './pages/PhotosBrowser';
import FoldersBrowser, { type FoldersBrowserHandle } from './pages/FoldersBrowser';
import TrashBrowser from './pages/TrashBrowser';
import AlbumsBrowser, { type AlbumsBrowserHandle } from './pages/AlbumsBrowser';
import PeopleBrowser, { type PeopleBrowserHandle } from './pages/PeopleBrowser';
import TagsBrowser, { type TagsBrowserHandle } from './pages/TagsBrowser';
import SearchResultsBrowser, { type SearchResultsBrowserHandle } from './pages/SearchResultsBrowser';
import { DEFAULT_FILTERS } from './lib/filters';

export default function App() {
  return (
    <ShortcutsProvider>
      <WindowControlsProvider>
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
      </WindowControlsProvider>
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
  const [aboutOpen, setAboutOpen] = useState(false);
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
  // Same lazy-mount-once-then-stay-mounted treatment as Albums, for the same
  // reason - avoids firing listPeople before the user has ever asked to see
  // the People tab.
  const [peopleVisited, setPeopleVisited] = useState(false);
  useEffect(() => {
    if (leftTab === 'people') setPeopleVisited(true);
  }, [leftTab]);
  // Same lazy-mount-once-then-stay-mounted treatment as People, for the same
  // reason - avoids firing listTags before the user has ever asked to see
  // the Tags tab.
  const [tagsVisited, setTagsVisited] = useState(false);
  useEffect(() => {
    if (leftTab === 'tags') setTagsVisited(true);
  }, [leftTab]);
  const [albumsCount, setAlbumsCount] = useState(0);
  const [peopleCount, setPeopleCount] = useState(0);
  const [tagsCount, setTagsCount] = useState(0);
  // Live text typed into MenuBar's search box - a separate state from
  // `activeSearch` below since Immich's smart search is a real network call
  // per query, not filtered client-side as you type (see MenuBar.tsx's
  // onSearchSubmit doc comment).
  const [searchQuery, setSearchQuery] = useState('');
  // The submitted query that actually drives SearchResultsBrowser - set on
  // Enter (MenuBar's onSearchSubmit) or Escape/✕/switching tabs clears both
  // this and `searchQuery` together (see clearSearch below). Non-empty means
  // "showing search results", replacing whichever tab was visible - see the
  // content-area render below.
  const [activeSearch, setActiveSearch] = useState('');
  const clearSearch = () => {
    setSearchQuery('');
    setActiveSearch('');
  };
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
  const peopleRef = useRef<PeopleBrowserHandle>(null);
  const tagsRef = useRef<TagsBrowserHandle>(null);
  const searchRef = useRef<SearchResultsBrowserHandle>(null);
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
      <ResizeHandles />
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
        onRotateLeft={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.rotateLeft()}
        onRotateRight={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.rotateRight()}
        onExportToFolder={() =>
          (activeSearch
            ? searchRef
            : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
          ).current?.openExportToFolder()
        }
        onShareToFlickr={() =>
          (activeSearch
            ? searchRef
            : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
          ).current?.openExportToFlickr()
        }
        onOpenAbout={() => setAboutOpen(true)}
        filters={filters}
        onFiltersChange={setFilters}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onSearchSubmit={() => searchQuery.trim() && setActiveSearch(searchQuery.trim())}
        onClearSearch={clearSearch}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0, background: '#242424', position: 'relative' }}>
        <Sidebar
          active={leftTab}
          onSelect={(tab) => {
            clearSearch();
            setLeftTab(tab);
          }}
          photosCount={photosCount}
          trashCount={trashCount}
          albumsCount={albumsCount}
          peopleCount={peopleCount}
          tagsCount={tagsCount}
        />

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
          {activeSearch && (
            <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <SearchResultsBrowser
                key={activeSearch}
                ref={searchRef}
                query={activeSearch}
                metaOpen={metaOpen}
                onCloseMetadata={() => setMetaOpen(false)}
                onClose={clearSearch}
                active
              />
            </div>
          )}
          <div style={{ display: !activeSearch && leftTab === 'photos' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <PhotosBrowser
              key={dataKey}
              ref={photosRef}
              active={!activeSearch && leftTab === 'photos'}
              onTotalCount={setPhotosCount}
              metaOpen={metaOpen}
              onCloseMetadata={() => setMetaOpen(false)}
              filters={filters}
              onOpenApplicationsPreferences={() => openPreferencesTab('applications')}
            />
          </div>
          {albumsVisited && (
            <div style={{ display: !activeSearch && leftTab === 'albums' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <AlbumsBrowser
                ref={albumsRef}
                metaOpen={metaOpen}
                onCloseMetadata={() => setMetaOpen(false)}
                onCount={setAlbumsCount}
                active={!activeSearch && leftTab === 'albums'}
              />
            </div>
          )}
          {peopleVisited && (
            <div style={{ display: !activeSearch && leftTab === 'people' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <PeopleBrowser
                ref={peopleRef}
                metaOpen={metaOpen}
                onCloseMetadata={() => setMetaOpen(false)}
                onCount={setPeopleCount}
                active={!activeSearch && leftTab === 'people'}
              />
            </div>
          )}
          {tagsVisited && (
            <div style={{ display: !activeSearch && leftTab === 'tags' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <TagsBrowser
                ref={tagsRef}
                metaOpen={metaOpen}
                onCloseMetadata={() => setMetaOpen(false)}
                onCount={setTagsCount}
                active={!activeSearch && leftTab === 'tags'}
              />
            </div>
          )}
          {foldersVisited && (
            <div style={{ display: !activeSearch && leftTab === 'folders' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <FoldersBrowser
                key={dataKey}
                ref={foldersRef}
                active={!activeSearch && leftTab === 'folders'}
                metaOpen={metaOpen}
                onCloseMetadata={() => setMetaOpen(false)}
                filters={filters}
                onOpenApplicationsPreferences={() => openPreferencesTab('applications')}
              />
            </div>
          )}
          {!activeSearch && leftTab === 'trash' && <TrashBrowser onCount={setTrashCount} />}
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
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
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
