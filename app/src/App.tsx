/*
 * BrightTable // Copyright (C) 2026 Rob Brown
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { LibraryStatusProvider } from './lib/libraryStatus';
import { isTypingTarget, matchesShortcut, ShortcutsProvider, useShortcuts } from './lib/shortcuts';
import { SmartStackSettingsProvider } from './lib/smartStackSettings';
import { WindowControlsProvider } from './lib/windowControls';
import { GridLoupeSettingsProvider, useGridLoupeSettings } from './lib/gridLoupeSettings';
import { useSyncWindowFrameMaximized } from './lib/windowFrame';
import { ThemeProvider } from './lib/theme';
import { ApplicationsProvider } from './lib/applications';
import { RawOverridesProvider } from './lib/rawOverrides';
import { EditQueueProvider } from './lib/editQueue';
import { ImportQueueProvider } from './lib/importQueue';
import { ClipboardProvider } from './lib/clipboard';
import { ProcessingQueueProvider } from './lib/processingQueue';
import { ArtQueueProvider } from './lib/artQueue';
import { ExportQueueProvider } from './lib/exportQueue';
import { StackQueueProvider } from './lib/stackQueue';
import { forceQuit } from './lib/api';
import TitleBar from './components/TitleBar';
import ResizeHandles from './components/ResizeHandles';
import MenuBar from './components/MenuBar';
import { type LeftTab } from './components/NavTabs';
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
    <ThemeProvider>
      <ShortcutsProvider>
        <WindowControlsProvider>
          <GridLoupeSettingsProvider>
            <SmartStackSettingsProvider>
              <ApplicationsProvider>
                <RawOverridesProvider>
                  <ClipboardProvider>
                    <EditQueueProvider>
                      <ImportQueueProvider>
                        <ProcessingQueueProvider>
                          <ArtQueueProvider>
                            <ExportQueueProvider>
                              <StackQueueProvider>
                                <LibraryStatusProvider>
                                  <AppShell />
                                </LibraryStatusProvider>
                              </StackQueueProvider>
                            </ExportQueueProvider>
                          </ArtQueueProvider>
                        </ProcessingQueueProvider>
                      </ImportQueueProvider>
                    </EditQueueProvider>
                  </ClipboardProvider>
                </RawOverridesProvider>
              </ApplicationsProvider>
            </SmartStackSettingsProvider>
          </GridLoupeSettingsProvider>
        </WindowControlsProvider>
      </ShortcutsProvider>
    </ThemeProvider>
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
  // Grid thumbnail size, shared by Photos and Folders (the only two grid
  // views with a size slider) - lives here since the slider itself now sits
  // in MenuBar rather than in either browser's own (removed) status bar.
  const [thumbSize, setThumbSize] = useState(168);
  // Shared by both PhotosBrowser and FoldersBrowser - bumping it forces
  // whichever is currently mounted to fully remount (clearing its
  // assetCache/unsyncedMetadata/etc.), since neither view otherwise has any
  // way to know a local sidecar or the path-mapping config changed
  // underneath it. Previously only applied to PhotosBrowser, so Refresh
  // Timeline silently did nothing while looking at the Folders tab.
  const [dataKey, setDataKey] = useState(0);
  const [metaOpen, setMetaOpen] = useState(false);
  // Grid loupe mode (every thumbnail-grid view, see showLoupe below) - a
  // hover-preview split pane that needs the sidebar and metadata panel out
  // of the way to make room. Entering it remembers whatever metaOpen was so
  // leaving restores exactly that, rather than always landing back closed.
  const [gridLoupeOn, setGridLoupeOn] = useState(false);
  // Loupe circle size - Small is the original fixed 33/67 grid/pane split;
  // Large shrinks the grid down to a thin strip so the pane (and so the
  // circle within it) takes up most of the view instead. Persisted via
  // Preferences → Configuration → Window ("Thumbnail Loupe Size"), not a
  // local toggle here.
  const { large: gridLoupeLarge } = useGridLoupeSettings();
  const metaOpenBeforeLoupe = useRef(false);
  const toggleGridLoupe = () => {
    setGridLoupeOn((v) => {
      const next = !v;
      if (next) {
        metaOpenBeforeLoupe.current = metaOpen;
        setMetaOpen(false);
      } else {
        setMetaOpen(metaOpenBeforeLoupe.current);
      }
      return next;
    });
  };
  const [trashCount, setTrashCount] = useState(0);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [activityOpen, setActivityOpen] = useState(false);
  // Set from the one deliberate Tauri event in this design (see lib.rs's
  // `on_window_event` - it fires only when the user actually tries to close
  // with edits still in flight). Holds the pending count at the moment of
  // that attempt so the warning dialog can report it; null means no close
  // attempt is currently being blocked.
  const [closeBlockedCount, setCloseBlockedCount] = useState<number | null>(null);
  useSyncWindowFrameMaximized();
  const photosRef = useRef<PhotosBrowserHandle>(null);
  const foldersRef = useRef<FoldersBrowserHandle>(null);
  const albumsRef = useRef<AlbumsBrowserHandle>(null);
  const peopleRef = useRef<PeopleBrowserHandle>(null);
  const tagsRef = useRef<TagsBrowserHandle>(null);
  const searchRef = useRef<SearchResultsBrowserHandle>(null);
  const { shortcuts, capturing } = useShortcuts();

  const refreshTimeline = () => setDataKey((k) => k + 1);
  // Every tab with a thumbnail grid has a size to zoom - Photos/Folders plus
  // Tags/People/Albums/Trash (i.e. every LeftTab).
  const showThumbSize = !activeSearch;
  // Grid loupe mode is available on every view with a thumbnail grid except
  // Trash, which has its own hover actions (restore/delete) instead of the
  // loupe's hover-preview interaction.
  const showLoupe = !activeSearch && (leftTab === 'photos' || leftTab === 'folders' || leftTab === 'tags' || leftTab === 'people' || leftTab === 'albums');

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
      } else if (showThumbSize && (matchesShortcut(e, 'Ctrl++') || matchesShortcut(e, 'Ctrl+='))) {
        e.preventDefault();
        setThumbSize((n) => Math.min(320, n + 24));
      } else if (showThumbSize && matchesShortcut(e, 'Ctrl+-')) {
        e.preventDefault();
        setThumbSize((n) => Math.max(100, n - 24));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefsOpen, shortcuts, capturing, showThumbSize]);

  return (
    <div
      className="window-frame-margin"
      style={{
        height: '100vh',
        width: '100%',
        background: 'transparent',
      }}
    >
      <ResizeHandles />
      <div
        className="window-frame"
        style={{
          height: '100%',
          width: '100%',
          background: 'var(--canvas)',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        <TitleBar
          activeTab={leftTab}
          onOpenActivity={() => setActivityOpen(true)}
          onOpenLibrarySettings={() => openPreferencesTab('library')}
        />
        <MenuBar
          activeTab={leftTab}
          onSelectTab={(tab) => {
            clearSearch();
            setLeftTab(tab);
          }}
          photosCount={photosCount}
          trashCount={trashCount}
          albumsCount={albumsCount}
          peopleCount={peopleCount}
          tagsCount={tagsCount}
          onOpenPreferences={() => setPrefsOpen(true)}
          onRefreshTimeline={refreshTimeline}
          onOpenImport={() => setImportOpen(true)}
          onOpenActivity={() => setActivityOpen(true)}
          onQuit={() => getCurrentWindow().close()}
          metaOpen={metaOpen}
          onToggleMetadata={() => setMetaOpen((v) => !v)}
          loupeOn={gridLoupeOn}
          onToggleLoupe={toggleGridLoupe}
          onSelectAll={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.selectAll()
          }
          onDeselectAll={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.deselectAll()
          }
          // Stack/Smart Stack/Sync/Copy/Paste/Rotate previously only ever
          // reached Photos/Folders here (a 2-way ternary), silently no-oping
          // on the Albums/People/Tags/Search tabs even though those pages now
          // implement the same actions via useAssetActions.ts - routed
          // through the same 6-way active-tab switch onExportToFolder/
          // onShareToFlickr already use below. Print and RAW-override toggle
          // stay Photos/Folders-only - those two are genuinely not
          // implemented anywhere else.
          onStackSelected={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.stackSelected()
          }
          onSmartStack={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.openSmartStack()
          }
          onToggleRawOverride={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.toggleRawOverrideForSelection()}
          onSyncSidecarRatings={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.syncAllUnsyncedMetadata()
          }
          onCopyImageProcessing={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.copyImageProcessing()
          }
          onPasteImageProcessing={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.pasteImageProcessing()
          }
          onCopyMetadata={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.copyMetadata()
          }
          onPasteMetadata={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.pasteMetadata()
          }
          onPrint={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.openPrint()}
          onRotateLeft={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.rotateLeft()
          }
          onRotateRight={() =>
            (activeSearch ? searchRef : leftTab === 'folders' ? foldersRef : leftTab === 'albums' ? albumsRef : leftTab === 'people' ? peopleRef : leftTab === 'tags' ? tagsRef : photosRef
            ).current?.rotateRight()
          }
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
          thumbSize={thumbSize}
          onThumbSizeChange={setThumbSize}
          showThumbSize={showThumbSize}
          showLoupe={showLoupe}
        />

        <div style={{ flex: 1, display: 'flex', minHeight: 0, background: 'var(--panel-2)', position: 'relative' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--canvas)', position: 'relative' }}>
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
                thumbSize={thumbSize}
                loupeOn={gridLoupeOn}
                onToggleLoupe={toggleGridLoupe}
                loupeLarge={gridLoupeLarge}
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
                  loupeOn={gridLoupeOn}
                  onToggleLoupe={toggleGridLoupe}
                  loupeLarge={gridLoupeLarge}
                  thumbSize={thumbSize}
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
                  loupeOn={gridLoupeOn}
                  onToggleLoupe={toggleGridLoupe}
                  loupeLarge={gridLoupeLarge}
                  thumbSize={thumbSize}
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
                  loupeOn={gridLoupeOn}
                  onToggleLoupe={toggleGridLoupe}
                  loupeLarge={gridLoupeLarge}
                  thumbSize={thumbSize}
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
                  thumbSize={thumbSize}
                  loupeOn={gridLoupeOn}
                  onToggleLoupe={toggleGridLoupe}
                  loupeLarge={gridLoupeLarge}
                />
              </div>
            )}
            {!activeSearch && leftTab === 'trash' && <TrashBrowser onCount={setTrashCount} thumbSize={thumbSize} />}
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
            title="Still in progress"
            message={`${closeBlockedCount} job${closeBlockedCount === 1 ? '' : 's'} still in progress. Quitting now may leave a change unsaved, an import incomplete, or a stack operation half-applied.`}
            confirmLabel="Quit anyway"
            cancelLabel="Wait"
            danger
            onConfirm={forceQuit}
            onClose={() => setCloseBlockedCount(null)}
          />
        )}
      </div>
    </div>
  );
}
