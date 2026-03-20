// Library entry point — re-exports for use by other packages.
// ChromeSession and waitForChrome now live in @funny/core/chrome.
export { ChromeSession, waitForChrome } from '@funny/core/chrome';
export type { ScreencastFrame, ChromeSessionOptions } from '@funny/core/chrome';
export { StreamingServer } from './streaming-server.ts';
export type { StreamingServerOptions } from './streaming-server.ts';
