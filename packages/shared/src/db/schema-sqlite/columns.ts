// Shared custom column types of the SQLite schema.
import { customType } from 'drizzle-orm/sqlite-core';

/**
 * Text column that also accepts Date objects (serializes them to ISO strings).
 * Required for Better Auth's Drizzle adapter, which passes `new Date()` for timestamp fields.
 */
export const dateText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'TEXT';
  },
  toDriver(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : value;
  },
  fromDriver(value: string): string {
    return value;
  },
});
