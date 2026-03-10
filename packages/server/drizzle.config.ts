import { homedir } from 'os';
import { resolve } from 'path';

import { defineConfig } from 'drizzle-kit';

const dbMode = (process.env.DB_MODE ?? 'sqlite').toLowerCase();
const isPostgres = dbMode === 'postgres' || dbMode === 'postgresql';

export default defineConfig(
  isPostgres
    ? {
        schema: './src/db/schema.pg.ts',
        out: './drizzle-pg',
        dialect: 'postgresql',
        dbCredentials: {
          url: process.env.DATABASE_URL!,
        },
      }
    : {
        schema: './src/db/schema.ts',
        out: './drizzle',
        dialect: 'sqlite',
        dbCredentials: {
          url: resolve(homedir(), '.funny', 'data.db'),
        },
      },
);
