import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getConfig, saveShortcuts } from './api';

export type ShortcutId =
  | 'open'
  | 'selectAll'
  | 'deselect'
  | 'delete'
  | 'prev'
  | 'next'
  | 'toggleInfo'
  | 'toggleFilmstrip'
  | 'favorite'
  | 'loupe'
  | 'rate0'
  | 'rate1'
  | 'rate2'
  | 'rate3'
  | 'rate4'
  | 'rate5'
  | 'reject'
  | 'stack'
  | 'refreshTimeline'
  | 'openPreferences'
  | 'openInRawEditor'
  | 'openInExternalEditor';

export const SHORTCUT_DEFS: { id: ShortcutId; label: string }[] = [
  { id: 'open', label: 'Open photo' },
  { id: 'selectAll', label: 'Select all' },
  { id: 'deselect', label: 'Deselect / close' },
  { id: 'delete', label: 'Move to Trash' },
  { id: 'prev', label: 'Previous photo' },
  { id: 'next', label: 'Next photo' },
  { id: 'toggleInfo', label: 'Toggle info panel' },
  { id: 'toggleFilmstrip', label: 'Toggle filmstrip' },
  { id: 'favorite', label: 'Toggle favorite' },
  { id: 'loupe', label: 'Toggle loupe' },
  { id: 'rate0', label: 'Clear rating' },
  { id: 'rate1', label: 'Rate 1 star' },
  { id: 'rate2', label: 'Rate 2 stars' },
  { id: 'rate3', label: 'Rate 3 stars' },
  { id: 'rate4', label: 'Rate 4 stars' },
  { id: 'rate5', label: 'Rate 5 stars' },
  { id: 'reject', label: 'Reject' },
  { id: 'stack', label: 'Stack selected' },
  { id: 'refreshTimeline', label: 'Refresh timeline' },
  { id: 'openPreferences', label: 'Open preferences' },
  { id: 'openInRawEditor', label: 'Open in RAW Editor' },
  { id: 'openInExternalEditor', label: 'Open in Ext. Editor' },
];

// `toggleFilmstrip` moved off "F" to "M" to make room for "favorite" - both
// wanted the same mnemonic key, and favorite/rating are the more frequently
// used one-handed culling shortcuts.
export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  open: 'Enter',
  selectAll: 'Ctrl+A',
  deselect: 'Escape',
  delete: 'Delete',
  prev: 'ArrowLeft',
  next: 'ArrowRight',
  toggleInfo: 'I',
  toggleFilmstrip: 'M',
  favorite: 'F',
  loupe: 'L',
  rate0: '0',
  rate1: '1',
  rate2: '2',
  rate3: '3',
  rate4: '4',
  rate5: '5',
  reject: '9',
  stack: 'S',
  refreshTimeline: 'Ctrl+R',
  openPreferences: 'Ctrl+,',
  openInRawEditor: 'Ctrl+Enter',
  openInExternalEditor: 'Ctrl+E',
};

// Canonical stored form: modifier prefixes (Ctrl/Alt/Shift, in that order)
// plus the raw `e.key` (single letters uppercased). Shift is only recorded
// for multi-char keys (e.g. Shift+ArrowLeft) - for a plain letter, shift
// already changes what `e.key` is (or doesn't, for symbols), so recording
// it separately would just make "A" and "Shift+A" fail to match the same
// binding for no benefit.
export function formatShortcut(e: KeyboardEvent | React.KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey && e.key.length > 1) mods.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  mods.push(k);
  return mods.join('+');
}

const PRETTY: Record<string, string> = {
  Escape: 'Esc',
  Delete: 'Del',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

// Display-only formatting - the stored/compared string always matches `e.key`
// verbatim so capture/compare never has to know about this cosmetic mapping.
export function prettyShortcut(binding: string): string {
  return binding
    .split('+')
    .map((part) => PRETTY[part] ?? part)
    .join('+');
}

export function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

export function matchesShortcut(e: KeyboardEvent, binding: string | undefined): boolean {
  return !!binding && formatShortcut(e) === binding;
}

interface ShortcutsContextValue {
  shortcuts: Record<ShortcutId, string>;
  resetDefaults: () => void;
  // While `capturing` is set (rebinding UI in Preferences → Shortcuts is
  // waiting for a key press), every other shortcut consumer must ignore
  // keydowns entirely - otherwise the very key being captured (e.g. "A" for
  // Select All) would also fire its *old* binding in the grid/viewer behind
  // the dialog at the same time.
  capturing: ShortcutId | null;
  beginCapture: (id: ShortcutId) => void;
  cancelCapture: () => void;
  commitCapture: (id: ShortcutId, key: string) => void;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [shortcuts, setShortcuts] = useState<Record<ShortcutId, string>>(DEFAULT_SHORTCUTS);
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);

  useEffect(() => {
    getConfig()
      .then((cfg) => setShortcuts({ ...DEFAULT_SHORTCUTS, ...(cfg.shortcuts as Partial<Record<ShortcutId, string>>) }))
      .catch(() => {});
  }, []);

  const commitCapture = useCallback((id: ShortcutId, key: string) => {
    setCapturing(null);
    setShortcuts((cur) => {
      const next = { ...cur, [id]: key };
      saveShortcuts(next).catch(() => {});
      return next;
    });
  }, []);

  const resetDefaults = useCallback(() => {
    setCapturing(null);
    setShortcuts(DEFAULT_SHORTCUTS);
    saveShortcuts(DEFAULT_SHORTCUTS).catch(() => {});
  }, []);

  const beginCapture = useCallback((id: ShortcutId) => setCapturing(id), []);
  const cancelCapture = useCallback(() => setCapturing(null), []);

  return (
    <ShortcutsContext.Provider
      value={{ shortcuts, resetDefaults, capturing, beginCapture, cancelCapture, commitCapture }}
    >
      {children}
    </ShortcutsContext.Provider>
  );
}

export function useShortcuts(): ShortcutsContextValue {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) throw new Error('useShortcuts must be used within a ShortcutsProvider');
  return ctx;
}
