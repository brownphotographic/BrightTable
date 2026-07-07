import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LibraryStatusProvider } from './lib/libraryStatus';
import { isTypingTarget, matchesShortcut, ShortcutsProvider, useShortcuts } from './lib/shortcuts';
import { SmartStackSettingsProvider } from './lib/smartStackSettings';
import { RawOverridesProvider } from './lib/rawOverrides';
import TitleBar from './components/TitleBar';
import MenuBar from './components/MenuBar';
import Sidebar, { type LeftTab } from './components/Sidebar';
import PreferencesOverlay from './components/PreferencesOverlay';
import PlaceholderView from './components/PlaceholderView';
import PhotosBrowser, { type PhotosBrowserHandle } from './pages/PhotosBrowser';
import FoldersBrowser, { type FoldersBrowserHandle } from './pages/FoldersBrowser';
import TrashBrowser from './pages/TrashBrowser';
import { DEFAULT_FILTERS } from './lib/filters';

export default function App() {
  return (
    <ShortcutsProvider>
      <SmartStackSettingsProvider>
        <RawOverridesProvider>
          <LibraryStatusProvider>
            <AppShell />
          </LibraryStatusProvider>
        </RawOverridesProvider>
      </SmartStackSettingsProvider>
    </ShortcutsProvider>
  );
}

function AppShell() {
  const [leftTab, setLeftTab] = useState<LeftTab>('photos');
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [photosCount, setPhotosCount] = useState(0);
  const [photosKey, setPhotosKey] = useState(0);
  const [metaOpen, setMetaOpen] = useState(false);
  const [trashCount, setTrashCount] = useState(0);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const photosRef = useRef<PhotosBrowserHandle>(null);
  const foldersRef = useRef<FoldersBrowserHandle>(null);
  const { shortcuts, capturing } = useShortcuts();

  const refreshTimeline = () => setPhotosKey((k) => k + 1);

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
      <TitleBar activeTab={leftTab} />
      <MenuBar
        onOpenPreferences={() => setPrefsOpen(true)}
        onRefreshTimeline={refreshTimeline}
        onQuit={() => getCurrentWindow().close()}
        metaOpen={metaOpen}
        onToggleMetadata={() => setMetaOpen((v) => !v)}
        onSelectAll={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.selectAll()}
        onDeselectAll={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.deselectAll()}
        onStackSelected={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.stackSelected()}
        onSmartStack={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.openSmartStack()}
        onToggleRawOverride={() => (leftTab === 'folders' ? foldersRef : photosRef).current?.toggleRawOverrideForSelection()}
        filters={filters}
        onFiltersChange={setFilters}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0, background: '#242424', position: 'relative' }}>
        <Sidebar active={leftTab} onSelect={setLeftTab} photosCount={photosCount} trashCount={trashCount} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#1c1c1c', position: 'relative' }}>
          {leftTab === 'photos' && (
            <PhotosBrowser
              key={photosKey}
              ref={photosRef}
              onTotalCount={setPhotosCount}
              metaOpen={metaOpen}
              onCloseMetadata={() => setMetaOpen(false)}
              filters={filters}
            />
          )}
          {leftTab === 'albums' && <PlaceholderView label="Albums" />}
          {leftTab === 'people' && <PlaceholderView label="People" />}
          {leftTab === 'folders' && (
            <FoldersBrowser
              ref={foldersRef}
              metaOpen={metaOpen}
              onCloseMetadata={() => setMetaOpen(false)}
              filters={filters}
            />
          )}
          {leftTab === 'trash' && <TrashBrowser onCount={setTrashCount} />}
        </div>
      </div>

      {prefsOpen && <PreferencesOverlay onClose={() => setPrefsOpen(false)} />}
    </div>
  );
}
