/**
 * GET /v1/models — List available models in OpenAI format.
 */

import { Hono } from 'hono';

import { getAdvertisedModels } from '../utils/model-resolver.js';

export const modelsRoute = new Hono();

modelsRoute.get('/', (c) => {
  const models = getAdvertisedModels();
  const created = Math.floor(Date.now() / 1000);

  return c.json({
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created,
      owned_by: m.owned_by,
    })),
  });
});
