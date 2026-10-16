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
import TimeEditDialog from '../components/TimeEditDialog';
import { changeAssetTime, type AssetSummary, type EditJob } from './api';
import { useEditQueue } from './editQueue';
import { recordedTime, formatOffset, type NewTime } from './timeZones';
import { useEditJobReconciliation } from './useEditJobReconciliation';

// Same page integration as Change Lens (lib/lensEdit.tsx): the page hands
// over its own local-patch function, used for the optimistic patch and its
// rollback.
type ApplyPatch = (id: string, patch: Partial<AssetSummary>) => void;

interface OpenArgs {
  assets: AssetSummary[];
  applyPatch: ApplyPatch;
  onError?: (message: string) => void;
}

interface TimeEditContextValue {
  openTimeEditor: (args: OpenArgs) => void;
}

const TimeEditContext = createContext<TimeEditContextValue | null>(null);

export function TimeEditProvider({ children }: { children: ReactNode }) {
  const { jobs } = useEditQueue();
  const [open, setOpen] = useState<OpenArgs | null>(null);
  const rollbackById = useRef(new Map<number, { id: string; prev: Partial<AssetSummary>; args: OpenArgs }>());

  const { trackJobs } = useEditJobReconciliation(jobs, (job: EditJob) => {
    const entry = rollbackById.current.get(job.jobId);
    rollbackById.current.delete(job.jobId);
    if (!entry || job.status !== 'failed') return;
    entry.args.applyPatch(entry.id, entry.prev);
    entry.args.onError?.(job.error ?? 'Change Time failed');
  });

  // `assets` here is everything the dialog lists (stack members included),
  // `times` only the ticked, changed ones.
  const submit = useCallback(
    async (args: OpenArgs, assets: AssetSummary[], times: NewTime[], writeOriginalOnce: boolean) => {
      const byId = new Map(assets.map((a) => [a.id, a]));
      const prevById = new Map<string, Partial<AssetSummary>>();
      for (const t of times) {
        const a = byId.get(t.assetId)!;
        const instantIso = new Date(t.instant).toISOString();
        prevById.set(a.id, { fileCreatedAt: a.fileCreatedAt, localDateTime: a.localDateTime, dateTimeOriginal: a.dateTimeOriginal, timeZone: a.timeZone });
        args.applyPatch(a.id, { fileCreatedAt: instantIso, localDateTime: `${t.local}.000Z`, dateTimeOriginal: instantIso, timeZone: t.zone });
      }
      const targets = times.map((t) => {
        const a = byId.get(t.assetId)!;
        const rec = recordedTime(a);
        return {
          id: a.id,
          originalPath: a.originalPath ?? null,
          local: t.local,
          offset: t.offsetText,
          zoneName: t.zone.startsWith('UTC') && t.zone !== 'UTC' ? null : t.zone,
          current: rec ? `${new Date(Math.floor(rec.wall / 1000) * 1000).toISOString().slice(0, 19)}${rec.offset != null ? formatOffset(rec.offset) : ''}` : null,
        };
      });
      try {
        const jobIds = await changeAssetTime(targets, { writeOriginalOnce });
        jobIds.forEach((jobId, i) => {
          const id = targets[i].id;
          rollbackById.current.set(jobId, { id, prev: prevById.get(id)!, args });
        });
        trackJobs(jobIds);
      } catch (e) {
        for (const [id, prev] of prevById) args.applyPatch(id, prev);
        throw e;
      }
    },
    [trackJobs],
  );

  const openTimeEditor = useCallback((args: OpenArgs) => {
    const assets = args.assets.filter((a) => a.type !== 'VIDEO');
    if (assets.length) setOpen({ ...args, assets });
  }, []);

  return (
    <TimeEditContext.Provider value={{ openTimeEditor }}>
      {children}
      {open && <TimeEditDialog assets={open.assets} onClose={() => setOpen(null)} onSubmit={(assets, times, once) => submit(open, assets, times, once)} />}
    </TimeEditContext.Provider>
  );
}

export function useTimeEdit(): TimeEditContextValue {
  const ctx = useContext(TimeEditContext);
  if (!ctx) throw new Error('useTimeEdit must be used within a TimeEditProvider');
  return ctx;
}
