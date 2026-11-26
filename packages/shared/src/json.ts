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

/**
 * The fields of a JSON object being built, where a field may be `undefined`:
 * `JSON.stringify` leaves such a field out.
 */
export type JsonFields = { [key: string]: JsonValue | undefined };

/** The fields of `Fields` that may hold a value, each one optional (a field always `undefined` is gone). */
export type DefinedJsonFields<Fields extends JsonFields> = {
  [Key in keyof Fields as Fields[Key] extends undefined ? never : Key]?: Exclude<
    Fields[Key],
    undefined
  >;
};

/** `fields` without its `undefined` fields, as `JSON.stringify` would write them. */
export function definedJsonFields<Fields extends JsonFields>(
  fields: Fields,
): DefinedJsonFields<Fields> {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  // SAFETY: the entries are `fields`' own, minus the undefined ones, which is
  // what each optional `DefinedJsonFields` key allows.
  return Object.fromEntries(entries) as DefinedJsonFields<Fields>;
}
