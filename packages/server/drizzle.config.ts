import { homedir } from 'os';
import { resolve } from 'path';

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolve(homedir(), '.funny', 'data.db'),
  },
});
