import { stripAnsi } from '../lib/ansi.js';

/** A raw output line without colors or trailing whitespace. */
export const cleanLine = (raw: string) => stripAnsi(raw).trimEnd();
