import { describe, expect, test } from 'bun:test';

import { BrowserCapability, Representation } from '@funny/shared/browser-v1/common';

import {
  BrowserV1RolloutPolicy,
  browserV1RolloutPolicyFromEnvironment,
} from '../../services/socketio/browser-v1-rollout.js';

describe('browser.v1 rollout policy', () => {
  test('selects traffic classes independently for an eligible client', () => {
    const policy = new BrowserV1RolloutPolicy({
      operations: 'binary',
      events: 'shadow',
      terminal: 'legacy',
      deployments: new Set(['web']),
      cohorts: new Set(['canary']),
    });
    expect(
      policy.assignments({
        protocolMajor: 1,
        client: {
          $typeName: 'browser.v1.ClientDescriptor',
          instanceId: 'client-1',
          applicationVersion: 'test',
          deployment: 'web',
          cohort: 'canary',
        },
        capabilities: [
          BrowserCapability.OPERATIONS,
          BrowserCapability.EVENTS,
          BrowserCapability.BROWSER_SESSION,
        ],
      }),
    ).toEqual({
      operations: Representation.BROWSER_V1,
      events: Representation.SHADOW,
      terminal: Representation.LEGACY,
      browserSession: Representation.BROWSER_V1,
    });
  });

  test('falls back to legacy for unsupported capabilities, cohorts, deployments, and versions', () => {
    const policy = new BrowserV1RolloutPolicy({
      operations: 'binary',
      events: 'binary',
      terminal: 'binary',
      deployments: new Set(['tauri']),
      cohorts: new Set(['canary']),
    });
    expect(
      policy.assignments({
        protocolMajor: 1,
        client: {
          $typeName: 'browser.v1.ClientDescriptor',
          instanceId: 'client-1',
          applicationVersion: 'test',
          deployment: 'web',
          cohort: 'stable',
        },
        capabilities: [BrowserCapability.OPERATIONS],
      }),
    ).toEqual({
      operations: Representation.LEGACY,
      events: Representation.LEGACY,
      terminal: Representation.LEGACY,
      browserSession: Representation.LEGACY,
    });
  });

  test('environment controls are fail-closed', () => {
    const policy = browserV1RolloutPolicyFromEnvironment({
      FUNNY_BROWSER_V1_OPERATIONS: 'binary',
      FUNNY_BROWSER_V1_EVENTS: 'invalid',
    });
    expect(
      policy.assignments({
        protocolMajor: 1,
        client: {
          $typeName: 'browser.v1.ClientDescriptor',
          instanceId: 'client-1',
          applicationVersion: 'test',
          deployment: 'web',
        },
        capabilities: [BrowserCapability.OPERATIONS, BrowserCapability.EVENTS],
      }),
    ).toMatchObject({
      operations: Representation.BROWSER_V1,
      events: Representation.LEGACY,
    });
  });

  test('browser sessions use browser.v1 whatever the rollout, cohort or environment', () => {
    const policy = browserV1RolloutPolicyFromEnvironment({
      FUNNY_BROWSER_V1_BROWSER_SESSION: 'legacy',
      FUNNY_BROWSER_V1_COHORTS: 'canary',
    });
    expect(
      policy.assignments({
        protocolMajor: 1,
        client: {
          $typeName: 'browser.v1.ClientDescriptor',
          instanceId: 'client-1',
          applicationVersion: 'test',
          deployment: 'web',
          cohort: 'stable',
        },
        capabilities: [BrowserCapability.BROWSER_SESSION],
      }).browserSession,
    ).toBe(Representation.BROWSER_V1);
  });
});
