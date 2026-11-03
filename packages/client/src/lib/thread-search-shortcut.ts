/**
 * Whether a keydown is the Ctrl+F that opens in-thread search. Ctrl+F stays
 * with terminals (they show their own search overlay) and the remote browser
 * (the page owns its keys).
 */
export function isThreadSearchShortcut(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return false;
  if (e.key !== 'f' && e.key !== 'F') return false;
  const target = e.target;
  return !(target instanceof Element && target.closest('.xterm, [data-keyboard-passthrough]'));
}
