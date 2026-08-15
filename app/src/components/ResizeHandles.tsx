import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

// Window is `decorations: false` (see tauri.conf.json) - there's no native
// OS border to grab, so without this the only way to resize is whatever
// razor-thin edge a Linux window manager happens to hit-test around an
// undecorated window (varies by WM, and on several is effectively nothing).
// These are plain invisible drag strips along each edge/corner that call
// Tauri's own `startResizeDragging`, plus one small visible diagonal-lines
// grip in the bottom-right corner (the "evident" affordance most desktop
// apps put there) so there's at least one obvious, generously-sized spot to
// grab even if the thin edges are still fiddly to hit exactly.
const EDGE = 6;
const CORNER = 16;

type Dir = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

function startDrag(dir: Dir) {
  return (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    appWindow.startResizeDragging(dir).catch(() => {});
  };
}

function edgeStyle(extra: React.CSSProperties): React.CSSProperties {
  return { position: 'fixed', zIndex: 1000, ...extra };
}

export default function ResizeHandles() {
  return (
    <>
      <div onMouseDown={startDrag('North')} style={edgeStyle({ top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' })} />
      <div onMouseDown={startDrag('South')} style={edgeStyle({ bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' })} />
      <div onMouseDown={startDrag('West')} style={edgeStyle({ left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' })} />
      <div onMouseDown={startDrag('East')} style={edgeStyle({ right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' })} />

      <div onMouseDown={startDrag('NorthWest')} style={edgeStyle({ top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' })} />
      <div onMouseDown={startDrag('NorthEast')} style={edgeStyle({ top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' })} />
      <div onMouseDown={startDrag('SouthWest')} style={edgeStyle({ bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' })} />
      <div onMouseDown={startDrag('SouthEast')} style={edgeStyle({ bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' })} />

      {/* The one visible grip - diagonal lines in the bottom-right corner,
          the same spot apps like GIMP/most GTK apps put a resize grip. */}
      <div
        onMouseDown={startDrag('SouthEast')}
        title="Drag to resize"
        style={edgeStyle({
          bottom: 2,
          right: 2,
          width: 13,
          height: 13,
          cursor: 'nwse-resize',
          zIndex: 1001,
          backgroundImage:
            'repeating-linear-gradient(135deg, var(--text-dim) 0px, var(--text-dim) 1.4px, transparent 1.4px, transparent 4px)',
          backgroundPosition: 'bottom right',
          backgroundRepeat: 'no-repeat',
          backgroundSize: '11px 11px',
          pointerEvents: 'auto',
        })}
      />
    </>
  );
}
