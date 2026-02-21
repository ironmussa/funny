/**
 * ManifestManager — reads and writes `.pipeline/manifest.json`.
 *
 * Single source of truth for branch lifecycle:
 *   ready[] → pending_merge[] → merge_history[]
 *
 * Uses read-modify-write pattern (no in-memory cache) to handle
 * potential concurrent modifications.
 */

import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { execute } from '@funny/core/git';
import { StateMachine, BRANCH_TRANSITIONS, type BranchState } from './state-machine.js';
import type {
  Manifest,
  ManifestReadyEntry,
  ManifestPendingMergeEntry,
  ManifestMergeHistoryEntry,
} from './manifest-types.js';
import { logger } from '../infrastructure/logger.js';

function emptyManifest(): Manifest {
  return {
    main_branch: 'main',
    main_head: '',
    last_updated: '',
    ready: [],
    pending_merge: [],
    merge_history: [],
  };
}

export class ManifestManager {
  private manifestPath: string;

  constructor(private projectPath: string) {
    const pipelineDir = join(projectPath, '.pipeline');
    if (!existsSync(pipelineDir)) {
      mkdirSync(pipelineDir, { recursive: true });
    }
    this.manifestPath = join(pipelineDir, 'manifest.json');
  }

  /**
   * Validate a branch state transition using the formal FSM.
   */
  private validateTransition(branch: string, from: BranchState, to: BranchState): boolean {
    const machine = new StateMachine(BRANCH_TRANSITIONS, from, `branch:${branch}`);
    return machine.tryTransition(to);
  }

  // ── Read / Write ──────────────────────────────────────────────

  async read(): Promise<Manifest> {
    const file = Bun.file(this.manifestPath);
    if (!(await file.exists())) {
      return emptyManifest();
    }
    try {
      const text = await file.text();
      return JSON.parse(text) as Manifest;
    } catch (err) {
      logger.error({ err }, 'Failed to parse manifest, returning empty');
      return emptyManifest();
    }
  }

  async write(manifest: Manifest): Promise<void> {
    manifest.last_updated = new Date().toISOString();
    await Bun.write(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  // ── Ready entries ─────────────────────────────────────────────

  async addToReady(entry: ManifestReadyEntry): Promise<void> {
    const manifest = await this.read();

    // Replace existing entry for the same branch (newer run supersedes)
    const existingIdx = manifest.ready.findIndex((e) => e.branch === entry.branch);
    if (existingIdx >= 0) {
      logger.info({ branch: entry.branch }, 'Manifest: replacing existing ready[] entry with newer run');
      manifest.ready[existingIdx] = entry;
    } else {
      manifest.ready.push(entry);
    }

    await this.write(manifest);
    logger.info({ branch: entry.branch }, 'Manifest: added to ready[]');
  }

  async getReadyEntries(): Promise<ManifestReadyEntry[]> {
    const manifest = await this.read();
    return manifest.ready;
  }

  async findReady(branch: string): Promise<ManifestReadyEntry | undefined> {
    const manifest = await this.read();
    return manifest.ready.find((e) => e.branch === branch);
  }

  async removeFromReady(branch: string): Promise<ManifestReadyEntry | undefined> {
    const manifest = await this.read();
    const idx = manifest.ready.findIndex((e) => e.branch === branch);
    if (idx === -1) return undefined;
    const [removed] = manifest.ready.splice(idx, 1);
    await this.write(manifest);
    return removed;
  }

  // ── Pending merge entries ─────────────────────────────────────

  async moveToPendingMerge(
    branch: string,
    prData: {
      pr_number: number;
      pr_url: string;
      integration_branch: string;
      base_main_sha: string;
    },
  ): Promise<void> {
    const manifest = await this.read();

    // Validate FSM transition: ready → pending_merge
    if (!this.validateTransition(branch, 'ready', 'pending_merge')) {
      return;
    }

    // Find and remove from ready[]
    const readyIdx = manifest.ready.findIndex((e) => e.branch === branch);
    if (readyIdx === -1) {
      logger.warn({ branch }, 'Branch not found in ready[], cannot move to pending_merge');
      return;
    }
    const [readyEntry] = manifest.ready.splice(readyIdx, 1);

    // Build pending_merge entry
    const pendingEntry: ManifestPendingMergeEntry = {
      branch: readyEntry.branch,
      pipeline_branch: readyEntry.pipeline_branch,
      integration_branch: prData.integration_branch,
      worktree_path: readyEntry.worktree_path,
      request_id: readyEntry.request_id,
      tier: readyEntry.tier,
      pr_number: prData.pr_number,
      pr_url: prData.pr_url,
      pr_created_at: new Date().toISOString(),
      base_main_sha: prData.base_main_sha,
      pipeline_result: readyEntry.pipeline_result,
      corrections_applied: readyEntry.corrections_applied,
      priority: readyEntry.priority,
      depends_on: readyEntry.depends_on,
      metadata: readyEntry.metadata,
    };

    manifest.pending_merge.push(pendingEntry);
    await this.write(manifest);
    logger.info({ branch, pr_number: prData.pr_number }, 'Manifest: moved to pending_merge[]');
  }

  async getPendingMergeEntries(): Promise<ManifestPendingMergeEntry[]> {
    const manifest = await this.read();
    return manifest.pending_merge;
  }

  async findPendingMerge(branch: string): Promise<ManifestPendingMergeEntry | undefined> {
    const manifest = await this.read();
    return manifest.pending_merge.find((e) => e.branch === branch);
  }

  // ── Merge history ─────────────────────────────────────────────

  async moveToMergeHistory(branch: string, commitSha: string): Promise<void> {
    // Validate FSM transition: pending_merge → merge_history
    if (!this.validateTransition(branch, 'pending_merge', 'merge_history')) {
      return;
    }

    const manifest = await this.read();

    const pendingIdx = manifest.pending_merge.findIndex((e) => e.branch === branch);
    if (pendingIdx === -1) {
      logger.warn({ branch }, 'Branch not found in pending_merge[], cannot move to merge_history');
      return;
    }
    const [pendingEntry] = manifest.pending_merge.splice(pendingIdx, 1);

    const historyEntry: ManifestMergeHistoryEntry = {
      branch: pendingEntry.branch,
      pr_number: pendingEntry.pr_number,
      commit_sha: commitSha,
      merged_at: new Date().toISOString(),
      metadata: pendingEntry.metadata,
    };

    manifest.merge_history.push(historyEntry);
    await this.write(manifest);
    logger.info({ branch, commitSha }, 'Manifest: moved to merge_history[]');
  }

  // ── Main head tracking ────────────────────────────────────────

  async updateMainHead(sha: string): Promise<void> {
    const manifest = await this.read();
    manifest.main_head = sha;
    await this.write(manifest);
  }

  async getMainHead(): Promise<string> {
    const manifest = await this.read();
    return manifest.main_head;
  }

  // ── Rebase support ──────────────────────────────────────────────

  /**
   * Update the base_main_sha for a pending_merge entry (after rebase).
   */
  async updatePendingMergeBaseSha(branch: string, newBaseSha: string): Promise<void> {
    const manifest = await this.read();
    const entry = manifest.pending_merge.find((e) => e.branch === branch);
    if (!entry) {
      logger.warn({ branch }, 'Branch not found in pending_merge[], cannot update base SHA');
      return;
    }
    entry.base_main_sha = newBaseSha;
    await this.write(manifest);
    logger.info({ branch, newBaseSha }, 'Manifest: updated base_main_sha in pending_merge');
  }

  /**
   * Move a branch from pending_merge[] back to ready[] (e.g., PR closed without merge).
   */
  async moveBackToReady(branch: string): Promise<void> {
    // Validate FSM transition: pending_merge → ready
    if (!this.validateTransition(branch, 'pending_merge', 'ready')) {
      return;
    }

    const manifest = await this.read();
    const pendingIdx = manifest.pending_merge.findIndex((e) => e.branch === branch);
    if (pendingIdx === -1) {
      logger.warn({ branch }, 'Branch not found in pending_merge[], cannot move back to ready');
      return;
    }
    const [pendingEntry] = manifest.pending_merge.splice(pendingIdx, 1);

    const readyEntry: ManifestReadyEntry = {
      branch: pendingEntry.branch,
      pipeline_branch: pendingEntry.pipeline_branch,
      worktree_path: pendingEntry.worktree_path,
      request_id: pendingEntry.request_id,
      tier: pendingEntry.tier,
      pipeline_result: pendingEntry.pipeline_result,
      corrections_applied: pendingEntry.corrections_applied,
      ready_at: new Date().toISOString(),
      priority: pendingEntry.priority,
      depends_on: pendingEntry.depends_on,
      base_main_sha: pendingEntry.base_main_sha,
      metadata: pendingEntry.metadata,
    };

    manifest.ready.push(readyEntry);
    await this.write(manifest);
    logger.info({ branch }, 'Manifest: moved back from pending_merge to ready[]');
  }
}
