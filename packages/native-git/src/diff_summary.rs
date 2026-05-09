use std::collections::HashSet;
use std::path::Path;

use gix::bstr::{BString, ByteSlice};

use crate::commit_info::{count_diff_lines, count_lines};
use crate::repo_cache::with_repo;

/// Skip line-counting for untracked/working-tree files larger than this.
/// Mirrors `MAX_UNTRACKED_FILE_SIZE` in status_summary.rs and
/// `shouldSkipUntrackedDiff` on the TS side.
const MAX_LINECOUNT_FILE_SIZE: u64 = 512 * 1024;

/// True if the nested git repo at `nested_path` has any uncommitted changes.
/// Used to surface dirtiness for gitlinks that aren't registered in `.gitmodules`
/// (gix's own submodule status only inspects entries listed there, so stranded
/// gitlinks are otherwise invisible to `getDiffSummary`).
fn is_nested_repo_dirty(nested_path: &Path) -> bool {
  std::process::Command::new("git")
    .args(["status", "--porcelain"])
    .current_dir(nested_path)
    .output()
    .ok()
    .map(|o| o.status.success() && !o.stdout.is_empty())
    .unwrap_or(false)
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct FileDiffSummaryItem {
  pub path: String,
  pub status: String,
  pub staged: bool,
  pub additions: u32,
  pub deletions: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct DiffSummaryResult {
  pub files: Vec<FileDiffSummaryItem>,
  pub total: u32,
  pub truncated: bool,
}

/// Check if a path matches any of the exclude patterns (simple suffix/contains matching).
fn matches_any_pattern(path: &str, patterns: &[String]) -> bool {
  for pat in patterns {
    if path.contains(pat.as_str()) {
      return true;
    }
  }
  false
}

/// Read a blob's bytes by ObjectId, returning empty on error.
fn read_blob(repo: &gix::Repository, oid: gix::ObjectId) -> Vec<u8> {
  repo
    .find_object(oid)
    .ok()
    .map(|obj| obj.detach().data)
    .unwrap_or_default()
}

/// Read a worktree file with size cap; returns None for missing files
/// or files larger than `MAX_LINECOUNT_FILE_SIZE`.
fn read_worktree_file(worktree_path: &Path, rel_path: &str) -> Option<Vec<u8>> {
  let disk_path = worktree_path.join(rel_path);
  let meta = std::fs::metadata(&disk_path).ok()?;
  if meta.len() > MAX_LINECOUNT_FILE_SIZE {
    return None;
  }
  std::fs::read(&disk_path).ok()
}

#[napi]
pub async fn get_diff_summary(
  cwd: String,
  exclude_patterns: Option<Vec<String>>,
  max_files: Option<u32>,
) -> napi::Result<DiffSummaryResult> {
  with_repo(&cwd, |repo| {
    let exclude = exclude_patterns.unwrap_or_default();
    let max = max_files.unwrap_or(0) as usize;
    let cwd_path = Path::new(&cwd);

    // Open the index up front so Phase 1 can look up old blobs without an
    // O(n²) scan inside the status loop (build path -> oid map once).
    let index = repo
      .open_index()
      .map_err(|e| napi::Error::from_reason(format!("Failed to open index: {e}")))?;
    let index_oid_by_path: std::collections::HashMap<String, gix::ObjectId> = index
      .entries()
      .iter()
      .map(|e| (e.path(&index).to_str_lossy().to_string(), e.id))
      .collect();

    let status_platform = repo
      .status(gix::progress::Discard)
      .map_err(|e| napi::Error::from_reason(format!("Failed to create status: {e}")))?
      .untracked_files(gix::status::UntrackedFiles::Files)
      // Force submodule dirtiness checks regardless of `diff.ignoreSubmodules`
      // or the submodule's own `ignore` setting. Without this, registered
      // submodules with default config can be reported as clean even when
      // their working tree has uncommitted changes.
      .index_worktree_submodules(gix::status::Submodule::Given {
        ignore: gix::submodule::config::Ignore::None,
        check_dirty: true,
      });

    // into_index_worktree_iter takes pathspec patterns (empty = all files)
    let empty_patterns: Vec<BString> = Vec::new();
    let status_iter = status_platform
      .into_index_worktree_iter(empty_patterns)
      .map_err(|e| napi::Error::from_reason(format!("Failed to iterate status: {e}")))?;

    let mut all_files: Vec<FileDiffSummaryItem> = Vec::new();
    let mut worktree_changed_paths = HashSet::new();

    for entry in status_iter {
      let entry = entry
        .map_err(|e| napi::Error::from_reason(format!("Status iteration error: {e}")))?;

      // Returns (path, status, is_untracked). For Modification entries the
      // line counts come from index-blob vs worktree-file diffing. For
      // DirectoryContents (untracked) and Rewrite, we count newlines in the
      // worktree file as additions.
      let (path, status, is_untracked) = match &entry {
        gix::status::index_worktree::Item::Modification { rela_path, status, .. } => {
          let p = rela_path.to_string();
          use gix_status::index_as_worktree::EntryStatus;
          use gix_status::index_as_worktree::Change;
          let s = match status {
            EntryStatus::Conflict { .. } => "conflicted",
            EntryStatus::Change(change) => match change {
              Change::Removed => "deleted",
              Change::Type { .. } => "modified",
              Change::Modification { .. } => "modified",
              Change::SubmoduleModification(_) => "modified",
            },
            EntryStatus::NeedsUpdate(_) => "modified",
            EntryStatus::IntentToAdd => "added",
          };
          (p, s.to_string(), false)
        }
        gix::status::index_worktree::Item::DirectoryContents { entry: dir_entry, .. } => {
          let p = dir_entry.rela_path.to_string();
          (p, "added".to_string(), true)
        }
        gix::status::index_worktree::Item::Rewrite { dirwalk_entry, .. } => {
          let p = dirwalk_entry.rela_path.to_string();
          (p, "renamed".to_string(), true)
        }
      };

      if !exclude.is_empty() && matches_any_pattern(&path, &exclude) {
        continue;
      }

      // Compute additions/deletions. Skip submodule path entries (gitlinks
      // appear as Modification but have no meaningful line diff).
      let (additions, deletions) = if cwd_path.join(&path).join(".git").exists() {
        (0, 0)
      } else if status == "deleted" {
        // Deleted in worktree: lines = old blob's line count.
        let old = index_oid_by_path
          .get(&path)
          .map(|oid| read_blob(repo, *oid))
          .unwrap_or_default();
        (0, count_lines(&old))
      } else if status == "renamed" {
        // Renames: rename detection isn't enabled by default in
        // `into_index_worktree_iter`, but if it ever is, the worktree path
        // here points to the *new* file. Diffing it against an empty blob
        // would overcount (whole file = additions). Mirror CLI numstat
        // behavior for pure renames and report 0/0 conservatively.
        (0, 0)
      } else if is_untracked {
        // Untracked file: count its newlines as additions (size-capped).
        match read_worktree_file(cwd_path, &path) {
          Some(data) => (count_lines(&data), 0),
          None => (0, 0),
        }
      } else if status == "conflicted" {
        // Conflicted files have no meaningful line counts here.
        (0, 0)
      } else {
        // Modified tracked file: index blob vs worktree file.
        let old = index_oid_by_path
          .get(&path)
          .map(|oid| read_blob(repo, *oid))
          .unwrap_or_default();
        match read_worktree_file(cwd_path, &path) {
          Some(new) => count_diff_lines(&old, &new),
          None => (0, 0),
        }
      };

      worktree_changed_paths.insert(path.clone());
      all_files.push(FileDiffSummaryItem {
        path,
        status,
        staged: false,
        additions,
        deletions,
      });
    }

    // ── Phase 2: HEAD-vs-index changes (staged) ──
    // Detects files staged in the index that differ from HEAD (or all index
    // entries when HEAD doesn't exist, e.g. repos with no commits yet).
    let head_tree = repo.head_commit().ok().and_then(|c| c.tree().ok());

    for entry in index.entries().iter() {
      let path_str = entry.path(&index).to_str_lossy().to_string();

      // Skip files already reported as worktree changes
      if worktree_changed_paths.contains(&path_str) {
        continue;
      }

      // Returns (is_staged, status, head_blob_oid).
      let (is_staged, status, head_oid) = match &head_tree {
        Some(tree) => match tree.lookup_entry_by_path(&path_str) {
          Ok(Some(tree_entry)) => {
            if tree_entry.object_id() == entry.id {
              (false, "", None)
            } else {
              (true, "modified", Some(tree_entry.object_id()))
            }
          }
          _ => (true, "added", None),
        },
        None => (true, "added", None),
      };

      if !is_staged {
        continue;
      }

      if !exclude.is_empty() && matches_any_pattern(&path_str, &exclude) {
        continue;
      }

      // Compute additions/deletions for staged-only changes.
      let (additions, deletions) = if entry.mode.is_submodule() {
        (0, 0)
      } else {
        let new = read_blob(repo, entry.id);
        match head_oid {
          Some(oid) => {
            let old = read_blob(repo, oid);
            count_diff_lines(&old, &new)
          }
          None => (count_lines(&new), 0),
        }
      };

      all_files.push(FileDiffSummaryItem {
        path: path_str,
        status: status.to_string(),
        staged: true,
        additions,
        deletions,
      });
    }

    // ── Phase 3: stranded gitlinks ──
    // gix's submodule status only inspects entries listed in `.gitmodules`,
    // so a gitlink (mode 160000) without a `.gitmodules` registration is
    // invisible to Phase 1, even if its nested working tree is dirty.
    // Detect those by scanning the index for COMMIT-mode entries that haven't
    // been reported yet, and shelling out to `git status` in the nested repo
    // to decide whether to surface them as modified.
    let already_reported: HashSet<String> = all_files.iter().map(|f| f.path.clone()).collect();
    for entry in index.entries().iter() {
      if !entry.mode.is_submodule() {
        continue;
      }
      let path_str = entry.path(&index).to_str_lossy().to_string();
      if worktree_changed_paths.contains(&path_str) || already_reported.contains(&path_str) {
        continue;
      }
      let nested = cwd_path.join(&path_str);
      if !nested.join(".git").exists() {
        continue;
      }
      if !is_nested_repo_dirty(&nested) {
        continue;
      }
      if !exclude.is_empty() && matches_any_pattern(&path_str, &exclude) {
        continue;
      }
      all_files.push(FileDiffSummaryItem {
        path: path_str,
        status: "modified".to_string(),
        staged: false,
        additions: 0,
        deletions: 0,
      });
    }

    let total = all_files.len() as u32;
    let truncated = max > 0 && all_files.len() > max;
    if truncated {
      all_files.truncate(max);
    }

    Ok(DiffSummaryResult {
      files: all_files,
      total,
      truncated,
    })
  })
}
