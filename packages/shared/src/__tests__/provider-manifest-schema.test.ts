/**
 * Tests for the external provider-manifest validator (provider-manifest-loader).
 * The schema is the declarative-only security gate: it must accept the bundled
 * manifests verbatim and reject anything outside the frozen in-core menu.
 */

import { describe, expect, test } from 'bun:test';

import {
  PROVIDER_MANIFEST_SCHEMA_VERSION,
  parseFunnyProviderFile,
  providerManifestSchema,
} from '../provider-manifest-schema.js';
import { ACP_MANIFESTS } from '../provider-manifests.js';

/** Wrap a manifest in the on-disk envelope. */
function asFile(manifest: unknown) {
  return { schemaVersion: PROVIDER_MANIFEST_SCHEMA_VERSION, manifest };
}

describe('providerManifestSchema — round-trips the built-ins', () => {
  // §1.4: every bundled manifest must serialize to JSON and re-parse unchanged,
  // proving the built-ins are forward-compatible with the external format.
  for (const [id, manifest] of Object.entries(ACP_MANIFESTS)) {
    test(`built-in '${id}' validates and round-trips`, () => {
      const json = JSON.parse(JSON.stringify(manifest));
      const parsed = providerManifestSchema.safeParse(json);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(json);
    });
  }

  test('all five built-ins are accepted', () => {
    expect(Object.keys(ACP_MANIFESTS)).toHaveLength(5);
  });
});

describe('parseFunnyProviderFile — declarative-only enforcement', () => {
  const valid = asFile(JSON.parse(JSON.stringify(ACP_MANIFESTS.opencode)));

  test('accepts a valid versioned file', () => {
    const res = parseFunnyProviderFile(valid);
    expect(res.ok).toBe(true);
  });

  test('rejects a wrong schemaVersion', () => {
    const res = parseFunnyProviderFile({ ...valid, schemaVersion: 999 });
    expect(res.ok).toBe(false);
  });

  test('rejects an unknown quirk flag (no behavior the core does not implement)', () => {
    const m = JSON.parse(JSON.stringify(ACP_MANIFESTS.opencode));
    m.quirks.doArbitraryThing = true;
    const res = parseFunnyProviderFile(asFile(m));
    expect(res.ok).toBe(false);
  });

  test('rejects a menu selector value outside the closed enum', () => {
    const m = JSON.parse(JSON.stringify(ACP_MANIFESTS.opencode));
    m.modeVia = 'exec-arbitrary-script';
    const res = parseFunnyProviderFile(asFile(m));
    expect(res.ok).toBe(false);
  });

  test('rejects an unknown prelaunch action', () => {
    const m = JSON.parse(JSON.stringify(ACP_MANIFESTS.gemini));
    m.prelaunch = 'rm-rf-home';
    const res = parseFunnyProviderFile(asFile(m));
    expect(res.ok).toBe(false);
  });

  test('rejects an unknown top-level key', () => {
    const m = JSON.parse(JSON.stringify(ACP_MANIFESTS.opencode));
    m.onSpawn = "fetch('http://evil')";
    const res = parseFunnyProviderFile(asFile(m));
    expect(res.ok).toBe(false);
  });

  test('rejects a non-ACP kind', () => {
    const m = JSON.parse(JSON.stringify(ACP_MANIFESTS.opencode));
    m.kind = 'sdk';
    const res = parseFunnyProviderFile(asFile(m));
    expect(res.ok).toBe(false);
  });

  test('rejects an over-long banner regex (ReDoS length cap)', () => {
    const m = JSON.parse(JSON.stringify(ACP_MANIFESTS.pi));
    m.quirks.stripFirstMessageBanner = 'a'.repeat(5000);
    const res = parseFunnyProviderFile(asFile(m));
    expect(res.ok).toBe(false);
  });

  test('rejects an invalid banner regex', () => {
    const m = JSON.parse(JSON.stringify(ACP_MANIFESTS.pi));
    m.quirks.stripFirstMessageBanner = '([unclosed';
    const res = parseFunnyProviderFile(asFile(m));
    expect(res.ok).toBe(false);
  });
});
