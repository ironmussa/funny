export const COMPACT_WINDOW_MAX_WIDTH = 799;
export const FILE_TREE_DEFAULT_MIN_WIDTH = 1_100;

export function resolveSidebarVisibility(
  windowWidth: number,
  visibilityOverride: boolean | null,
): boolean {
  return visibilityOverride ?? windowWidth > COMPACT_WINDOW_MAX_WIDTH;
}

export function resolveFileTreeVisibility(
  windowWidth: number,
  visibilityOverride: boolean | null,
): boolean {
  return visibilityOverride ?? windowWidth >= FILE_TREE_DEFAULT_MIN_WIDTH;
}
