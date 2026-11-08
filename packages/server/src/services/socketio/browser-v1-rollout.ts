import {
  BrowserCapability,
  Representation,
  type ClientDescriptor,
} from '@funny/shared/browser-v1/common';

import { log } from '../../lib/logger.js';

export type BrowserV1RolloutMode = 'legacy' | 'shadow' | 'binary';

export interface BrowserV1RolloutConfig {
  operations: BrowserV1RolloutMode;
  events: BrowserV1RolloutMode;
  terminal: BrowserV1RolloutMode;
  deployments?: ReadonlySet<string>;
  cohorts?: ReadonlySet<string>;
}

const CAPABILITY_BY_TRAFFIC = {
  operations: BrowserCapability.OPERATIONS,
  events: BrowserCapability.EVENTS,
  terminal: BrowserCapability.TERMINAL,
  browserSession: BrowserCapability.BROWSER_SESSION,
} as const;

function representation(mode: BrowserV1RolloutMode): Representation {
  if (mode === 'binary') return Representation.BROWSER_V1;
  if (mode === 'shadow') return Representation.SHADOW;
  return Representation.LEGACY;
}

interface BrowserV1RolloutInput {
  protocolMajor: number;
  client?: ClientDescriptor;
  capabilities: readonly BrowserCapability[];
}

function inAllowList(allowed: ReadonlySet<string> | undefined, value: string | undefined): boolean {
  return !allowed?.size || (!!value && allowed.has(value));
}

/** Browser sessions are not part of the rollout: any client that negotiated the capability gets browser.v1. */
function browserSessionRepresentation(
  input: BrowserV1RolloutInput,
  capabilities: ReadonlySet<BrowserCapability>,
): Representation {
  return input.protocolMajor === 1 && capabilities.has(CAPABILITY_BY_TRAFFIC.browserSession)
    ? Representation.BROWSER_V1
    : Representation.LEGACY;
}

export class BrowserV1RolloutPolicy {
  constructor(private readonly config: BrowserV1RolloutConfig) {}

  assignments(input: BrowserV1RolloutInput): {
    operations: Representation;
    events: Representation;
    terminal: Representation;
    browserSession: Representation;
  } {
    const eligible = this.isEligible(input);
    const capabilities = new Set(input.capabilities);
    const select = (
      traffic: Exclude<keyof typeof CAPABILITY_BY_TRAFFIC, 'browserSession'>,
    ): Representation =>
      eligible && capabilities.has(CAPABILITY_BY_TRAFFIC[traffic])
        ? representation(this.config[traffic])
        : Representation.LEGACY;
    return {
      operations: select('operations'),
      events: select('events'),
      terminal: select('terminal'),
      browserSession: browserSessionRepresentation(input, capabilities),
    };
  }

  private isEligible(input: BrowserV1RolloutInput): boolean {
    if (input.protocolMajor !== 1 || !input.client) return false;
    return (
      inAllowList(this.config.deployments, input.client.deployment) &&
      inAllowList(this.config.cohorts, input.client.cohort)
    );
  }
}

function mode(value: string | undefined): BrowserV1RolloutMode {
  return value === 'binary' || value === 'shadow' ? value : 'legacy';
}

function list(value: string | undefined): ReadonlySet<string> | undefined {
  const entries = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries?.length ? new Set(entries) : undefined;
}

export function browserV1RolloutPolicyFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BrowserV1RolloutPolicy {
  if (environment.FUNNY_BROWSER_V1_BROWSER_SESSION !== undefined) {
    log.warn(
      'FUNNY_BROWSER_V1_BROWSER_SESSION is no longer read: browser sessions always use browser.v1',
      { namespace: 'browser-v1' },
    );
  }
  return new BrowserV1RolloutPolicy({
    operations: mode(environment.FUNNY_BROWSER_V1_OPERATIONS),
    events: mode(environment.FUNNY_BROWSER_V1_EVENTS),
    terminal: mode(environment.FUNNY_BROWSER_V1_TERMINAL),
    deployments: list(environment.FUNNY_BROWSER_V1_DEPLOYMENTS),
    cohorts: list(environment.FUNNY_BROWSER_V1_COHORTS),
  });
}
