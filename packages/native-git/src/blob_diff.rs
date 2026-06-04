use std::ops::Range;

use gix::diff::blob::{diff_with_slider_heuristics, Diff, Algorithm, InternedInput};

fn is_binary_blob(data: &[u8]) -> bool {
  if data.is_empty() {
    return false;
  }
  let check = data.len().min(8192);
  data[..check].contains(&0)
}

/// Count added/deleted lines between two blobs (Git histogram, no slider post-processing).
pub(crate) fn count_diff_lines(old: &[u8], new: &[u8]) -> (u32, u32) {
  if is_binary_blob(old) || is_binary_blob(new) {
    return (0, 0);
  }
  let input = InternedInput::new(old, new);
  let diff = Diff::compute(Algorithm::Histogram, &input);
  (diff.count_additions(), diff.count_removals())
}

/// Hunk ranges (token indices = lines) for unified diff formatting.
pub(crate) fn diff_hunks(old: &[u8], new: &[u8]) -> Vec<(Range<u32>, Range<u32>)> {
  if is_binary_blob(old) || is_binary_blob(new) {
    return Vec::new();
  }
  let input = InternedInput::new(old, new);
  let diff = diff_with_slider_heuristics(Algorithm::Histogram, &input);
  diff
    .hunks()
    .map(|h| (h.before, h.after))
    .collect()
}
