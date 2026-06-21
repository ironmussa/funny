const REBASE_LINK_CORNER_RADIUS = 8;

export function rebaseCopyLinkRailX({
  laneGutterWidth,
  railWidth,
  leftInset = 12,
}: {
  laneGutterWidth: number;
  railWidth: number;
  leftInset?: number;
}): number {
  return leftInset + laneGutterWidth + railWidth / 2;
}

export function rebaseCopyLinkRailLane({
  sourceLane,
  targetLane,
}: {
  sourceLane: number | null;
  targetLane: number;
}): number {
  return Math.max(sourceLane ?? targetLane, targetLane) + 1;
}

export function rebaseCopyLinkUsesOuterRail({
  sourceLane,
  targetLane,
  laneCount,
}: {
  sourceLane: number | null;
  targetLane: number;
  laneCount: number;
}): boolean {
  return rebaseCopyLinkRailLane({ sourceLane, targetLane }) >= laneCount;
}

export function roundedRebaseCopyLinkPath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  railX,
  radius = REBASE_LINK_CORNER_RADIUS,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  railX: number;
  radius?: number;
}): string {
  const yDelta = targetY - sourceY;
  const sourceToRail = railX - sourceX;
  const railToTarget = targetX - railX;
  if (yDelta === 0 || sourceToRail === 0 || railToTarget === 0) {
    return `M ${sourceX} ${sourceY} L ${railX} ${sourceY} L ${railX} ${targetY} L ${targetX} ${targetY}`;
  }

  const yDirection = Math.sign(yDelta);
  const sourceDirection = Math.sign(sourceToRail);
  const targetDirection = Math.sign(railToTarget);
  const sourceRadius = Math.min(radius, Math.abs(sourceToRail), Math.abs(yDelta) / 2);
  const targetRadius = Math.min(radius, Math.abs(railToTarget), Math.abs(yDelta) / 2);

  return [
    `M ${sourceX} ${sourceY}`,
    `L ${railX - sourceDirection * sourceRadius} ${sourceY}`,
    `Q ${railX} ${sourceY} ${railX} ${sourceY + yDirection * sourceRadius}`,
    `L ${railX} ${targetY - yDirection * targetRadius}`,
    `Q ${railX} ${targetY} ${railX + targetDirection * targetRadius} ${targetY}`,
    `L ${targetX} ${targetY}`,
  ].join(' ');
}
