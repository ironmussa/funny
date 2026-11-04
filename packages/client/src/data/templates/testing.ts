import type { AgentTemplate } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getTemplatesData } from './store';

/** Make `templates` the session's complete template list, in this order (tests and stories). */
export function seedTemplates(
  templates: readonly AgentTemplate[],
  layer: DataLayer = getDataLayer(),
): void {
  const data = getTemplatesData(layer);
  data.position.clear();
  templates.forEach((t, i) => data.position.set(t.id, i));
  data.replaceAll(templates);
  data.loaded = true;
}
