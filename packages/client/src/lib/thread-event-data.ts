/** Thread event `data` arrives either as a JSON string or an already-parsed object. */
export function parseThreadEventData(data: string | Record<string, unknown>): Record<string, any> {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data as Record<string, any>;
}
