import { useCallback, useRef, useState } from 'react';
import { cancelRawCliRoundTrip, finishRawCliRoundTripWithDefaultProfile, type ArtRoundTripOutcome } from './api';
import NoSidecarDialog from '../components/NoSidecarDialog';

interface PendingChoice {
  jobId: number;
  rawPath: string;
  exportPath: string;
}

// Shared by Viewer.tsx/PhotosBrowser.tsx/FoldersBrowser.tsx's single "Tweak
// RAW Roundtrip" flow (Variant 1 of the RAW CLI round trip): `resolve` turns
// launchRawCliRoundTrip's ArtRoundTripOutcome into the id of the ArtQueue job
// now running the export in the background - the caller tracks it via
// useArtJobReconciliation exactly like a Variant 2 job, same as when the
// outcome is `processing` already - except when the outcome is `noSidecar`
// (the editor closed with no edit made or saved), where it shows
// NoSidecarDialog and waits for the user's choice before kicking that job
// off. Rejects with a clear message if the user cancels - callers' existing
// try/catch around the launchRawCliRoundTrip call handles it exactly like any
// other launch failure.
export function useNoSidecarChoice() {
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const settleRef = useRef<{ resolve: (jobId: number) => void; reject: (e: unknown) => void } | null>(null);

  const resolve = useCallback((outcome: ArtRoundTripOutcome): Promise<number> => {
    if (outcome.kind === 'processing') return Promise.resolve(outcome.jobId);
    setPending({ jobId: outcome.jobId, rawPath: outcome.rawPath, exportPath: outcome.exportPath });
    return new Promise<number>((res, rej) => {
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
    await finishRawCliRoundTripWithDefaultProfile(jobId, rawPath, exportPath);
    setPending(null);
    settleRef.current?.resolve(jobId);
  }, [pending]);

  const handleSecondary = useCallback(async () => {
    if (!pending) return;
    const { jobId, exportPath } = pending;
    setPending(null);
    await cancelRawCliRoundTrip(jobId, exportPath).catch(() => {});
    settleRef.current?.reject(new Error('Cancelled — no edits were saved for this photo'));
  }, [pending]);

  const dialog = pending ? <NoSidecarDialog onPrimary={handlePrimary} onSecondary={handleSecondary} /> : null;

  return { resolve, dialog };
}
