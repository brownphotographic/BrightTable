import type { CSSProperties } from 'react';

// A deferred/async UI update (e.g. useDeferredValue while a filter recomputes)
// can leave a visible gap between the click and the result landing, where
// nothing on screen has changed yet. Spread this into whatever's updating so
// it dims briefly instead of looking like the click did nothing.
export function pendingStyle(pending: boolean): CSSProperties {
  return { opacity: pending ? 0.3 : 1, transition: 'opacity 150ms' };
}
