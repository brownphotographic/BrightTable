import { useEffect, useState, type CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useApplications } from '../lib/applications';
import AppPickerDialog from '../components/AppPickerDialog';
import type { AppChoice, RawConverterKind } from '../lib/api';

// One entry per RAW converter's own settings block below - label, the
// binary this build actually shells out to, the file-browse dialog title,
// and whether it has a working CLI round trip yet. All three do: darktable's
// processing history lives inside the same .xmp sidecar already used for
// rating/description, so its roundtrip detects edits via a surgical read of
// that file's darktable history stack rather than a plain sidecar-exists
// check (see requirements.md §1.6/§2.4).
const TOOL_META: Record<RawConverterKind, { label: string; binary: string; browseTitle: string; implemented: boolean; docsUrl: string }> = {
  art: {
    label: 'ART',
    binary: 'ART-cli',
    browseTitle: 'Choose the ART-cli binary',
    implemented: true,
    docsUrl: 'https://bitbucket.org/agriggio/art/',
  },
  rawtherapee: {
    label: 'RawTherapee',
    binary: 'rawtherapee-cli',
    browseTitle: 'Choose the rawtherapee-cli binary',
    implemented: true,
    docsUrl: 'https://rawtherapee.com/',
  },
  darktable: {
    label: 'DarkTable',
    binary: 'darktable-cli',
    browseTitle: 'Choose the darktable-cli binary',
    implemented: true,
    docsUrl: 'https://www.darktable.org/',
  },
};

const TOOL_ORDER: RawConverterKind[] = ['art', 'rawtherapee', 'darktable'];

// What the "RAW Editor & Roundtrip" heading's info tooltip explains - kept
// as a hover tooltip rather than its own always-visible heading/paragraph
// (the previous layout) since the section below is now self-explanatory
// enough (each tool's own app + CLI path, an active-converter selector) not
// to need a permanent block of prose above it.
const RAW_ROUNDTRIP_INFO =
  'Each RAW converter below owns its own GUI app and CLI path together - the app is what "Open in RAW Editor"/' +
  '"Tweak RAW Roundtrip" launches and waits on; once its CLI binary is also configured and this converter is ' +
  'selected as active, that same action then runs the CLI to produce the export deterministically - no more ' +
  'manually exporting inside the editor’s own UI. A "Headless RAW Roundtrip" action also becomes available ' +
  'for exporting one or more RAW photos straight through the CLI, with no editor UI involved at all. Each ' +
  "tool's own settings are saved independently, so switching the active converter never loses the others'.";

// Which app picker is currently open - 'externalEditor', a specific RAW
// converter (its own GUI app, paired with that tool's own CLI path right
// below it - see ApplicationsConfig's own doc comment for why the two are
// no longer a single shared `rawEditor` picked separately from the CLI),
// or none.
type PickerTarget = 'externalEditor' | RawConverterKind;

export default function PreferencesApplications() {
  const {
    applications,
    setExternalEditor,
    setToolApp,
    setToolCliPath,
    setActiveRawConverter,
    setExiftoolPath,
    exiftoolConfigured,
  } = useApplications();
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [cliBrowseError, setCliBrowseError] = useState<string | null>(null);
  const [exiftoolBrowseError, setExiftoolBrowseError] = useState<string | null>(null);

  function handlePick(choice: AppChoice) {
    if (pickerTarget === 'externalEditor') setExternalEditor(choice);
    else if (pickerTarget) setToolApp(pickerTarget, choice);
    setPickerTarget(null);
  }

  async function browseForCli(tool: RawConverterKind) {
    setCliBrowseError(null);
    try {
      const path = await open({ multiple: false, directory: false, title: TOOL_META[tool].browseTitle });
      if (!path || typeof path !== 'string') return;
      setToolCliPath(tool, path);
    } catch (e) {
      setCliBrowseError(String(e));
    }
  }

  async function browseForExiftool() {
    setExiftoolBrowseError(null);
    try {
      const path = await open({ multiple: false, directory: false, title: 'Choose the exiftool binary' });
      if (!path || typeof path !== 'string') return;
      setExiftoolPath(path);
    } catch (e) {
      setExiftoolBrowseError(String(e));
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 0' }}>
      <div style={{ fontSize: 14, fontWeight: 700, margin: '0 4px 12px' }}>Metadata</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 16px', lineHeight: 1.5 }}>
        Used by Export to Folder/Share to Flickr's "Keep all metadata" and "Remove GPS only" options - "Strip all
        metadata" needs no configuration. Get{' '}
        <a href="https://exiftool.org/" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
          exiftool
        </a>{' '}
        and point this at the binary.
      </div>
      <div style={panel}>
        <div style={row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>exiftool path</div>
            <div style={{ fontSize: 12, marginTop: 6, color: exiftoolConfigured ? 'var(--text)' : 'var(--text-dimmer)' }}>
              {exiftoolConfigured ? applications.exiftoolPath : 'Not configured'}
            </div>
          </div>
          <button onClick={browseForExiftool} style={btnSecondary}>
            Browse…
          </button>
          {exiftoolConfigured && (
            <button onClick={() => setExiftoolPath('')} style={{ ...btnSecondary, marginLeft: 8 }}>
              Clear
            </button>
          )}
        </div>
        {exiftoolBrowseError && (
          <div style={{ padding: '0 16px 13px', fontSize: 12, color: 'var(--danger)' }}>{exiftoolBrowseError}</div>
        )}
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '24px 4px 12px' }}>External Editor</div>
      <div style={panel}>
        <div style={row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>External Editor</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', marginTop: 2 }}>Used for all other image formats.</div>
            <div style={{ fontSize: 12, marginTop: 6, color: applications.externalEditor ? 'var(--text)' : 'var(--text-dimmer)' }}>
              {applications.externalEditor ? applications.externalEditor.name : 'No application chosen'}
            </div>
            {applications.externalEditor && <div style={execText}>{applications.externalEditor.exec}</div>}
            {applications.externalEditor && (
              <ExtraArgsRow
                choice={applications.externalEditor}
                onCommit={(extraArgs) => setExternalEditor({ ...applications.externalEditor!, extraArgs })}
              />
            )}
          </div>
          <button onClick={() => setPickerTarget('externalEditor')} style={btnSecondary}>
            Change…
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '24px 4px 12px' }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>RAW Editor & Roundtrip</div>
        <InfoTooltip text={RAW_ROUNDTRIP_INFO} />
      </div>

      <div style={{ ...panel, marginBottom: 16 }}>
        <div style={{ ...row, gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13.5, color: 'var(--text-dim)', marginRight: 4 }}>Active converter</div>
          <div style={{ display: 'flex', gap: 3, background: 'var(--surface-sunken)', padding: 3, borderRadius: 10 }}>
            {(['none', ...TOOL_ORDER] as const).map((opt) => {
              const active = opt === 'none' ? applications.activeRawConverter === null : applications.activeRawConverter === opt;
              return (
                <div
                  key={opt}
                  onClick={() => setActiveRawConverter(opt === 'none' ? null : opt)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: 12.5,
                    cursor: 'default',
                    background: active ? '#3584e4' : 'transparent',
                    color: active ? '#fff' : 'var(--text-dim)',
                  }}
                >
                  {opt === 'none' ? 'None' : TOOL_META[opt].label}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {TOOL_ORDER.map((tool, i) => {
        const config = applications[tool];
        const isActive = applications.activeRawConverter === tool;
        return (
          <div key={tool} style={{ marginTop: i === 0 ? 0 : 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 4px 8px' }}>
              <a
                href={TOOL_META[tool].docsUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13, fontWeight: 600, color: isActive ? 'var(--text)' : 'var(--text-dim)' }}
              >
                {TOOL_META[tool].label}
              </a>
              {isActive && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#3584e4', flexShrink: 0 }} />}
              {!TOOL_META[tool].implemented && (
                <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
                  - CLI roundtrip isn't implemented yet; settings are saved but selecting it as active leaves the roundtrip buttons on the
                  plain launch-only flow.
                </span>
              )}
            </div>

            <div style={{ ...panel, marginBottom: 10 }}>
              <div style={row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>Desktop App</div>
                  <div style={{ fontSize: 12, marginTop: 6, color: config.app ? 'var(--text)' : 'var(--text-dimmer)' }}>
                    {config.app ? config.app.name : 'No application chosen'}
                  </div>
                  {config.app && <div style={execText}>{config.app.exec}</div>}
                  {config.app && (
                    <ExtraArgsRow
                      choice={config.app}
                      onCommit={(extraArgs) => setToolApp(tool, { ...config.app!, extraArgs })}
                      placeholder={tool === 'art' ? 'e.g. -s (Simple editor mode)' : undefined}
                    />
                  )}
                </div>
                <button onClick={() => setPickerTarget(tool)} style={btnSecondary}>
                  Change…
                </button>
              </div>
            </div>

            <div style={panel}>
              <div style={row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>{TOOL_META[tool].binary} path</div>
                  <div style={{ fontSize: 12, marginTop: 6, color: config.cliPath ? 'var(--text)' : 'var(--text-dimmer)' }}>
                    {config.cliPath || 'Not configured'}
                  </div>
                </div>
                <button onClick={() => browseForCli(tool)} style={btnSecondary}>
                  Browse…
                </button>
                {config.cliPath && (
                  <button onClick={() => setToolCliPath(tool, '')} style={{ ...btnSecondary, marginLeft: 8 }}>
                    Clear
                  </button>
                )}
              </div>
              {cliBrowseError && (
                <div style={{ padding: '0 16px 13px', fontSize: 12, color: 'var(--danger)' }}>{cliBrowseError}</div>
              )}
            </div>
          </div>
        );
      })}

      {pickerTarget && (
        <AppPickerDialog
          roleLabel={pickerTarget === 'externalEditor' ? 'External Editor' : TOOL_META[pickerTarget].label}
          onClose={() => setPickerTarget(null)}
          onPick={handlePick}
        />
      )}
    </div>
  );
}

// A small "i" glyph that shows `text` on hover - the plain native `title`
// attribute this app already uses everywhere for hover hints (e.g.
// AssetTile.tsx's unsyncedMetadataTooltip), just wrapped in a fixed-size
// circle so it reads as a deliberate "more info" affordance next to a
// heading rather than a stray title on the heading text itself. No custom
// hover-popover component exists anywhere else in this app to reuse -
// this is the simplest thing consistent with that existing convention.
function InfoTooltip({ text }: { text: string }) {
  return (
    <span
      title={text}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 15,
        height: 15,
        borderRadius: '50%',
        fontSize: 10.5,
        fontWeight: 700,
        fontStyle: 'italic',
        color: 'var(--text-dimmer)',
        border: '1px solid var(--text-dimmer)',
        cursor: 'default',
        flexShrink: 0,
      }}
    >
      i
    </span>
  );
}

// Local draft state so every keystroke doesn't trigger a save - only commits
// (via useApplications' setExternalEditor/setToolApp, which persist
// immediately) on blur. `placeholder` is caller-supplied and optional -
// deliberately left unset (rather than some "(none)"/"not supported" filler)
// for every app except ART: placeholder text sitting inside an already-empty
// input reads as an instruction ("type this"), which is exactly backwards
// for a field that should just stay empty. ART's own GUI is the only one of
// these apps where `-s` (Simple editor mode) is a real, useful example worth
// showing. RawTherapee's GUI binary shares its argument grammar with
// `rawtherapee-cli` and has no such flag - a generic "-s" placeholder here
// previously led straight to a real bug (confirmed live): pasting `-s` into
// RawTherapee's Desktop App entry makes the GUI print its usage text and
// exit instantly instead of opening, which `apps::launch_app_and_wait` (any
// exit counts as "done") then silently treats as "the user finished
// editing" - the round trip proceeds straight to the CLI conversion with no
// visible editor window ever appearing.
function ExtraArgsRow({ choice, onCommit, placeholder }: { choice: AppChoice; onCommit: (extraArgs: string) => void; placeholder?: string }) {
  const [value, setValue] = useState(choice.extraArgs);

  useEffect(() => setValue(choice.extraArgs), [choice.exec, choice.extraArgs]);

  return (
    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)', flexShrink: 0 }}>Extra args</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value !== choice.extraArgs) onCommit(value);
        }}
        placeholder={placeholder}
        style={argsInput}
      />
    </div>
  );
}

const panel: CSSProperties = {
  background: 'var(--panel)',
  borderRadius: 13,
  overflow: 'hidden',
  border: '1px solid var(--border)',
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '13px 16px',
};

const execText: CSSProperties = {
  font: '500 11px ui-monospace,monospace',
  color: 'var(--text-dimmer)',
  marginTop: 2,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const argsInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 26,
  padding: '0 8px',
  background: 'var(--surface-sunken)',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  color: 'var(--text)',
  font: '500 11px ui-monospace,monospace',
};

const btnSecondary: CSSProperties = {
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  fontSize: 12.5,
  cursor: 'default',
  border: '1px solid var(--border-strong)',
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
  flexShrink: 0,
};
