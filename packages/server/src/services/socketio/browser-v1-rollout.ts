import {
  BrowserCapability,
  Representation,
  type ClientDescriptor,
} from '@funny/shared/browser-v1/common';

export type BrowserV1RolloutMode = 'legacy' | 'shadow' | 'binary';

export interface BrowserV1RolloutConfig {
  operations: BrowserV1RolloutMode;
  events: BrowserV1RolloutMode;
  terminal: BrowserV1RolloutMode;
  browserSession: BrowserV1RolloutMode;
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

export class BrowserV1RolloutPolicy {
  constructor(private readonly config: BrowserV1RolloutConfig) {}

  assignments(input: {
    protocolMajor: number;
    client?: ClientDescriptor;
    capabilities: readonly BrowserCapability[];
  }): {
    operations: Representation;
    events: Representation;
    terminal: Representation;
    browserSession: Representation;
  } {
    const eligible =
      input.protocolMajor === 1 &&
      !!input.client &&
      (!this.config.deployments?.size || this.config.deployments.has(input.client.deployment)) &&
      (!this.config.cohorts?.size ||
        (!!input.client.cohort && this.config.cohorts.has(input.client.cohort)));
    const capabilities = new Set(input.capabilities);
    const select = (traffic: keyof typeof CAPABILITY_BY_TRAFFIC): Representation =>
      eligible && capabilities.has(CAPABILITY_BY_TRAFFIC[traffic])
        ? representation(this.config[traffic])
        : Representation.LEGACY;
    return {
      operations: select('operations'),
      events: select('events'),
      terminal: select('terminal'),
      browserSession: select('browserSession'),
    };
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
  return new BrowserV1RolloutPolicy({
    operations: mode(environment.FUNNY_BROWSER_V1_OPERATIONS),
    events: mode(environment.FUNNY_BROWSER_V1_EVENTS),
    terminal: mode(environment.FUNNY_BROWSER_V1_TERMINAL),
    browserSession: mode(environment.FUNNY_BROWSER_V1_BROWSER_SESSION),
    deployments: list(environment.FUNNY_BROWSER_V1_DEPLOYMENTS),
    cohorts: list(environment.FUNNY_BROWSER_V1_COHORTS),
  });
}
