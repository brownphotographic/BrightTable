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
