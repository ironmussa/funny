/** Interpret only complete Claude protocol envelopes, never quoted examples or arbitrary XML. */
export function claudeMessagePresentation(content: string, automatic = false) {
  const trimmed = content.trim();
  const command = trimmed.match(
    /^<command-message>([^<]*)<\/command-message>\s*<command-name>([^<]+)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?$/,
  );
  if (command) {
    const name = command[2].trim();
    return {
      kind: 'command' as const,
      text: `${name.startsWith('/') ? '' : '/'}${name}${command[3]?.trim() ? ` ${command[3].trim()}` : ''}`,
    };
  }
  const reminder = trimmed.match(/^<system-reminder>([\s\S]*)<\/system-reminder>$/);
  if (reminder) return { kind: 'context' as const, text: reminder[1].trim() };
  return { kind: automatic ? ('context' as const) : ('message' as const), text: content };
}
