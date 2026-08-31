export const PRODUCT_BENCHMARK_FILE_COUNT = 1_200;

export function makeProductBenchmarkFileTree(): string[] {
  return Array.from({ length: PRODUCT_BENCHMARK_FILE_COUNT }, (_, index) => {
    const area = `area-${Math.floor(index / 100)
      .toString()
      .padStart(2, '0')}`;
    const feature = `feature-${Math.floor((index % 100) / 10)}`;
    return `packages/${area}/src/${feature}/file-${index.toString().padStart(4, '0')}.tsx`;
  });
}

export function productBenchmarkStreamingContent(revision: number): string {
  const safeRevision = Math.max(0, Math.floor(revision));
  const tokens = Array.from(
    { length: safeRevision },
    (_, index) => `token-${(index + 1).toString().padStart(2, '0')}`,
  );
  return ['## Live benchmark stream', '', tokens.join(' ')].join('\n');
}
