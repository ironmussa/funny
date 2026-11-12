/**
 * `/api/settings` input schemas and responses (served over tRPC, `@funny/api`
 * `settings` router). SMTP is instance-level and admin-only; agent execution
 * profiles are per user (their schemas live in `types/agent-execution-profiles`).
 */

import { z } from 'zod';

export const smtpSettingsBody = z.object({
  host: z.string(),
  port: z.string(),
  user: z.string(),
  /** Omitted or empty keeps the stored password. */
  pass: z.string().optional(),
  from: z.string(),
});

export type SmtpSettingsRequest = z.input<typeof smtpSettingsBody>;

/** Never carries the password, only whether one is set. */
export interface SmtpSettingsResponse {
  host: string;
  port: string;
  user: string;
  from: string;
  hasPassword: boolean;
  source: 'database' | 'environment' | 'none';
  configured: boolean;
}
