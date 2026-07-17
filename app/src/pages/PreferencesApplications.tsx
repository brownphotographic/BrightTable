import { useEffect, useState, type CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useApplications } from '../lib/applications';
import AppPickerDialog from '../components/AppPickerDialog';
import type { AppChoice } from '../lib/api';

type Role = 'rawEditor' | 'externalEditor';

const ROLE_LABEL: Record<Role, string> = { rawEditor: 'RAW Editor', externalEditor: 'External Editor' };
const ROLE_HELP: Record<Role, string> = {
  rawEditor: 'Used for RAW formats (ARW, CR3, NEF, DNG…).',
  externalEditor: 'Used for all other image formats.',
};

export default function PreferencesApplications() {
  const { applications, setEditor, setArtCliPath, artRoundTripEnabled } = useApplications();
  const [pickerRole, setPickerRole] = useState<Role | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);

  function handlePick(choice: AppChoice) {
    if (pickerRole) setEditor(pickerRole, choice);
    setPickerRole(null);
  }

  async function browseForArtCli() {
    setBrowseError(null);
    try {
      const path = await open({ multiple: false, directory: false, title: 'Choose the ART-cli binary' });
      if (!path || typeof path !== 'string') return;
      setArtCliPath(path);
    } catch (e) {
      setBrowseError(String(e));
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 0' }}>
      <div style={{ fontSize: 14, fontWeight: 700, margin: '0 4px 12px' }}>Applications</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 16px', lineHeight: 1.5 }}>
        Choose which application opens when you click "Open in RAW Editor"/"Open in Ext. Editor" in the
        photo viewer.
      </div>
      <div style={panel}>
        {(['rawEditor', 'externalEditor'] as Role[]).map((role, i) => {
          const choice = applications[role];
          return (
            <div key={role}>
              <div style={row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>{ROLE_LABEL[role]}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', marginTop: 2 }}>{ROLE_HELP[role]}</div>
                  <div style={{ fontSize: 12, marginTop: 6, color: choice ? '#fff' : 'var(--text-dimmer)' }}>
                    {choice ? choice.name : 'No application chosen'}
                  </div>
                  {choice && <div style={execText}>{choice.exec}</div>}
                  {choice && (
                    <ExtraArgsRow
                      choice={choice}
                      onCommit={(extraArgs) => setEditor(role, { ...choice, extraArgs })}
                    />
                  )}
                </div>
                <button onClick={() => setPickerRole(role)} style={btnSecondary}>
                  Change…
                </button>
              </div>
              {i === 0 && <Divider />}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '24px 4px 12px' }}>ART CLI Round Trip</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 16px', lineHeight: 1.5 }}>
        Requires the RAW Editor above to actually be{' '}
        <a href="https://bitbucket.org/agriggio/art/" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
          ART
        </a>{' '}
        (the RawTherapee fork). When its <code>ART-cli</code> binary is configured here, "Open in RAW Editor" opens
        ART itself, waits for you to finish, then runs <code>ART-cli</code> to produce the export deterministically -
        no more manually exporting inside ART's own UI. A "Batch RAW Roundtrip" action also becomes available for
        exporting several RAW photos headlessly at once.
      </div>
      <div style={panel}>
        <div style={row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>ART-cli path</div>
            <div style={{ fontSize: 12, marginTop: 6, color: artRoundTripEnabled ? '#fff' : 'var(--text-dimmer)' }}>
              {artRoundTripEnabled ? applications.artCliPath : 'Not configured'}
            </div>
          </div>
          <button onClick={browseForArtCli} style={btnSecondary}>
            Browse…
          </button>
          {artRoundTripEnabled && (
            <button onClick={() => setArtCliPath('')} style={{ ...btnSecondary, marginLeft: 8 }}>
              Clear
            </button>
          )}
        </div>
        {browseError && (
          <div style={{ padding: '0 16px 13px', fontSize: 12, color: 'var(--danger)' }}>{browseError}</div>
        )}
      </div>

      {pickerRole && (
        <AppPickerDialog roleLabel={ROLE_LABEL[pickerRole]} onClose={() => setPickerRole(null)} onPick={handlePick} />
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', marginLeft: 16 }} />;
}

// Local draft state so every keystroke doesn't trigger a save - only commits
// (via useApplications' setEditor, which persists immediately) on blur.
function ExtraArgsRow({ choice, onCommit }: { choice: AppChoice; onCommit: (extraArgs: string) => void }) {
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
        placeholder="e.g. -s"
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
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: '#fff',
  font: '500 11px ui-monospace,monospace',
};

const btnSecondary: CSSProperties = {
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  fontSize: 12.5,
  cursor: 'default',
  border: '1px solid var(--border-strong)',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  flexShrink: 0,
};
