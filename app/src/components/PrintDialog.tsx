import { useEffect, useMemo, useState } from 'react';
import { listPrinters, printAsset, thumbnailSrc, type AssetSummary, type PaperSize, type Printer, type PrintFitMode, type PrintOrientation } from '../lib/api';
import { isRawAsset } from '../lib/filters';
import { closeBtnStyle, btnSecondary, btnPrimary } from './ExportToFolderDialog';

// Preferred default print resolution when a printer offers it - 720dpi is
// the sweet spot most photo printers' own drivers treat as "photo quality"
// without the multi-minute-per-page cost of their highest option (often
// 1440/2880dpi, whose extra resolution a viewer can't perceive at normal
// print-viewing distance anyway). Falls back to the printer's own highest
// (dpis[0], since parse_lpoptions_l sorts descending) when 720 isn't offered.
const PREFERRED_DEFAULT_DPI = 720;

function defaultDpi(dpis: number[]): number | null {
  return dpis.includes(PREFERRED_DEFAULT_DPI) ? PREFERRED_DEFAULT_DPI : (dpis[0] ?? null);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// Print dialog, ported from the design prototype's Print modal (Immich
// Desktop.dc.html, printOpen/doPrint) - real printers/papers/DPI options
// (via list_printers → print.rs's CUPS enumeration) instead of the
// prototype's hardcoded PRINTERS mock data, and a real print_asset call
// instead of a toast. Single-asset only (matches the mockup's own
// printTargetAsset() scope) - no batch printing in v1.
//
function paperWH(paper: PaperSize, orientation: PrintOrientation): [number, number] {
  const a = Math.min(paper.widthIn, paper.heightIn);
  const b = Math.max(paper.widthIn, paper.heightIn);
  return orientation === 'landscape' ? [b, a] : [a, b];
}

// Real per-printer/per-paper margin from the driver's PPD (print.rs's
// parse_ppd_paper_sizes), not a flat guess — a borderless paper choice
// reports 0in here and can use its full physical size.
function printArea(paper: [number, number], marginIn: number): [number, number] {
  return [Math.max(0.2, paper[0] - 2 * marginIn), Math.max(0.2, paper[1] - 2 * marginIn)];
}

function fitSize(aspect: number, area: [number, number]): [number, number] {
  let w = area[0];
  let h = w / aspect;
  if (h > area[1]) {
    h = area[1];
    w = h * aspect;
  }
  return [w, h];
}

function clampSize(w: number, aspect: number, area: [number, number]): [number, number] {
  w = Math.min(Math.max(0.2, w), area[0]);
  let h = w / aspect;
  if (h > area[1]) {
    h = area[1];
    w = h * aspect;
  }
  return [w, h];
}

export default function PrintDialog({ asset, onClose }: { asset: AssetSummary; onClose: () => void }) {
  const [printers, setPrinters] = useState<Printer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [printerId, setPrinterId] = useState<string | null>(null);
  const [paperId, setPaperId] = useState<string | null>(null);
  const [copies, setCopies] = useState(1);
  const [dpi, setDpi] = useState<number | null>(null);
  const [orientation, setOrientation] = useState<PrintOrientation>('landscape');
  // 'crop' (fills the paper completely, cropping the photo's longer relative
  // edge) is the default per the user's own printing preference - 'fit'
  // (whole image visible, possible white space) is the opt-in toggle.
  const [fitMode, setFitMode] = useState<PrintFitMode>('crop');
  const [units, setUnits] = useState<'in' | 'cm'>('in');
  // null = "fit the printable area" (mirrors the mockup's imgW/imgH: null).
  const [imgW, setImgW] = useState<number | null>(null);
  const [imgH, setImgH] = useState<number | null>(null);
  const [printerMenuOpen, setPrinterMenuOpen] = useState(false);
  const [paperMenuOpen, setPaperMenuOpen] = useState(false);
  const [dpiMenuOpen, setDpiMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const raw = isRawAsset(asset);

  useEffect(() => {
    if (raw) return;
    let cancelled = false;
    listPrinters()
      .then((list) => {
        if (cancelled) return;
        setPrinters(list);
        const initial = list.find((p) => p.isDefault) ?? list[0];
        if (initial) {
          setPrinterId(initial.id);
          setPaperId(initial.papers[0]?.id ?? null);
          setDpi(defaultDpi(initial.dpis));
        }
      })
      .catch((e) => !cancelled && setLoadError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [raw]);

  const aspect = asset.exifImageWidth && asset.exifImageHeight ? asset.exifImageWidth / asset.exifImageHeight : 1.5;
  const curPrinter = useMemo(() => printers?.find((p) => p.id === printerId) ?? null, [printers, printerId]);
  const curPaper = useMemo(() => curPrinter?.papers.find((p) => p.id === paperId) ?? curPrinter?.papers[0] ?? null, [curPrinter, paperId]);

  const paperDims = curPaper ? paperWH(curPaper, orientation) : null;
  const area = paperDims && curPaper ? printArea(paperDims, curPaper.marginIn) : null;
  // In 'crop' mode, the default (before any manual W/H edit) is to fill the
  // entire printable area - that's what "no whitespace" means when the
  // photo's aspect doesn't match the paper's. 'fit' keeps the mockup's
  // original contain-within-area behavior.
  const size = useMemo<[number, number] | null>(() => {
    if (!area) return null;
    if (imgW != null && imgH != null) return [imgW, imgH];
    return fitMode === 'fit' ? fitSize(aspect, area) : area;
  }, [area, aspect, imgW, imgH, fitMode]);

  function selectPrinter(p: Printer) {
    setPrinterId(p.id);
    setPaperId(p.papers[0]?.id ?? null);
    setDpi(defaultDpi(p.dpis));
    setImgW(null);
    setImgH(null);
    setPrinterMenuOpen(false);
  }

  function selectPaper(p: PaperSize) {
    setPaperId(p.id);
    setImgW(null);
    setImgH(null);
    setPaperMenuOpen(false);
  }

  function setOrientationAndReset(o: PrintOrientation) {
    setOrientation(o);
    setImgW(null);
    setImgH(null);
  }

  function setFitModeAndReset(m: PrintFitMode) {
    setFitMode(m);
    setImgW(null);
    setImgH(null);
  }

  const toUnit = (v: number) => (units === 'cm' ? v * 2.54 : v);
  const fromUnit = (v: number) => (units === 'cm' ? v / 2.54 : v);

  // In 'fit' mode, W and H stay aspect-locked to the source photo (editing
  // one recomputes the other) - the whole point of that mode is showing the
  // entire, undistorted image. In 'crop' mode they're independently
  // editable (each just clamped to the printable area) - any rectangle is
  // valid since the source gets cropped to match it.
  function onWidthInput(value: string) {
    if (!area) return;
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed <= 0) {
      setImgW(null);
      setImgH(null);
      return;
    }
    if (fitMode === 'fit') {
      const [w, h] = clampSize(fromUnit(parsed), aspect, area);
      setImgW(w);
      setImgH(h);
    } else {
      setImgW(clamp(fromUnit(parsed), 0.2, area[0]));
      setImgH(imgH ?? area[1]);
    }
  }

  function onHeightInput(value: string) {
    if (!area) return;
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed <= 0) {
      setImgW(null);
      setImgH(null);
      return;
    }
    if (fitMode === 'fit') {
      const [w, h] = clampSize(fromUnit(parsed) * aspect, aspect, area);
      setImgW(w);
      setImgH(h);
    } else {
      setImgH(clamp(fromUnit(parsed), 0.2, area[1]));
      setImgW(imgW ?? area[0]);
    }
  }

  async function handlePrint() {
    if (!printerId || !paperId || dpi == null || !paperDims || !size) return;
    setBusy(true);
    setError(null);
    try {
      await printAsset(
        { id: asset.id, originalPath: asset.originalPath, fileName: asset.fileName, isRaw: false },
        {
          printerId,
          paperId,
          copies,
          dpi,
          orientation,
          fitMode,
          paperWidthIn: paperDims[0],
          paperHeightIn: paperDims[1],
          imageWidthIn: size[0],
          imageHeightIn: size[1],
        },
      );
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready = !raw && printers != null && printers.length > 0 && printerId && paperId && dpi != null && size != null;

  const previewMax: [number, number] = [300, 250];
  const previewScale = paperDims ? Math.min(previewMax[0] / paperDims[0], previewMax[1] / paperDims[1]) : 1;
  const paperPx: [number, number] = paperDims ? [Math.round(paperDims[0] * previewScale), Math.round(paperDims[1] * previewScale)] : [0, 0];
  const photoPx: [number, number] = size ? [Math.max(4, Math.round(size[0] * previewScale)), Math.max(4, Math.round(size[1] * previewScale))] : [0, 0];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={busy ? undefined : onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720,
          maxWidth: '95%',
          maxHeight: '90vh',
          background: '#242424',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 48,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 10px 0 18px',
            background: '#303030',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Print</span>
          <span style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', color: 'rgba(255,255,255,0.45)' }}>{asset.fileName}</span>
          <div style={{ flex: 1 }} />
          <div onClick={busy ? undefined : onClose} style={closeBtnStyle}>
            ✕
          </div>
        </div>

        {raw ? (
          <div style={{ padding: '32px 22px', fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.6 }}>
            RAW photos can't be printed yet — open the edited version or export a JPEG first.
          </div>
        ) : (
          <div style={{ display: 'flex', padding: 20, gap: 22, overflow: 'auto' }}>
            <div style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 15 }}>
              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>Printer</div>
                <div
                  onClick={() => setPrinterMenuOpen((v) => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 13px', background: '#303030', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, fontSize: 13, cursor: 'default' }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: curPrinter?.status === 'disabled' ? '#e5a50a' : '#2ec27e', flexShrink: 0 }} />
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{curPrinter?.name ?? (printers == null ? 'Loading…' : 'No printers found')}</span>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{curPrinter?.connection ?? ''}</span>
                </div>
                {printerMenuOpen && printers && printers.length > 0 && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 6, background: '#383838', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, boxShadow: '0 12px 30px rgba(0,0,0,0.6)', padding: 5 }}>
                    {printers.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => selectPrinter(p)}
                        style={{ display: 'flex', alignItems: 'center', height: 32, padding: '0 10px', borderRadius: 7, fontSize: 13, cursor: 'default', color: '#fff', background: p.id === printerId ? 'rgba(53,132,228,0.25)' : 'transparent' }}
                      >
                        <span style={{ flex: 1 }}>{p.name}</span>
                        <span style={{ fontSize: 11, opacity: 0.55 }}>{p.connection}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>Paper</div>
                <div
                  onClick={() => curPrinter && setPaperMenuOpen((v) => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 13px', background: '#303030', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, fontSize: 13, cursor: 'default' }}
                >
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{curPaper?.name ?? '—'}</span>
                </div>
                {paperMenuOpen && curPrinter && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 6, maxHeight: 184, overflow: 'auto', background: '#383838', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, boxShadow: '0 12px 30px rgba(0,0,0,0.6)', padding: 5 }}>
                    {curPrinter.papers.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => selectPaper(p)}
                        style={{ display: 'flex', alignItems: 'center', height: 32, padding: '0 10px', borderRadius: 7, fontSize: 12.5, cursor: 'default', color: '#fff', background: p.id === paperId ? 'rgba(53,132,228,0.25)' : 'transparent' }}
                      >
                        {p.name}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 6 }}>Papers shown are those installed for this printer.</div>
              </div>

              <div style={{ display: 'flex', gap: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>Copies</div>
                  <div style={{ display: 'flex', alignItems: 'center', height: 38, background: '#303030', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, overflow: 'hidden' }}>
                    <div onClick={() => setCopies((c) => Math.max(1, c - 1))} style={{ width: 36, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}>
                      <div style={{ width: 11, height: 1.7, background: '#fff' }} />
                    </div>
                    <div style={{ flex: 1, textAlign: 'center', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{copies}</div>
                    <div onClick={() => setCopies((c) => Math.min(99, c + 1))} style={{ width: 36, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}>
                      <div style={{ width: 11, height: 1.7, background: '#fff' }} />
                    </div>
                  </div>
                </div>
                <div style={{ flex: 1.3, position: 'relative' }}>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>Print resolution</div>
                  <div
                    onClick={() => curPrinter && setDpiMenuOpen((v) => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 13px', background: '#303030', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, fontSize: 13, cursor: 'default' }}
                  >
                    <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' }}>{dpi != null ? `${dpi} dpi` : '—'}</span>
                  </div>
                  {dpiMenuOpen && curPrinter && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 6, background: '#383838', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, boxShadow: '0 12px 30px rgba(0,0,0,0.6)', padding: 5 }}>
                      {curPrinter.dpis.map((d, i) => (
                        <div
                          key={d}
                          onClick={() => {
                            setDpi(d);
                            setDpiMenuOpen(false);
                          }}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', borderRadius: 7, fontSize: 12.5, cursor: 'default', color: '#fff', background: dpi === d ? 'rgba(53,132,228,0.25)' : 'transparent' }}
                        >
                          <span style={{ flex: 1, fontVariantNumeric: 'tabular-nums' }}>{d} dpi</span>
                          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{i === 0 ? 'Highest quality' : i === curPrinter.dpis.length - 1 ? 'Draft / fast' : 'Standard'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>Orientation</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['landscape', 'portrait'] as const).map((o) => (
                    <div
                      key={o}
                      onClick={() => setOrientationAndReset(o)}
                      style={{
                        flex: 1,
                        height: 34,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 8,
                        fontSize: 12.5,
                        cursor: 'default',
                        textTransform: 'capitalize',
                        color: orientation === o ? '#fff' : 'rgba(255,255,255,0.7)',
                        background: orientation === o ? '#3584e4' : '#303030',
                        boxShadow: orientation === o ? 'none' : 'inset 0 0 0 1px rgba(255,255,255,0.1)',
                      }}
                    >
                      {o}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>Image fit</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(
                    [
                      ['crop', 'Fill Paper'],
                      ['fit', 'Fit Whole Image'],
                    ] as [PrintFitMode, string][]
                  ).map(([m, label]) => (
                    <div
                      key={m}
                      onClick={() => setFitModeAndReset(m)}
                      style={{
                        flex: 1,
                        height: 34,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 8,
                        fontSize: 12.5,
                        cursor: 'default',
                        color: fitMode === m ? '#fff' : 'rgba(255,255,255,0.7)',
                        background: fitMode === m ? '#3584e4' : '#303030',
                        boxShadow: fitMode === m ? 'none' : 'inset 0 0 0 1px rgba(255,255,255,0.1)',
                      }}
                    >
                      {label}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 6 }}>
                  {fitMode === 'crop' ? "Fills the paper — crops the photo's longer edge to avoid white space." : 'Shows the whole photo — may leave white space on one edge.'}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>Printed image size</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['in', 'cm'] as const).map((u) => (
                      <div
                        key={u}
                        onClick={() => setUnits(u)}
                        style={{ padding: '3px 9px', borderRadius: 6, fontSize: 11, cursor: 'default', color: units === u ? '#fff' : 'rgba(255,255,255,0.5)', background: units === u ? '#3584e4' : 'rgba(255,255,255,0.08)' }}
                      >
                        {u}
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <input
                    value={size ? String(Math.round(toUnit(size[0]) * 100) / 100) : ''}
                    onChange={(e) => onWidthInput(e.target.value)}
                    inputMode="decimal"
                    style={{ width: 74, height: 36, background: '#303030', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, color: '#fff', font: '600 14px ui-monospace,monospace', textAlign: 'center' }}
                  />
                  <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>×</div>
                  <input
                    value={size ? String(Math.round(toUnit(size[1]) * 100) / 100) : ''}
                    onChange={(e) => onHeightInput(e.target.value)}
                    inputMode="decimal"
                    style={{ width: 74, height: 36, background: '#303030', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 9, color: '#fff', font: '600 14px ui-monospace,monospace', textAlign: 'center' }}
                  />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>{units}</span>
                  <div style={{ flex: 1 }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                    {fitMode === 'fit' ? 'Aspect locked' : 'Independent (cropped to fill)'}
                  </div>
                </div>
                {area && size && dpi != null && curPaper && (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 8, lineHeight: 1.5 }}>
                    {fitMode === 'fit' ? 'Fits within' : 'Fills'} {Math.round(toUnit(area[0]) * 100) / 100}×{Math.round(toUnit(area[1]) * 100) / 100} {units} printable on{' '}
                    {curPaper.name.split(' (')[0]} · {orientation === 'landscape' ? 'Landscape' : 'Portrait'} · ≈ {Math.round(size[0] * dpi)}×{Math.round(size[1] * dpi)} px at {dpi} dpi
                  </div>
                )}
              </div>
            </div>

            <div style={{ flex: 1, background: '#181818', borderRadius: 11, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 18, minHeight: 330 }}>
              {curPaper && size ? (
                <>
                  <div style={{ position: 'relative', width: paperPx[0], height: paperPx[1], background: '#fff', borderRadius: 2, boxShadow: '0 8px 26px rgba(0,0,0,0.5)' }}>
                    <div
                      style={{
                        position: 'absolute',
                        left: '50%',
                        top: '50%',
                        transform: 'translate(-50%,-50%)',
                        width: photoPx[0],
                        height: photoPx[1],
                        overflow: 'hidden',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
                      }}
                    >
                      {/* object-fit: cover is correct for both modes here, not just
                          Crop - in Fit mode this box's own aspect already equals the
                          source photo's (see fitSize), so cover and contain render
                          identically; in Crop mode it visually matches exactly what
                          composite_for_print's crop_to_aspect does server-side. */}
                      <img
                        src={thumbnailSrc(asset.id, 'preview')}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>
                    {curPaper.name.split(' (')[0]} · image {Math.round(toUnit(size[0]) * 100) / 100}×{Math.round(toUnit(size[1]) * 100) / 100} {units}
                  </div>
                </>
              ) : (
                <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.4)' }}>{loadError ?? (printers == null ? 'Loading printers…' : 'No printers found')}</span>
              )}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', borderTop: '1px solid rgba(0,0,0,0.4)', flexShrink: 0 }}>
          {error && <span style={{ fontSize: 12, color: '#ff8080' }}>{error}</span>}
          <div style={{ flex: 1 }} />
          <button onClick={busy ? undefined : onClose} disabled={busy} style={btnSecondary}>
            Cancel
          </button>
          {!raw && (
            <button onClick={handlePrint} disabled={busy || !ready} style={btnPrimary(!busy && !!ready)}>
              {busy ? 'Printing…' : 'Print'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
