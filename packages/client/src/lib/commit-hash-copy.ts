interface CommitHashCopyTarget {
  hash: string;
  shortHash: string;
}

type WriteClipboardText = (text: string) => Promise<void>;

export async function copyCommitHashToClipboard(
  commit: CommitHashCopyTarget,
  writeText: WriteClipboardText = (text) => navigator.clipboard.writeText(text),
): Promise<string> {
  await writeText(commit.hash);
  return commit.shortHash;
}
