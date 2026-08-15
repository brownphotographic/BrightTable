import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

// Window is `decorations: false` (see tauri.conf.json) - there's no native
// OS border to grab, so without this the only way to resize is whatever
// razor-thin edge a Linux window manager happens to hit-test around an
// undecorated window (varies by WM, and on several is effectively nothing).
// These are plain invisible drag strips along each edge/corner that call
// Tauri's own `startResizeDragging`.
//
// No bottom-right (SouthEast) handle: that corner is where the Photos/
// Folders/Trash status bars put their own right-aligned controls (thumbnail
// zoom slider, "Empty Trash"), and it was stealing clicks from them.
const EDGE = 8;
const CORNER = 24;

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
    </>
  );
}
