import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AssetMetadataPatch, RawConverterKind } from './api';

// What "Copy Image Processing" remembers: enough to call
// pasteImageProcessing (the source's own local/originalPath and a display
// name for entry-point labels/tooltips), not the sidecar's actual contents -
// the backend re-reads every source fresh at paste time (paths::find_all_processing_sources
// runs again then, not just once here). `tools` is display-only for the same
// reason - which tools' settings the paste confirm dialog says it's about to
// apply - fetched fresh at copy time (see handleCopyImageProcessing) rather
// than trusted to still be accurate by the time paste actually runs.
export interface CopiedProcessingSource {
  assetId: string;
  originalPath: string;
  fileName: string;
  tools: RawConverterKind[];
}

interface ClipboardContextValue {
  copiedProcessingSource: CopiedProcessingSource | null;
  setCopiedProcessingSource: (source: CopiedProcessingSource) => void;
  clearCopiedProcessingSource: () => void;
  copiedMetadata: AssetMetadataPatch | null;
  setCopiedMetadata: (patch: AssetMetadataPatch) => void;
  clearCopiedMetadata: () => void;
}

const ClipboardContext = createContext<ClipboardContextValue | null>(null);

// Deliberately in-memory only, never persisted to config.json - this is an
// ephemeral OS-clipboard-style concept (Copy Image Processing / Copy
// Metadata), not a setting, so it resets on every app restart same as a
// real clipboard would once the app that put something there closes.
export function ClipboardProvider({ children }: { children: ReactNode }) {
  const [copiedProcessingSource, setCopiedProcessingSourceState] = useState<CopiedProcessingSource | null>(null);
  const [copiedMetadata, setCopiedMetadataState] = useState<AssetMetadataPatch | null>(null);

  const setCopiedProcessingSource = useCallback((source: CopiedProcessingSource) => {
    setCopiedProcessingSourceState(source);
  }, []);
  const clearCopiedProcessingSource = useCallback(() => setCopiedProcessingSourceState(null), []);

  const setCopiedMetadata = useCallback((patch: AssetMetadataPatch) => {
    setCopiedMetadataState(patch);
  }, []);
  const clearCopiedMetadata = useCallback(() => setCopiedMetadataState(null), []);

  const value = useMemo(
    () => ({
      copiedProcessingSource,
      setCopiedProcessingSource,
      clearCopiedProcessingSource,
      copiedMetadata,
      setCopiedMetadata,
      clearCopiedMetadata,
    }),
    [copiedProcessingSource, setCopiedProcessingSource, clearCopiedProcessingSource, copiedMetadata, setCopiedMetadata, clearCopiedMetadata],
  );

  return <ClipboardContext.Provider value={value}>{children}</ClipboardContext.Provider>;
}

export function useClipboard(): ClipboardContextValue {
  const ctx = useContext(ClipboardContext);
  if (!ctx) throw new Error('useClipboard must be used within a ClipboardProvider');
  return ctx;
}
