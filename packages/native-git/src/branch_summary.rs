use std::path::Path;

use gix::bstr::ByteSlice;

use crate::commit_info::{count_diff_lines, count_lines};
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

/// Build a flat path -> blob OID map by recursively walking a tree.
fn collect_tree_blobs(
  tree: &gix::Tree<'_>,
  prefix: &str,
  out: &mut std::collections::HashMap<String, gix::ObjectId>,
) {
  for entry_result in tree.iter() {
    let entry = match entry_result {
      Ok(e) => e,
      Err(_) => continue,
    };
    let name = entry.filename().to_str_lossy();
    let full = if prefix.is_empty() {
      name.into_owned()
    } else {
      format!("{}/{}", prefix, name)
    };
    if entry.mode().is_tree() {
      if let Ok(obj) = entry.object() {
        let subtree = obj.into_tree();
        collect_tree_blobs(&subtree, &full, out);
      }
    } else if entry.mode().is_blob() {
      out.insert(full, entry.oid().to_owned());
    }
  }
}

/// Sum line additions/deletions between two trees by diffing each blob pair.
/// Files only in `new` count as pure additions, files only in `old` as pure
/// deletions, modified files diff their blobs via `count_diff_lines`.
fn diff_trees_total_lines(
  repo: &gix::Repository,
  old: &gix::Tree<'_>,
  new: &gix::Tree<'_>,
) -> (u32, u32) {
  let mut old_map = std::collections::HashMap::new();
  let mut new_map = std::collections::HashMap::new();
  collect_tree_blobs(old, "", &mut old_map);
  collect_tree_blobs(new, "", &mut new_map);

  let mut added: u32 = 0;
  let mut deleted: u32 = 0;

  let read = |oid: gix::ObjectId| -> Vec<u8> {
    repo
      .find_object(oid)
      .ok()
      .map(|obj| obj.detach().data)
      .unwrap_or_default()
  };

  for (path, new_oid) in &new_map {
    match old_map.get(path) {
      None => {
        // Added file
        let bytes = read(*new_oid);
        added = added.saturating_add(count_lines(&bytes));
      }
      Some(old_oid) if old_oid == new_oid => {} // unchanged
      Some(old_oid) => {
        // Modified
        let o = read(*old_oid);
        let n = read(*new_oid);
        let (a, d) = count_diff_lines(&o, &n);
        added = added.saturating_add(a);
        deleted = deleted.saturating_add(d);
      }
    }
  }

  for (path, old_oid) in &old_map {
    if new_map.contains_key(path) {
      continue;
    }
    let bytes = read(*old_oid);
    deleted = deleted.saturating_add(count_lines(&bytes));
  }

  (added, deleted)
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
      (Some(t1), Some(t2)) => diff_trees_total_lines(repo, &t1, &t2),
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
