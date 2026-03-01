#[napi]
pub async fn get_current_branch(cwd: String) -> napi::Result<Option<String>> {
  let repo = gix::open(&cwd)
    .map_err(|e| napi::Error::from_reason(format!("Failed to open repo: {e}")))?;

  let head_ref = repo
    .head_ref()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get HEAD: {e}")))?;

  Ok(head_ref.map(|r| r.name().shorten().to_string()))
}

#[napi]
pub async fn list_branches(cwd: String) -> napi::Result<Vec<String>> {
  let repo = gix::open(&cwd)
    .map_err(|e| napi::Error::from_reason(format!("Failed to open repo: {e}")))?;

  let refs = repo
    .references()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;

  let local_refs = refs
    .local_branches()
    .map_err(|e| napi::Error::from_reason(format!("Failed to list local branches: {e}")))?;

  let mut branches: Vec<String> = Vec::new();

  for reference in local_refs {
    if let Ok(r) = reference {
      branches.push(r.name().shorten().to_string());
    }
  }

  if branches.is_empty() {
    // Fall back to remote tracking branches
    let refs2 = repo
      .references()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;

    let remote_refs = refs2
      .remote_branches()
      .map_err(|e| napi::Error::from_reason(format!("Failed to list remote branches: {e}")))?;

    let mut seen = std::collections::HashSet::new();
    for reference in remote_refs {
      if let Ok(r) = reference {
        let name = r.name().shorten().to_string();
        if name.contains("HEAD") {
          continue;
        }
        // Strip "origin/" prefix
        let branch = if let Some(stripped) = name.strip_prefix("origin/") {
          stripped.to_string()
        } else {
          name
        };
        if seen.insert(branch.clone()) {
          branches.push(branch);
        }
      }
    }
  }

  if branches.is_empty() {
    // Fall back to symbolic ref for empty repos
    if let Ok(Some(head_ref)) = repo.head_ref() {
      branches.push(head_ref.name().shorten().to_string());
    }
  }

  Ok(branches)
}

#[napi]
pub async fn get_default_branch(cwd: String) -> napi::Result<Option<String>> {
  let repo = gix::open(&cwd)
    .map_err(|e| napi::Error::from_reason(format!("Failed to open repo: {e}")))?;

  // Try refs/remotes/origin/HEAD — it's a symbolic ref pointing to e.g. refs/remotes/origin/master
  if let Ok(origin_head) = repo.find_reference("refs/remotes/origin/HEAD") {
    // Follow the symbolic ref to get the actual target branch
    if let gix::refs::TargetRef::Symbolic(target_name) = origin_head.target() {
      let name = target_name.shorten().to_string();
      let branch = if let Some(stripped) = name.strip_prefix("origin/") {
        stripped.to_string()
      } else {
        name
      };
      return Ok(Some(branch));
    }
  }

  // Fall back to checking common branch names
  let refs = repo
    .references()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;

  let local_refs = refs
    .local_branches()
    .map_err(|e| napi::Error::from_reason(format!("Failed to list branches: {e}")))?;

  let mut branch_names: Vec<String> = Vec::new();
  for reference in local_refs {
    if let Ok(r) = reference {
      branch_names.push(r.name().shorten().to_string());
    }
  }

  if branch_names.contains(&"main".to_string()) {
    return Ok(Some("main".to_string()));
  }
  if branch_names.contains(&"master".to_string()) {
    return Ok(Some("master".to_string()));
  }
  if branch_names.contains(&"develop".to_string()) {
    return Ok(Some("develop".to_string()));
  }

  Ok(branch_names.first().cloned())
}
