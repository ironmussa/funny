// A JSON value: what `JSON.parse` returns and `JSON.stringify` writes back.
// Use it for payloads whose shape is genuinely open (tool-call inputs, MCP
// arguments, stored metadata) instead of `Record<string, unknown>`, so a reader
// knows every value is plain data that can be serialized again.

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

/** Whether `value` is a JSON object (not an array, not null). */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
