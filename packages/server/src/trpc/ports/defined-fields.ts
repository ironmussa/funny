/**
 * The own fields of `value` that are not `undefined`, with their types kept:
 * the column writes of a PATCH body whose absent fields mean "unchanged".
 */
export function definedFields<T extends object>(value: T): Partial<T> {
  const fields: Partial<T> = {};
  for (const key in value) {
    if (Object.hasOwn(value, key) && value[key] !== undefined) fields[key] = value[key];
  }
  return fields;
}
