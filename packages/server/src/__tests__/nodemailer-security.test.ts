import { describe, expect, test } from 'bun:test';

import { createTransport } from 'nodemailer';

// Exercise the installed mailer, rather than the route suite's mocked transport,
// so dependency upgrades preserve the SMTP test endpoint's content restrictions.
describe('Nodemailer content restrictions', () => {
  const transport = createTransport({
    streamTransport: true,
    buffer: true,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const message = {
    from: 'noreply@example.com',
    to: 'admin@example.com',
    subject: 'Funny SMTP Test',
    text: 'SMTP configuration test',
  };

  test('renders a plain text test email without connecting to SMTP', async () => {
    const result = await transport.sendMail(message);
    expect(result.message.toString()).toContain('Subject: Funny SMTP Test');
    expect(result.message.toString()).toContain(message.text);
    expect(result.envelope.to).toEqual([message.to]);
  });

  test('rejects file-backed attachments', async () => {
    await expect(
      transport.sendMail({
        ...message,
        attachments: [{ filename: 'source.txt', path: import.meta.filename }],
      }),
    ).rejects.toThrow(/file access rejected/i);
  });

  test('rejects remote attachments before making a request', async () => {
    await expect(
      transport.sendMail({
        ...message,
        attachments: [{ filename: 'remote.txt', href: 'https://example.invalid/attachment' }],
      }),
    ).rejects.toThrow(/url access rejected/i);
  });
});
