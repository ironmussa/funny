use gix::bstr::ByteSlice;

use crate::repo_cache::with_repo;
use crate::status_summary::LineCounter;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CommitFileEntry {
  pub path: String,
  pub status: String,
  pub additions: u32,
  pub deletions: u32,
}

/// Recursively walk a tree, building a map of path -> blob OID.
fn build_tree_map(
  repo: &gix::Repository,
  tree: Option<&gix::Tree<'_>>,
) -> std::collections::HashMap<String, gix::ObjectId> {
  let mut map = std::collections::HashMap::new();
  if let Some(tree) = tree {
    walk_tree(repo, tree, "", &mut map);
  }
  map
}

fn walk_tree(
  _repo: &gix::Repository,
  tree: &gix::Tree<'_>,
  prefix: &str,
  map: &mut std::collections::HashMap<String, gix::ObjectId>,
) {
  for entry_result in tree.iter() {
    let entry = match entry_result {
      Ok(e) => e,
      Err(_) => continue,
    };
    let name = entry.filename().to_str_lossy().to_string();
    let full_path = if prefix.is_empty() {
      name
    } else {
      format!("{}/{}", prefix, name)
    };
    if entry.mode().is_tree() {
      if let Ok(obj) = entry.object() {
        let subtree = obj.into_tree();
        walk_tree(_repo, &subtree, &full_path, map);
      }
    } else if entry.mode().is_blob() {
      map.insert(full_path, entry.oid().to_owned());
    }
  }
}

pub(crate) fn count_lines(data: &[u8]) -> u32 {
  if data.is_empty() {
    return 0;
  }
  let check = data.len().min(8192);
  if data[..check].contains(&0) {
    return 0; // binary
  }
  let mut n: u32 = 0;
  for &b in data {
    if b == b'\n' {
      n += 1;
    }
  }
  if !data.is_empty() && data[data.len() - 1] != b'\n' {
    n += 1;
  }
  n
}

pub(crate) fn count_diff_lines(old: &[u8], new: &[u8]) -> (u32, u32) {
  let is_bin = |d: &[u8]| -> bool {
    if d.is_empty() {
      return false;
    }
    let c = d.len().min(8192);
    d[..c].contains(&0)
  };
  if is_bin(old) || is_bin(new) {
    return (0, 0);
  }

  let input = gix::diff::blob::intern::InternedInput::new(old, new);
  let counter = LineCounter::default();
  gix::diff::blob::diff(gix::diff::blob::Algorithm::Histogram, &input, counter)
}

#[napi]
pub async fn get_commit_files(cwd: String, hash: String) -> napi::Result<Vec<CommitFileEntry>> {
  with_repo(&cwd, |repo| {
    _get_commit_files_inner(repo, &hash)
  })
}

fn _get_commit_files_inner(repo: &gix::Repository, hash: &str) -> napi::Result<Vec<CommitFileEntry>> {
  let commit_id = repo
    .rev_parse_single(hash)
    .map_err(|e| napi::Error::from_reason(format!("Failed to parse revision: {e}")))?;
  let commit = commit_id
    .object()
    .map_err(|e| napi::Error::from_reason(format!("Failed to read object: {e}")))?
    .try_into_commit()
    .map_err(|e| napi::Error::from_reason(format!("Not a commit: {e}")))?;

  let commit_tree = commit
    .tree()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get commit tree: {e}")))?;

  // Get parent tree (None for root commits)
  let parent_tree = commit
    .parent_ids()
    .next()
    .and_then(|pid| pid.object().ok())
    .and_then(|obj| obj.try_into_commit().ok())
    .and_then(|pc| pc.tree().ok());

  let parent_entries = build_tree_map(repo, parent_tree.as_ref());
  let commit_entries = build_tree_map(repo, Some(&commit_tree));

  // Find all unique paths
  let mut all_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
  for path in parent_entries.keys() {
    all_paths.insert(path.clone());
  }
  for path in commit_entries.keys() {
    all_paths.insert(path.clone());
  }

  let mut files: Vec<CommitFileEntry> = Vec::new();

  for path in &all_paths {
    let old_id = parent_entries.get(path);
    let new_id = commit_entries.get(path);

    match (old_id, new_id) {
      (None, Some(nid)) => {
        // Added
        let new_blob = repo
          .find_object(*nid)
          .ok()
          .map(|o| o.detach().data)
          .unwrap_or_default();
        let additions = count_lines(&new_blob);
        files.push(CommitFileEntry {
          path: path.clone(),
          status: "added".to_string(),
          additions,
          deletions: 0,
        });
      }
      (Some(oid), None) => {
        // Deleted
        let old_blob = repo
          .find_object(*oid)
          .ok()
          .map(|o| o.detach().data)
          .unwrap_or_default();
        let deletions = count_lines(&old_blob);
        files.push(CommitFileEntry {
          path: path.clone(),
          status: "deleted".to_string(),
          additions: 0,
          deletions,
        });
      }
      (Some(oid), Some(nid)) if oid != nid => {
        // Modified
        let old_blob = repo
          .find_object(*oid)
          .ok()
          .map(|o| o.detach().data)
          .unwrap_or_default();
        let new_blob = repo
          .find_object(*nid)
          .ok()
          .map(|o| o.detach().data)
          .unwrap_or_default();
        let (additions, deletions) = count_diff_lines(&old_blob, &new_blob);
        files.push(CommitFileEntry {
          path: path.clone(),
          status: "modified".to_string(),
          additions,
          deletions,
        });
      }
      _ => {} // Same OID = unchanged
    }
  }

  files.sort_by(|a, b| a.path.cmp(&b.path));
  Ok(files)
}
