use std::path::Path;

use crate::repo_cache::with_repo;

/// Summary of committed-only changes between `base_branch` and `branch`,
/// computed without touching the working tree. Mirrors the TS-side
/// `getCommittedBranchSummary` shape.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct BranchSummaryResult {
  pub lines_added: u32,
  pub lines_deleted: u32,
  pub unpushed_commit_count: u32,
  pub unpulled_commit_count: u32,
  pub has_remote_branch: bool,
  pub is_merged_into_base: bool,
}

/// Sum line additions/deletions between two trees via gix's tree diff platform.
fn diff_trees_total_lines(
  old: &gix::Tree<'_>,
  new: &gix::Tree<'_>,
) -> napi::Result<(u32, u32)> {
  let stats = old
    .changes()
    .map_err(|e| napi::Error::from_reason(format!("Failed to prepare tree diff: {e}")))?
    .options(|opts| {
      opts.track_rewrites(None);
    })
    .stats(new)
    .map_err(|e| napi::Error::from_reason(format!("Failed to diff trees: {e}")))?;

  Ok((stats.lines_added as u32, stats.lines_removed as u32))
}

/// Count commits via `git rev-list --count <range>` (or arbitrary args). The
/// gix `rev_walk` approach miscounts when merge commits are involved, so we
/// shell out — same trade-off as `status_summary::rev_list_count`.
fn rev_list_count_args(cwd: &Path, args: &[&str]) -> u32 {
  std::process::Command::new("git")
    .args(args)
    .current_dir(cwd)
    .output()
    .ok()
    .and_then(|o| {
      if o.status.success() {
        String::from_utf8(o.stdout).ok()?.trim().parse::<u32>().ok()
      } else {
        None
      }
    })
    .unwrap_or(0)
}

#[napi]
pub async fn get_branch_summary(
  cwd: String,
  base_branch: String,
  branch: String,
) -> napi::Result<BranchSummaryResult> {
  let cwd_clone = cwd.clone();
  let result = with_repo(&cwd, |repo| {
    // Resolve refs using rev_parse_single so it falls back to remote refs
    // (refs/remotes/origin/<name>) when no local head exists.
    let base_id = repo
      .rev_parse_single(base_branch.as_str())
      .map_err(|e| napi::Error::from_reason(format!("Base branch not found: {e}")))?;
    let branch_id = repo
      .rev_parse_single(branch.as_str())
      .map_err(|e| napi::Error::from_reason(format!("Branch not found: {e}")))?;

    // is_merged: branch is fully merged into base when their merge-base equals
    // the branch tip (i.e. branch tip is reachable from base).
    let merge_base_id = repo
      .merge_base(base_id, branch_id)
      .map_err(|e| napi::Error::from_reason(format!("Failed to compute merge base: {e}")))?;
    let is_merged_into_base = merge_base_id == branch_id.detach();

    // Diff the merge-base tree against the branch tip tree to mirror the
    // semantics of `git diff base...branch`.
    let mb_tree = repo
      .find_object(merge_base_id)
      .ok()
      .and_then(|o| o.try_into_commit().ok())
      .and_then(|c| c.tree().ok());
    let br_tree = repo
      .find_object(branch_id.detach())
      .ok()
      .and_then(|o| o.try_into_commit().ok())
      .and_then(|c| c.tree().ok());

    let (lines_added, lines_deleted) = match (mb_tree, br_tree) {
      (Some(t1), Some(t2)) => diff_trees_total_lines(&t1, &t2)?,
      _ => (0, 0),
    };

    // Upstream check: has refs/remotes/origin/<branch> ?
    let has_remote_branch = repo
      .find_reference(&format!("refs/remotes/origin/{}", branch))
      .is_ok();

    Ok::<_, napi::Error>((
      lines_added,
      lines_deleted,
      has_remote_branch,
      is_merged_into_base,
    ))
  })?;

  let (lines_added, lines_deleted, has_remote_branch, is_merged_into_base) = result;

  // Commit counts use rev-list outside of with_repo to avoid blocking the
  // repo lock while shelling out.
  let cwd_path = Path::new(&cwd_clone);
  let (unpushed_commit_count, unpulled_commit_count) = if has_remote_branch {
    // Match the History tab: commits on this branch not on any remote ref.
    let ahead = rev_list_count_args(
      cwd_path,
      &["rev-list", "--count", branch.as_str(), "--not", "--remotes"],
    );
    let behind_range = format!("{}..origin/{}", branch, branch);
    let behind = rev_list_count_args(cwd_path, &["rev-list", "--count", behind_range.as_str()]);
    (ahead, behind)
  } else {
    let range = format!("{}..{}", base_branch, branch);
    let ahead = rev_list_count_args(cwd_path, &["rev-list", "--count", range.as_str()]);
    (ahead, 0)
  };

  Ok(BranchSummaryResult {
    lines_added,
    lines_deleted,
    unpushed_commit_count,
    unpulled_commit_count,
    has_remote_branch,
    is_merged_into_base,
  })
}
