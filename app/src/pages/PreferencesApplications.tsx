import { useState, type CSSProperties } from 'react';
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
  const { applications, setEditor } = useApplications();
  const [pickerRole, setPickerRole] = useState<Role | null>(null);

  function handlePick(choice: AppChoice) {
    if (pickerRole) setEditor(pickerRole, choice);
    setPickerRole(null);
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

      {pickerRole && (
        <AppPickerDialog roleLabel={ROLE_LABEL[pickerRole]} onClose={() => setPickerRole(null)} onPick={handlePick} />
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', marginLeft: 16 }} />;
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
