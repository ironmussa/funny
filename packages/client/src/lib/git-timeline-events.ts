/** Events rendered as standalone GitEventCard rows in the conversation. */
export const GIT_TIMELINE_EVENT_TYPES = [
  'git:commit',
  'git:push',
  'git:merge',
  'git:pr_created',
  'git:stage',
  'git:unstage',
  'git:revert',
  'git:pull',
  'git:stash',
  'git:stash_pop',
  'git:reset_soft',
] as const;

export type GitTimelineEventType = (typeof GIT_TIMELINE_EVENT_TYPES)[number];

const gitTimelineEventTypes: ReadonlySet<string> = new Set(GIT_TIMELINE_EVENT_TYPES);

export function isGitTimelineEventType(type: string): type is GitTimelineEventType {
  return gitTimelineEventTypes.has(type);
}
