/** ANSI color/cursor sequences: ESC `[` params final-letter. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** A raw output line without colors or trailing whitespace. */
export const cleanLine = (raw: string) => raw.replace(ANSI, '').trimEnd();
