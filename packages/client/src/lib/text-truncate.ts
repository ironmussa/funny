const ELLIPSIS = '\u2026';

export function middleTruncate(value: string, maxLength = 60): string {
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  if (maxLength === 1) return ELLIPSIS;

  const separator = '/';
  const parts = value.split(separator);
  if (parts.length > 2) {
    const tail = parts[parts.length - 1];
    const separatorEllipsis = `${separator}${ELLIPSIS}${separator}`;
    const prefixBudget = maxLength - tail.length - separatorEllipsis.length;

    if (prefixBudget > 0) {
      let prefix = '';
      for (let index = 0; index < parts.length - 1; index += 1) {
        const candidate = prefix ? `${prefix}${separator}${parts[index]}` : parts[index];
        if (candidate.length > prefixBudget) break;
        prefix = candidate;
      }

      const truncated = `${prefix ? `${prefix}${separator}` : ''}${ELLIPSIS}${separator}${tail}`;
      if (truncated.length <= maxLength) return truncated;
    }
  }

  const budget = maxLength - ELLIPSIS.length;
  const headLength = Math.ceil(budget / 2);
  const tailLength = Math.floor(budget / 2);
  return `${value.slice(0, headLength)}${ELLIPSIS}${value.slice(value.length - tailLength)}`;
}
