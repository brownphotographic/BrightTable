import type { AssetSummary } from './api';

export function formatExposure(a: AssetSummary): string {
  const parts: string[] = [];
  if (a.fNumber != null) parts.push(`f/${a.fNumber.toFixed(1)}`);
  if (a.exposureTime) parts.push(a.exposureTime.endsWith('s') ? a.exposureTime : `${a.exposureTime}s`);
  if (a.iso != null) parts.push(`ISO ${a.iso}`);
  if (a.focalLength != null) parts.push(`${Math.round(a.focalLength)}mm`);
  return parts.length ? parts.join(' ') : '—';
}

export function formatCamera(a: AssetSummary): string {
  const parts = [a.make, a.model].filter(Boolean);
  return parts.length ? parts.join(' ') : '—';
}

export function formatDims(a: AssetSummary): string {
  return a.exifImageWidth && a.exifImageHeight ? `${a.exifImageWidth} × ${a.exifImageHeight}` : '—';
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTaken(a: AssetSummary): string {
  const d = new Date(a.fileCreatedAt);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
}
