import type { EventModelData } from '../types.js';

/**
 * Serialize an EventModel to JSON.
 * Converts Maps to plain objects for JSON compatibility.
 */
export function generateJSON(model: EventModelData): string {
  return JSON.stringify(
    {
      name: model.name,
      elements: Object.fromEntries(model.elements),
      sequences: model.sequences,
      slices: model.slices,
    },
    null,
    2,
  );
}
