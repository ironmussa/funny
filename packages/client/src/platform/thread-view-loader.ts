import type { ComponentType } from 'react';

import type { ThreadViewProps } from '@/components/ThreadView';

type ThreadViewModule = { default: ComponentType<ThreadViewProps> };

let threadViewModulePromise: Promise<ThreadViewModule> | undefined;

/**
 * Share one import between the route bootstrap and React.lazy. Direct thread
 * URLs can start downloading the primary view before the much larger App
 * module graph has finished evaluating.
 */
export function preloadThreadView(): Promise<ThreadViewModule> {
  threadViewModulePromise ??= import('@/components/ThreadView').then((module) => ({
    default: module.ThreadView,
  }));
  return threadViewModulePromise;
}
