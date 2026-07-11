import { useSyncExternalStore } from 'react';

/**
 * Directory-wide "current region" filter shared between the home screen
 * (M3.1) and /search (M3.2) — a plain module singleton is the simplest thing
 * that typechecks: there is exactly one directory session per app run, so a
 * React context would just be ceremony around the same global.
 */
export type SelectedRegion = { id: number; name: string };

/** id 1 ("Trinidad" in the DB) is the island-wide shortcut — displayed as
 * "All Trinidad", matching become-a-trader's chip label. */
export const ALL_TRINIDAD_REGION: SelectedRegion = { id: 1, name: 'All Trinidad' };

let region: SelectedRegion = ALL_TRINIDAD_REGION;
let initializedFromProfile = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getSelectedRegion(): SelectedRegion {
  return region;
}

export function setSelectedRegion(next: SelectedRegion) {
  region = next;
  emit();
}

/**
 * Applies the logged-in user's home region once per app session (spec
 * M3.1 default), unless the visitor already picked a region themselves.
 */
export function initializeRegionFromProfile(next: SelectedRegion) {
  if (initializedFromProfile) return;
  initializedFromProfile = true;
  setSelectedRegion(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSelectedRegion(): [SelectedRegion, (next: SelectedRegion) => void] {
  const value = useSyncExternalStore(subscribe, getSelectedRegion, () => ALL_TRINIDAD_REGION);
  return [value, setSelectedRegion];
}
