use crate::repo_cache::with_repo;

/// Cheap, in-process fingerprint of the git state that a thread's status
/// summary depends on, apart from working-tree edits:
///
/// - `HEAD`: the symbolic ref it points to and the commit it resolves to.
/// - `refs/remotes/origin/<branch>` and the configured upstream of the
///   checked-out branch (remote presence, ahead/behind).
/// - Each ref in `extra_refs` (e.g. the base branch and its remote, for
///   ahead-of-base / merged checks).
/// - The modification time and size of the repository's index file.
///
/// The git watcher compares fingerprints to emit `git:changed` only for the
/// threads whose state actually moved, instead of recomputing the full status
/// of every thread in the project on any `.git/` change. The format is opaque:
/// callers must only compare two fingerprints for equality.
#[napi]
pub async fn get_ref_fingerprint(cwd: String, extra_refs: Vec<String>) -> napi::Result<String> {
  with_repo(&cwd, |repo| {
    let mut parts: Vec<String> = Vec::with_capacity(extra_refs.len() + 3);

    let head_name = repo
      .head_name()
      .map_err(|e| napi::Error::from_reason(format!("Failed to read HEAD: {e}")))?;
    let head_id = repo.head_id().ok().map(|id| id.to_string());
    parts.push(format!(
      "HEAD={}@{}",
      head_name.as_ref().map(|n| n.as_bstr().to_string()).unwrap_or_default(),
      head_id.unwrap_or_default()
    ));

    if let Some(name) = head_name.as_ref() {
      // The status summary checks `refs/remotes/origin/<branch>` directly,
      // so track it even when no upstream is configured (push without -u).
      let origin_ref = format!("refs/remotes/origin/{}", name.as_ref().shorten());
      parts.push(format!("{}={}", origin_ref, resolve_ref(repo, &origin_ref)));

      let upstream = repo
        .branch_remote_tracking_ref_name(name.as_ref(), gix::remote::Direction::Fetch)
        .and_then(Result::ok)
        .map(|n| n.as_bstr().to_string())
        .filter(|upstream| *upstream != origin_ref);
      if let Some(upstream) = upstream {
        parts.push(format!("{}={}", upstream, resolve_ref(repo, &upstream)));
      }
    }

    for name in &extra_refs {
      parts.push(format!("{}={}", name, resolve_ref(repo, name)));
    }

    let index = match std::fs::metadata(repo.index_path()) {
      Ok(meta) => {
        let mtime = meta
          .modified()
          .ok()
          .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
          .map(|d| d.as_nanos())
          .unwrap_or(0);
        format!("{}:{}", mtime, meta.len())
      }
      Err(_) => "-".to_string(),
    };
    parts.push(format!("index={index}"));

    Ok(parts.join("\n"))
  })
}

/// Resolve a ref name to the object it peels to, or `-` when it does not exist.
fn resolve_ref(repo: &gix::Repository, name: &str) -> String {
  match repo.try_find_reference(name) {
    Ok(Some(mut reference)) => reference
      .peel_to_id()
      .map(|id| id.to_string())
      .unwrap_or_else(|_| "?".to_string()),
    _ => "-".to_string(),
  }
}
