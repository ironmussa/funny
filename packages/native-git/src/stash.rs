use gix::bstr::ByteSlice;

use crate::commit_info::{commit_files_for_hash, CommitFileEntry};
use crate::file_diff::commit_file_diff_inner;
use crate::log::format_relative_date;
use crate::repo_cache::with_repo;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct StashEntry {
  pub index: String,
  pub message: String,
  pub relative_date: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct StashFileEntry {
  pub path: String,
  pub additions: u32,
  pub deletions: u32,
}

/// Parse "stash@{N}" → N. Returns None for unrecognized syntax.
fn parse_stash_index(stash_ref: &str) -> Option<usize> {
  let s = stash_ref.strip_prefix("stash@{")?.strip_suffix("}")?;
  s.parse::<usize>().ok()
}

/// Resolve a stash ref like "stash@{0}" to its commit OID.
///
/// We walk the reflog of `refs/stash` in reverse (newest first) and pick the
/// Nth entry's `new_oid`. `stash@{0}` is the most recent stash, matching git's
/// own indexing.
fn resolve_stash_oid(repo: &gix::Repository, stash_ref: &str) -> Option<gix::ObjectId> {
  let target_idx = if stash_ref == "stash" || stash_ref == "refs/stash" {
    0
  } else {
    parse_stash_index(stash_ref)?
  };

  let reference = repo.find_reference("refs/stash").ok()?;
  let mut platform = reference.log_iter();
  let iter = platform.rev().ok()??;

  for (i, line_result) in iter.enumerate() {
    let line = line_result.ok()?;
    if i == target_idx {
      return Some(line.new_oid.to_owned());
    }
  }
  None
}

#[napi]
pub async fn get_stash_list(cwd: String) -> napi::Result<Vec<StashEntry>> {
  with_repo(&cwd, |repo| {
    let reference = match repo.find_reference("refs/stash") {
      Ok(r) => r,
      Err(_) => return Ok(Vec::new()),
    };

    let mut platform = reference.log_iter();
    let iter = match platform.rev() {
      Ok(Some(iter)) => iter,
      _ => return Ok(Vec::new()),
    };

    let mut entries = Vec::new();
    for (idx, line_result) in iter.enumerate() {
      let line = match line_result {
        Ok(l) => l,
        Err(_) => continue,
      };

      let message = line.message.to_str_lossy().to_string();
      let time_seconds = line.signature.time.seconds;

      entries.push(StashEntry {
        index: format!("stash@{{{}}}", idx),
        message,
        relative_date: format_relative_date(time_seconds),
      });
    }
    Ok(entries)
  })
}

#[napi]
pub async fn get_stash_show(cwd: String, stash_ref: String) -> napi::Result<Vec<StashFileEntry>> {
  with_repo(&cwd, |repo| {
    let oid = match resolve_stash_oid(repo, &stash_ref) {
      Some(o) => o,
      None => return Ok(Vec::new()),
    };
    let hex = oid.to_string();
    let files = commit_files_for_hash(repo, &hex)?;
    let result: Vec<StashFileEntry> = files
      .into_iter()
      .map(|f: CommitFileEntry| StashFileEntry {
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
      })
      .collect();
    Ok(result)
  })
}

#[napi]
pub async fn get_stash_file_diff(
  cwd: String,
  stash_ref: String,
  file_path: String,
) -> napi::Result<String> {
  with_repo(&cwd, |repo| {
    let oid = match resolve_stash_oid(repo, &stash_ref) {
      Some(o) => o,
      None => return Ok(String::new()),
    };
    let hex = oid.to_string();
    commit_file_diff_inner(repo, &hex, &file_path)
  })
}
