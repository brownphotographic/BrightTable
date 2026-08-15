import { useEffect, useState, type CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  checkImportDuplicates,
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

// yyyy-mm-dd - directly comparable as strings.
function captureDateStr(ct: CaptureTime): string {
  return `${pad(ct.year, 4)}-${pad(ct.month, 2)}-${pad(ct.day, 2)}`;
}

// e.g. "Jul 25, 2026" - for the date-range dropdowns below.
function formatDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // Result of checkImportDuplicates for the current date range - null means
  // "not checked yet" (or the range changed since the last check, see
  // changeDateFrom/changeDateTo below). Hashing is deferred until this
  // point specifically so it only ever runs over the range the user
  // actually wants, not the whole card.
  const [checkedSummary, setCheckedSummary] = useState<ImportScanSummary | null>(null);
  const [checking, setChecking] = useState(false);

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
    setDateFrom('');
    setDateTo('');
    setCheckedSummary(null);
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

  // Only the dates actually present in this scan - shown as dropdowns
  // rather than a free-form calendar. A native <input type="date">'s popup
  // calendar doesn't reliably dismiss on outside-click in the Tauri
  // webview (confirmed live - it stays open and swallows clicks), and it'd
  // let you pick a date with zero photos on it anyway; a plain dropdown of
  // real options sidesteps both problems.
  const distinctDates = summary ? Array.from(new Set(summary.groups.map((g) => captureDateStr(g.captureTime)))).sort() : [];

  // Keeps the range from ever inverting (from > to) instead of silently
  // producing a zero-result filter - picking a "to" earlier than the
  // current "from" pulls "from" down to match, and vice versa. Either way,
  // a range change invalidates any prior duplicate check - the newly
  // included/excluded files haven't been hashed against this range.
  function changeDateFrom(v: string) {
    setDateFrom(v);
    if (v && dateTo && v > dateTo) setDateTo(v);
    setCheckedSummary(null);
  }
  function changeDateTo(v: string) {
    setDateTo(v);
    if (v && dateFrom && v < dateFrom) setDateFrom(v);
    setCheckedSummary(null);
  }
  function clearDateRange() {
    setDateFrom('');
    setDateTo('');
    setCheckedSummary(null);
  }

  function inDateRange(g: { captureTime: CaptureTime }): boolean {
    const d = captureDateStr(g.captureTime);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  }

  // Everything in the selected range, dedupe status unknown until checked
  // (hashing hasn't run yet - see scanImportSource's own doc comment).
  const groupsInRange = summary ? summary.groups.filter(inDateRange) : [];
  const dateFilterActive = dateFrom !== '' || dateTo !== '';

  // Only meaningful once checkedSummary exists - that's the hashed result,
  // scoped to exactly the range that was checked.
  const groupsToImport = checkedSummary ? checkedSummary.groups.filter((g) => !g.alreadyImported) : [];
  const filesToCopy = groupsToImport.reduce((n, g) => n + g.files.length, 0);

  // Representative of what will actually be copied (falls back through
  // progressively less-specific groups, then to "now", so the preview
  // still shows something sensible at every stage: pre-check, post-check
  // with nothing new, or an empty scan).
  const exampleGroup = groupsToImport[0] ?? groupsInRange[0] ?? summary?.groups[0];
  const exampleCt = exampleGroup?.captureTime ?? nowAsCaptureTime();
  const exampleExt = exampleGroup?.files[0]?.extension ?? 'JPG';
  const destinationPreview = localRoot ? exampleDestPath(localRoot, folderDepth, exampleCt, exampleExt) : null;

  async function checkDuplicates() {
    if (groupsInRange.length === 0) return;
    setChecking(true);
    setError(null);
    try {
      const result = await checkImportDuplicates(groupsInRange);
      setCheckedSummary(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }

  async function doImport() {
    if (!checkedSummary) return;
    setStarting(true);
    setError(null);
    try {
      await startImport(groupsToImport, folderDepth);
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
              <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
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
                  This can take a while for a large card or a slow USB reader — every file gets checked for
                  its capture date. Please keep this window open; it hasn't frozen.
                </div>
              </div>
            ) : (
              <>
                {volumes.length > 0 && (
                  <>
                    <div style={sectionLabel}>Detected removable volumes</div>
                    {volumes.map((v) => (
                      <div key={v.mountPoint} onClick={() => scan(v.mountPoint)} style={volumeRow}>
                        <div style={{ fontSize: 13.5, color: 'var(--text)' }}>{v.name}</div>
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
              <SummaryRow label="Total files scanned" value={summary.totalFiles} />
              <SummaryRow label="RAW+JPEG pairs found" value={summary.pairedCount} />
              {checkedSummary ? (
                <>
                  <SummaryRow label="New items in range" value={checkedSummary.newCount} />
                  <SummaryRow label="Already imported (skipped)" value={checkedSummary.alreadyImportedCount} />
                </>
              ) : (
                <SummaryRow label="Items in range (not checked yet)" value={groupsInRange.length} />
              )}

              <div style={{ marginTop: 18 }}>
                <div style={sectionLabel}>Only import this date range</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <select value={dateFrom} onChange={(e) => changeDateFrom(e.target.value)} style={dateSelect}>
                    <option value="">Any</option>
                    {distinctDates.map((d) => (
                      <option key={d} value={d}>
                        {formatDateLabel(d)}
                      </option>
                    ))}
                  </select>
                  <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>to</span>
                  <select value={dateTo} onChange={(e) => changeDateTo(e.target.value)} style={dateSelect}>
                    <option value="">Any</option>
                    {distinctDates.map((d) => (
                      <option key={d} value={d}>
                        {formatDateLabel(d)}
                      </option>
                    ))}
                  </select>
                  {dateFilterActive && (
                    <button onClick={clearDateRange} style={btnSecondary}>
                      Clear
                    </button>
                  )}
                </div>
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-dimmer)', lineHeight: 1.5 }}>
                  Narrowing the range before checking means only files actually in play get hashed against
                  your library - much faster than checking the whole card. Filters by capture date, not file
                  date.
                </div>
              </div>

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
                  drops mid-import). Applies next time you start BrightTable, not to an import already running.
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
                <button onClick={() => setStep('source')} disabled={starting || checking} style={btnSecondary}>
                  Back
                </button>
                {checkedSummary ? (
                  <button onClick={doImport} disabled={starting || filesToCopy === 0} style={btnPrimary}>
                    {starting ? 'Starting…' : `Import ${filesToCopy} file${filesToCopy === 1 ? '' : 's'}`}
                  </button>
                ) : (
                  <button onClick={checkDuplicates} disabled={checking || groupsInRange.length === 0} style={btnPrimary}>
                    {checking
                      ? 'Checking…'
                      : `Check ${groupsInRange.length} file${groupsInRange.length === 1 ? '' : 's'} for duplicates`}
                  </button>
                )}
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
      <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{value}</span>
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
            background: value === o.value ? 'var(--accent)' : 'var(--overlay-weak)',
            color: value === o.value ? '#fff' : 'var(--text-dim)',
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
  background: 'var(--dialog-bg)',
  borderRadius: 14,
  boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'auto',
  color: 'var(--text)',
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
  background: 'var(--overlay-medium)',
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
  background: 'var(--text)',
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
  background: 'var(--overlay-weak)',
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
  border: '3px solid var(--border-strong)',
  borderTopColor: 'var(--accent-text)',
  animation: 'brighttable-spin 0.8s linear infinite',
};

const dateSelect: CSSProperties = {
  height: 30,
  padding: '0 8px',
  borderRadius: 7,
  fontSize: 12.5,
  border: '1px solid var(--border-strong)',
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
  cursor: 'default',
};

const destinationBox: CSSProperties = {
  font: '500 11.5px ui-monospace,monospace',
  color: 'var(--accent-text)',
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
  border: '1px solid var(--border-strong)',
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
};

const btnPrimary: CSSProperties = {
  ...btnBase,
  background: 'var(--accent)',
  color: '#fff',
  fontWeight: 700,
};
