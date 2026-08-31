export const parityInventory = {
  shell: ['desktop', 'compact'],
  navigation: ['grouped', 'selected', 'focused', 'missing-metadata'],
  message: ['user', 'assistant', 'rich-content', 'collapsed', 'unsupported'],
  activity: ['tool', 'todo', 'permission-active', 'permission-resolved', 'connection-error'],
  composer: ['idle', 'pending', 'running', 'waiting', 'read-only', 'error'],
} as const;

export function parityInventoryIds(): string[] {
  return Object.entries(parityInventory).flatMap(([group, states]) =>
    states.map((state) => `${group}:${state}`),
  );
}
