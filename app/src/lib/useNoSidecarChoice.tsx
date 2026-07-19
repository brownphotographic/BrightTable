import { useCallback, useRef, useState } from 'react';
import { cancelArtRoundTrip, finishArtRoundTripWithDefaultProfile, type ArtRoundTripOutcome } from './api';
import NoSidecarDialog from '../components/NoSidecarDialog';

interface PendingChoice {
  jobId: number;
  rawPath: string;
  exportPath: string;
}

// Shared by Viewer.tsx/PhotosBrowser.tsx/FoldersBrowser.tsx's single "Tweak
// RAW Roundtrip" flow (Variant 1 of the ART CLI round trip): `resolve` turns
// launchArtRoundTrip's ArtRoundTripOutcome into the final export file name,
// same as callers used to get back directly from the old bare-string return -
// except when the outcome is `noSidecar` (ART closed with no edit made or
// saved), where it shows NoSidecarDialog and waits for the user's choice
// instead of resolving immediately. Rejects with a clear message if the user
// cancels; a failed "use default profile" retry propagates its own real error
// instead - either way, callers' existing try/catch around the old
// launchArtRoundTrip call handles it exactly like any other launch failure.
export function useNoSidecarChoice() {
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const settleRef = useRef<{ resolve: (name: string) => void; reject: (e: unknown) => void } | null>(null);

  const resolve = useCallback((outcome: ArtRoundTripOutcome): Promise<string> => {
    if (outcome.kind === 'exported') return Promise.resolve(outcome.exportFileName);
    setPending({ jobId: outcome.jobId, rawPath: outcome.rawPath, exportPath: outcome.exportPath });
    return new Promise<string>((res, rej) => {
      settleRef.current = { resolve: res, reject: rej };
    });
  }, []);

  // Deliberately doesn't catch its own rejection - NoSidecarDialog's own
  // try/catch around this same call is what shows the error inline and keeps
  // the dialog open (so the user can still pick Cancel afterward), rather
  // than this hook swallowing it and settling the outer promise early.
  const handlePrimary = useCallback(async () => {
    if (!pending) return;
    const { jobId, rawPath, exportPath } = pending;
    const exportFileName = await finishArtRoundTripWithDefaultProfile(jobId, rawPath, exportPath);
    setPending(null);
    settleRef.current?.resolve(exportFileName);
  }, [pending]);

  const handleSecondary = useCallback(async () => {
    if (!pending) return;
    const { jobId, exportPath } = pending;
    setPending(null);
    await cancelArtRoundTrip(jobId, exportPath).catch(() => {});
    settleRef.current?.reject(new Error('Cancelled — no edits were saved in ART for this photo'));
  }, [pending]);

  const dialog = pending ? <NoSidecarDialog onPrimary={handlePrimary} onSecondary={handleSecondary} /> : null;

  return { resolve, dialog };
}
