// ─── Weave Semantic Merge ─────────────────────────────────

export interface WeaveStatus {
  driverInstalled: boolean;
  driverConfigured: boolean;
  attributesConfigured: boolean;
  status: 'active' | 'unconfigured' | 'not-installed';
}
