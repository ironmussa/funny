/**
 * `google.protobuf.Struct` / `Value` as `@grpc/proto-loader` hands them to the
 * runner gRPC handlers (`oneofs: true`, so a `Value` names its case in `kind`)
 * and as it serializes them back from plain objects.
 *
 * A message decoded by proto-loader is plain JSON (longs as strings, enums as
 * numbers), so the decoded side is typed with `JsonValue` / `JsonObject`.
 */

import type { JsonObject, JsonValue } from '@bufbuild/protobuf';

/** `google.protobuf.Value` in the plain-object form proto-loader serializes. */
export type WireStructValue =
  | { nullValue: 0 }
  | { numberValue: number }
  | { stringValue: string }
  | { boolValue: boolean }
  | { listValue: { values: WireStructValue[] } }
  | { structValue: WireStruct };

/** `google.protobuf.Struct` in the plain-object form proto-loader serializes. */
export interface WireStruct {
  fields: { [key: string]: WireStructValue };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isKindedValue(value: JsonValue | undefined): value is JsonObject & { kind: string } {
  return isJsonObject(value) && typeof value.kind === 'string';
}

function decodeValue(value: JsonValue): JsonValue {
  if (!isKindedValue(value)) return value;
  switch (value.kind) {
    case 'nullValue':
      return null;
    case 'numberValue':
      return value.numberValue;
    case 'stringValue':
      return value.stringValue;
    case 'boolValue':
      return value.boolValue;
    case 'structValue':
      return decodeStruct(value.structValue);
    case 'listValue': {
      const list = value.listValue;
      const values = isJsonObject(list) ? list.values : undefined;
      return (Array.isArray(values) ? values : []).map(decodeValue);
    }
    default:
      return null;
  }
}

/**
 * Decode a proto-loader `Struct` into the JSON object it carries. An object
 * without `fields` (an empty `Struct`, which proto-loader decodes to `{}`) is
 * returned as it is; anything that is not an object becomes `{}`.
 */
export function decodeStruct(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) return {};
  const fields = value.fields;
  if (!isJsonObject(fields)) return value;
  return Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, decodeValue(field)]),
  );
}

/** Encode a value from a data handler's response as a `google.protobuf.Value`. */
export function encodeValue(value: unknown): WireStructValue {
  if (value === null || value === undefined) return { nullValue: 0 };
  if (typeof value === 'number') return { numberValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(encodeValue) } };
  return { structValue: encodeStruct(value) };
}

/** Encode an object's own enumerable fields as a `google.protobuf.Struct` (`{}` for a non-object). */
export function encodeStruct(value: unknown): WireStruct {
  const record: object = value && typeof value === 'object' ? value : {};
  return {
    fields: Object.fromEntries(
      Object.entries(record).map(([key, field]) => [key, encodeValue(field)]),
    ),
  };
}
