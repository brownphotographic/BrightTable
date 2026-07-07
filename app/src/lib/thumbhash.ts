import { thumbHashToDataURL } from 'thumbhash';

// Immich ships a ~25-byte thumbhash per asset in the timeline data already -
// decoding it client-side gives an instant blurred preview with zero network
// cost, before the real thumbnail/preview image arrives.
export function decodeThumbHash(base64: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}
