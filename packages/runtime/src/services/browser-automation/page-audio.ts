/**
 * Page audio on/off for a browser session.
 *
 * Chromium has no per-tab mute in CDP, and `--mute-audio` silences the whole
 * browser for good. So muting happens inside the page: every `<audio>` /
 * `<video>` element is held muted, and every `AudioContext` suspended, until
 * the session is unmuted. The hook runs in every frame (including cross-origin
 * iframes, through Playwright's init scripts) and before page scripts on each
 * navigation, so a page cannot start playing sound before it is muted.
 *
 * Sessions start muted: the panel streams pixels only, and the sound would
 * play on the runner host — also after the panel detached from the session.
 */

import type { Page } from 'playwright';

declare global {
  interface Window {
    __funnyAudio?: {
      set(muted: boolean): void;
      /** Diagnostics: the hook's view of this document's audio. */
      state(): {
        muted: boolean;
        contexts: string[];
        media: Array<{ muted: boolean; paused: boolean }>;
      };
    };
  }
}

/** Installed in every frame; `initial` is the session's state when the document starts. */
function audioHook(initial: boolean): void {
  if (window.__funnyAudio) {
    window.__funnyAudio.set(initial);
    return;
  }
  let muted = initial;
  // Only undo what the hook did: a page's own mute choices survive unmuting.
  const mutedByUs = new WeakSet<HTMLMediaElement>();
  const contexts = new Set<AudioContext>();
  const suspendedByUs = new WeakSet<AudioContext>();

  const holdElement = (el: HTMLMediaElement) => {
    if (muted && !el.muted) {
      el.muted = true;
      mutedByUs.add(el);
    }
  };
  const holdContext = (ctx: AudioContext) => {
    if (muted && ctx.state === 'running') {
      suspendedByUs.add(ctx);
      void ctx.suspend();
    }
  };

  // `play` and `volumechange` do not bubble: listen in the capture phase.
  document.addEventListener('play', (e) => holdElement(e.target as HTMLMediaElement), true);
  document.addEventListener('volumechange', (e) => holdElement(e.target as HTMLMediaElement), true);

  const NativeAudioContext = window.AudioContext;
  if (NativeAudioContext) {
    const nativeResume = NativeAudioContext.prototype.resume;
    NativeAudioContext.prototype.resume = function resume(this: AudioContext) {
      contexts.add(this);
      if (muted) {
        suspendedByUs.add(this);
        return Promise.resolve();
      }
      return nativeResume.call(this);
    };
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.add(this);
        // Without an autoplay restriction a new context starts running on its
        // own, after construction: catch every switch to running.
        this.addEventListener('statechange', () => holdContext(this));
        holdContext(this);
      }
    };
  }

  window.__funnyAudio = {
    state: () => ({
      muted,
      contexts: [...contexts].map((ctx) => ctx.state),
      media: [...document.querySelectorAll<HTMLMediaElement>('audio, video')].map((el) => ({
        muted: el.muted,
        paused: el.paused,
      })),
    }),
    set(next: boolean) {
      muted = next;
      for (const el of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
        if (muted) holdElement(el);
        else if (mutedByUs.has(el)) {
          el.muted = false;
          mutedByUs.delete(el);
        }
      }
      for (const ctx of contexts) {
        if (muted) holdContext(ctx);
        else if (suspendedByUs.has(ctx)) {
          suspendedByUs.delete(ctx);
          void ctx.resume();
        }
      }
    },
  };
}

/** Hook a page once; later navigations and frames start with the session's current state. */
export async function installPageAudio(page: Page, muted: () => boolean): Promise<void> {
  // Init scripts are fixed when added, so each one reads the state through a
  // binding instead of baking it in.
  await page
    .exposeBinding('__funnyAudioMuted', () => muted())
    .catch(() => {
      /* already exposed on this page */
    });
  await page.addInitScript(`(${audioHook.toString()})(true);
    window.__funnyAudioMuted?.().then((m) => window.__funnyAudio?.set(m)).catch(() => {});`);
  await applyPageAudio(page, muted());
}

/** Apply the state to the documents already loaded in every frame of a page. */
export async function applyPageAudio(page: Page, muted: boolean): Promise<void> {
  await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(
          ([hook, next]) => {
            if (!window.__funnyAudio) new Function(`(${hook})(${next})`)();
            window.__funnyAudio?.set(next);
          },
          [audioHook.toString(), muted] as const,
        )
        .catch(() => {
          /* frame detached or navigating; its init script applies the state */
        }),
    ),
  );
}
