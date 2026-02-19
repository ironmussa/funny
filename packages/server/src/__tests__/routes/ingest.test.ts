import { describe, test, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';

// Mock the ingest mapper
const mockHandleIngestEvent = mock(() => {});
mock.module('../../services/ingest-mapper.js', () => ({
  handleIngestEvent: mockHandleIngestEvent,
}));

const TEST_SECRET = 'test-webhook-secret-123';

// The route reads INGEST_WEBHOOK_SECRET at module level, so set it before importing
const originalSecret = process.env.INGEST_WEBHOOK_SECRET;
process.env.INGEST_WEBHOOK_SECRET = TEST_SECRET;

// Import AFTER setting the env var so the module-level const picks it up
const { ingestRoutes } = await import('../../routes/ingest.js');

describe('Ingest Routes', () => {
  let app: Hono;

  afterAll(() => {
    // Restore original env
    if (originalSecret === undefined) {
      delete process.env.INGEST_WEBHOOK_SECRET;
    } else {
      process.env.INGEST_WEBHOOK_SECRET = originalSecret;
    }
  });

  beforeEach(() => {
    mockHandleIngestEvent.mockReset();
    app = new Hono();
    app.route('/ingest', ingestRoutes);
  });

  test('POST /ingest/webhook processes valid event', async () => {
    const res = await app.request('/ingest/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': TEST_SECRET },
      body: JSON.stringify({
        event_type: 'pipeline.accepted',
        request_id: 'req-123',
        timestamp: new Date().toISOString(),
        data: { title: 'Test' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(mockHandleIngestEvent).toHaveBeenCalledTimes(1);
  });

  test('POST /ingest/webhook rejects missing event_type', async () => {
    const res = await app.request('/ingest/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': TEST_SECRET },
      body: JSON.stringify({
        request_id: 'req-123',
        timestamp: new Date().toISOString(),
        data: {},
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('event_type');
  });

  test('POST /ingest/webhook rejects missing request_id', async () => {
    const res = await app.request('/ingest/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': TEST_SECRET },
      body: JSON.stringify({
        event_type: 'pipeline.accepted',
        timestamp: new Date().toISOString(),
        data: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /ingest/webhook rejects missing timestamp', async () => {
    const res = await app.request('/ingest/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': TEST_SECRET },
      body: JSON.stringify({
        event_type: 'pipeline.accepted',
        request_id: 'req-123',
        data: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /ingest/webhook rejects non-object data', async () => {
    const res = await app.request('/ingest/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': TEST_SECRET },
      body: JSON.stringify({
        event_type: 'pipeline.accepted',
        request_id: 'req-123',
        timestamp: new Date().toISOString(),
        data: 'not an object',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('data must be an object');
  });

  test('POST /ingest/webhook returns 500 when handler throws', async () => {
    mockHandleIngestEvent.mockImplementation(() => {
      throw new Error('Processing failed');
    });

    const res = await app.request('/ingest/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': TEST_SECRET },
      body: JSON.stringify({
        event_type: 'pipeline.accepted',
        request_id: 'req-123',
        timestamp: new Date().toISOString(),
        data: { title: 'Test' },
      }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Processing failed');
  });
});
