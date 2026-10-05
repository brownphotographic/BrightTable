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

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import LensEditDialog from '../components/LensEditDialog';
import { changeAssetLens, type AssetSummary, type EditJob, type LensEditRequest } from './api';
import { useEditQueue } from './editQueue';
import { useLensConfig } from './lensConfig';
import { upsertLensNote } from './lenses';
import { useEditJobReconciliation } from './useEditJobReconciliation';

// Each browser page keeps its own asset cache, so the page hands over its
// own local-patch function when opening the dialog - that's the only page
// integration Change Lens needs (the optimistic patch and its rollback both
// run through it, from here).
type ApplyPatch = (id: string, patch: Partial<AssetSummary>) => void;

interface OpenArgs {
  assets: AssetSummary[];
  applyPatch: ApplyPatch;
  onError?: (message: string) => void;
}

interface LensEditContextValue {
  openLensEditor: (args: OpenArgs) => void;
}

const LensEditContext = createContext<LensEditContextValue | null>(null);

export function LensEditProvider({ children }: { children: ReactNode }) {
  const { jobs } = useEditQueue();
  const { lensConfig } = useLensConfig();
  const [open, setOpen] = useState<OpenArgs | null>(null);
  const rollbackById = useRef(new Map<number, { id: string; prev: Partial<AssetSummary>; args: OpenArgs }>());

  const { trackJobs } = useEditJobReconciliation(jobs, (job: EditJob) => {
    const entry = rollbackById.current.get(job.jobId);
    rollbackById.current.delete(job.jobId);
    if (!entry || job.status !== 'failed') return;
    entry.args.applyPatch(entry.id, entry.prev);
    entry.args.onError?.(job.error ?? 'Change Lens failed');
  });

  const submit = useCallback(
    async (args: OpenArgs, request: LensEditRequest) => {
      const effectiveFocal = request.focalLength ?? (request.lens.focalMin > 0 && request.lens.focalMin === request.lens.focalMax ? request.lens.focalMin : null);
      const prevById = new Map<string, Partial<AssetSummary>>();
      for (const a of args.assets) {
        const patch: Partial<AssetSummary> = {};
        const prev: Partial<AssetSummary> = {};
        if (request.applyLens) {
          patch.lensModel = request.lens.model;
          prev.lensModel = a.lensModel;
          if (effectiveFocal != null) {
            patch.focalLength = effectiveFocal;
            prev.focalLength = a.focalLength;
          }
          if (request.fNumber != null) {
            patch.fNumber = request.fNumber;
            prev.fNumber = a.fNumber;
          }
        }
        if (request.addNote) {
          patch.description = upsertLensNote(a.description ?? '', lensConfig.notePrefix, request.lens.model);
          prev.description = a.description;
        }
        prevById.set(a.id, prev);
        args.applyPatch(a.id, patch);
      }
      const targets = args.assets.map((a) => ({
        id: a.id,
        originalPath: a.originalPath ?? null,
        make: a.make,
        model: a.model,
        lensModel: a.lensModel,
        description: a.description,
      }));
      try {
        const jobIds = await changeAssetLens(targets, request);
        jobIds.forEach((jobId, i) => {
          const id = args.assets[i].id;
          rollbackById.current.set(jobId, { id, prev: prevById.get(id)!, args });
        });
        trackJobs(jobIds);
      } catch (e) {
        for (const [id, prev] of prevById) args.applyPatch(id, prev);
        throw e;
      }
    },
    [lensConfig.notePrefix, trackJobs],
  );

  const openLensEditor = useCallback((args: OpenArgs) => {
    if (args.assets.length) setOpen(args);
  }, []);

  return (
    <LensEditContext.Provider value={{ openLensEditor }}>
      {children}
      {open && <LensEditDialog assets={open.assets} onClose={() => setOpen(null)} onSubmit={(request) => submit(open, request)} />}
    </LensEditContext.Provider>
  );
}

export function useLensEdit(): LensEditContextValue {
  const ctx = useContext(LensEditContext);
  if (!ctx) throw new Error('useLensEdit must be used within a LensEditProvider');
  return ctx;
}
