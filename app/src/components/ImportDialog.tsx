import { useEffect, useState, type CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  getConfig,
  listRemovableVolumes,
  saveImportSettings,
  scanImportSource,
  startImport,
  type CaptureTime,
  type FolderDepth,
  type ImportScanSummary,
  type RemovableVolume,
} from '../lib/api';

type Step = 'source' | 'summary';

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function filenameStem(ct: CaptureTime): string {
  return `${pad(ct.year, 4)}${pad(ct.month, 2)}${pad(ct.day, 2)}_${pad(ct.hour, 2)}-${pad(ct.minute, 2)}-${pad(ct.second, 2)}`;
}

function nowAsCaptureTime(): CaptureTime {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
}

// Mirrors naming.rs's dest_dir/filename_stem exactly - shown live in the
// summary step so the actual convention (not just the "Flat"/"Year / Month"
// labels) is visible before the user commits, and updates as they toggle
// the folder-layout choice.
function exampleDestPath(localRoot: string, depth: FolderDepth, ct: CaptureTime, extension: string): string {
  const dir = depth === 'flat' ? localRoot : `${localRoot}/${pad(ct.year, 4)}/${pad(ct.year, 4)}_${pad(ct.month, 2)}`;
  return `${dir}/${filenameStem(ct)}.${extension}`;
}

// v1, "curated subset" scope (see the plan file): pick a source, see a scan
// summary (counts only, no per-file thumbnail/checkbox grid), one Import
// button. Progress after that lives in the shared Activity UI, not here -
// this dialog closes as soon as the copy jobs are enqueued.
export default function ImportDialog({
  onClose,
  onOpenLibraryPreferences,
}: {
  onClose: () => void;
  onOpenLibraryPreferences: () => void;
}) {
  const [step, setStep] = useState<Step>('source');
  const [libraryReady, setLibraryReady] = useState<boolean | null>(null);
  const [localRoot, setLocalRoot] = useState('');
  const [volumes, setVolumes] = useState<RemovableVolume[]>([]);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [folderDepth, setFolderDepth] = useState<FolderDepth>('yearMonth');
  const [maxConcurrentJobs, setMaxConcurrentJobs] = useState(2);
  const [summary, setSummary] = useState<ImportScanSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRemovableVolumes().then(setVolumes).catch(() => {});
    getConfig()
      .then((cfg) => {
        setFolderDepth(cfg.import.folderDepth);
        setMaxConcurrentJobs(cfg.import.maxConcurrentJobs);
        setLocalRoot(cfg.library.localRoot);
        setLibraryReady(cfg.library.localRoot.trim().length > 0);
      })
      .catch(() => setLibraryReady(false));
  }, []);

  async function scan(path: string) {
    setSourcePath(path);
    setScanning(true);
    setError(null);
    try {
      const result = await scanImportSource(path);
      setSummary(result);
      setStep('summary');
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function browse() {
    setError(null);
    try {
      const picked = await open({ directory: true, title: 'Choose a source folder to import from' });
      if (picked && typeof picked === 'string') await scan(picked);
    } catch (e) {
      setError(String(e));
    }
  }

  function changeFolderDepth(v: FolderDepth) {
    setFolderDepth(v);
    saveImportSettings({ folderDepth: v, lastSourcePath: sourcePath, maxConcurrentJobs }).catch(() => {});
  }

  function changeMaxConcurrentJobs(v: number) {
    setMaxConcurrentJobs(v);
    saveImportSettings({ folderDepth, lastSourcePath: sourcePath, maxConcurrentJobs: v }).catch(() => {});
  }

  const filesToCopy = summary ? summary.groups.filter((g) => !g.alreadyImported).reduce((n, g) => n + g.files.length, 0) : 0;

  // Representative of what will actually be copied (falls back to any
  // scanned group, then to "now", so the preview still shows something
  // sensible even for an all-already-imported or empty scan).
  const exampleGroup = summary?.groups.find((g) => !g.alreadyImported) ?? summary?.groups[0];
  const exampleCt = exampleGroup?.captureTime ?? nowAsCaptureTime();
  const exampleExt = exampleGroup?.files[0]?.extension ?? 'JPG';
  const destinationPreview = localRoot ? exampleDestPath(localRoot, folderDepth, exampleCt, exampleExt) : null;

  async function doImport() {
    if (!summary) return;
    setStarting(true);
    setError(null);
    try {
      await startImport(summary.groups, folderDepth);
      await saveImportSettings({ folderDepth, lastSourcePath: sourcePath, maxConcurrentJobs }).catch(() => {});
      onClose();
    } catch (e) {
      setError(String(e));
      setStarting(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={dialog}>
        <div style={header}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Import from SD Card/Disk</div>
          <div onClick={onClose} style={closeBtn}>
            <div style={closeLine1} />
            <div style={closeLine2} />
          </div>
        </div>

        <div style={{ padding: '0 20px 20px' }}>
          {libraryReady === false ? (
            <div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                Import needs an External Library local mount configured first, so copied files land somewhere
                Immich can actually find them.
              </div>
              <button onClick={onOpenLibraryPreferences} style={{ ...btnPrimary, marginTop: 14 }}>
                Open Preferences → Library
              </button>
            </div>
          ) : step === 'source' ? (
            scanning ? (
              <div style={{ padding: '34px 10px 20px', textAlign: 'center' }}>
                <div style={spinnerLarge} />
                <div style={{ marginTop: 14, fontSize: 13.5, fontWeight: 600 }}>Scanning source…</div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dimmer)', lineHeight: 1.5 }}>
                  This can take a while for a large card or a slow USB reader — every file gets checked and
                  hashed. Please keep this window open; it hasn't frozen.
                </div>
              </div>
            ) : (
              <>
                {volumes.length > 0 && (
                  <>
                    <div style={sectionLabel}>Detected removable volumes</div>
                    {volumes.map((v) => (
                      <div key={v.mountPoint} onClick={() => scan(v.mountPoint)} style={volumeRow}>
                        <div style={{ fontSize: 13.5, color: '#fff' }}>{v.name}</div>
                        <div style={execText}>{v.mountPoint}</div>
                      </div>
                    ))}
                    <Divider />
                  </>
                )}
                <button onClick={browse} style={{ ...btnPrimary, marginTop: 14 }}>
                  Browse…
                </button>
                {error && <div style={errorText}>{error}</div>}
              </>
            )
          ) : summary ? (
            <>
              <SummaryRow label="New items" value={summary.newCount} />
              <SummaryRow label="Already imported (skipped)" value={summary.alreadyImportedCount} />
              <SummaryRow label="RAW+JPEG pairs found" value={summary.pairedCount} />
              <SummaryRow label="Total files scanned" value={summary.totalFiles} />

              <div style={{ marginTop: 18 }}>
                <div style={sectionLabel}>Folder layout</div>
                <Segmented
                  value={folderDepth}
                  onChange={changeFolderDepth}
                  options={[
                    { value: 'flat', label: 'Flat' },
                    { value: 'yearMonth', label: 'Year / Month' },
                  ]}
                />
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-dimmer)', lineHeight: 1.5 }}>
                  Files are renamed <code>yyyymmdd_hh-mm-ss.ext</code> by capture date. RAW+JPEG pairs keep the
                  same name (different extension). "Year / Month" additionally nests them under
                  <code> yyyy/yyyy_mm/</code>.
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={sectionLabel}>Concurrent copies</div>
                <Segmented
                  value={maxConcurrentJobs}
                  onChange={changeMaxConcurrentJobs}
                  options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
                />
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-dimmer)', lineHeight: 1.5 }}>
                  How many files copy at once. Lower is safer on a slow or flaky link (less contention if it
                  drops mid-import). Applies next time you start ImmAture, not to an import already running.
                </div>
              </div>

              {destinationPreview && (
                <div style={{ marginTop: 14 }}>
                  <div style={sectionLabel}>Destination (example)</div>
                  <div style={destinationBox}>{destinationPreview}</div>
                </div>
              )}

              {error && <div style={errorText}>{error}</div>}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
                <button onClick={() => setStep('source')} disabled={starting} style={btnSecondary}>
                  Back
                </button>
                <button onClick={doImport} disabled={starting || filesToCopy === 0} style={btnPrimary}>
                  {starting ? 'Starting…' : `Import ${filesToCopy} file${filesToCopy === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={summaryRow}>
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{value}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '10px 0' }} />;
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {options.map((o) => (
        <div
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: '5px 11px',
            borderRadius: 7,
            fontSize: 12.5,
            cursor: 'default',
            background: value === o.value ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
            color: value === o.value ? '#fff' : 'rgba(255,255,255,0.7)',
          }}
        >
          {o.label}
        </div>
      ))}
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 310,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const dialog: CSSProperties = {
  width: 460,
  maxWidth: '90%',
  maxHeight: '80%',
  background: '#242424',
  borderRadius: 14,
  boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
  border: '1px solid rgba(255,255,255,0.08)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'auto',
  color: '#fff',
};

const header: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  padding: '18px 20px 14px',
};

const closeBtn: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.08)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'default',
  position: 'relative',
  flexShrink: 0,
};

const closeLine1: CSSProperties = {
  position: 'absolute',
  width: 11,
  height: 1.6,
  background: '#fff',
  transform: 'rotate(45deg)',
  borderRadius: 1,
};

const closeLine2: CSSProperties = { ...closeLine1, transform: 'rotate(-45deg)' };

const sectionLabel: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  color: 'var(--text-dimmer)',
  textTransform: 'uppercase',
  letterSpacing: '.03em',
  marginBottom: 8,
};

const volumeRow: CSSProperties = {
  padding: '9px 12px',
  borderRadius: 8,
  cursor: 'default',
  background: 'rgba(255,255,255,0.05)',
  marginBottom: 6,
};

const execText: CSSProperties = {
  font: '500 11px ui-monospace,monospace',
  color: 'var(--text-dimmer)',
  marginTop: 2,
};

const summaryRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '7px 0',
  borderBottom: '1px solid var(--border)',
};

const errorText: CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  color: 'var(--danger)',
  lineHeight: 1.4,
};

const spinnerLarge: CSSProperties = {
  width: 28,
  height: 28,
  margin: '0 auto',
  borderRadius: '50%',
  border: '3px solid rgba(255,255,255,0.15)',
  borderTopColor: '#9cc2f0',
  animation: 'immature-spin 0.8s linear infinite',
};

const destinationBox: CSSProperties = {
  font: '500 11.5px ui-monospace,monospace',
  color: '#9cc2f0',
  background: 'rgba(53,132,228,0.12)',
  border: '1px solid rgba(53,132,228,0.3)',
  borderRadius: 8,
  padding: '8px 10px',
  wordBreak: 'break-all',
  lineHeight: 1.4,
};

const btnBase: CSSProperties = {
  height: 34,
  padding: '0 16px',
  borderRadius: 9,
  fontSize: 13,
  cursor: 'default',
  border: 'none',
};

const btnSecondary: CSSProperties = {
  ...btnBase,
  border: '1px solid rgba(255,255,255,0.16)',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
};

const btnPrimary: CSSProperties = {
  ...btnBase,
  background: 'var(--accent)',
  color: '#fff',
  fontWeight: 700,
};
