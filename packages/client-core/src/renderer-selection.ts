export type ClientRenderer = 'web' | 'gpuix';

export function selectClientRenderer(arguments_: readonly string[]): ClientRenderer {
  const explicit = arguments_
    .find((argument) => argument.startsWith('--renderer='))
    ?.slice('--renderer='.length);
  if (explicit === undefined || explicit === 'web') return 'web';
  if (explicit === 'gpuix') return 'gpuix';
  throw new Error(`Unknown client renderer: ${explicit}. Expected web or gpuix.`);
}
