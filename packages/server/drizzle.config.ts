import { defineConfig } from 'drizzle-kit';
import { resolve } from 'path';
import { homedir } from 'os';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolve(homedir(), '.funny', 'data.db'),
  },
});
