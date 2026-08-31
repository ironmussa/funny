export type NativeHostPlatform = 'darwin' | 'linux' | 'win32';
export type NativeHostArchitecture = 'arm64' | 'x64';

export interface NativeHostInput {
  platform: string;
  architecture: string;
  linuxLibc?: 'glibc' | 'musl' | 'unknown';
}

export type NativeHostSupport =
  | {
      supported: true;
      target: string;
      binaryPackage: string;
    }
  | {
      supported: false;
      reason: string;
      fallbackCommand: 'bun run dev:client';
    };

const TARGETS: Record<NativeHostPlatform, Record<NativeHostArchitecture, string>> = {
  darwin: {
    arm64: 'aarch64-apple-darwin',
    x64: 'x86_64-apple-darwin',
  },
  linux: {
    arm64: 'aarch64-unknown-linux-gnu',
    x64: 'x86_64-unknown-linux-gnu',
  },
  win32: {
    arm64: 'aarch64-pc-windows-msvc',
    x64: 'x86_64-pc-windows-msvc',
  },
};

function unsupported(reason: string): NativeHostSupport {
  return { supported: false, reason, fallbackCommand: 'bun run dev:client' };
}

export function detectNativeHostSupport(input: NativeHostInput): NativeHostSupport {
  if (!(input.platform in TARGETS)) {
    return unsupported(`GPUIX does not publish a native binary for ${input.platform}`);
  }
  if (input.architecture !== 'arm64' && input.architecture !== 'x64') {
    return unsupported(
      `GPUIX does not publish a ${input.platform}/${input.architecture} native binary`,
    );
  }
  if (input.platform === 'linux' && input.linuxLibc !== 'glibc') {
    return unsupported(
      `GPUIX 0.5.1 requires glibc on Linux; detected ${input.linuxLibc ?? 'unknown libc'}`,
    );
  }
  const platform = input.platform as NativeHostPlatform;
  const architecture = input.architecture as NativeHostArchitecture;
  const target = TARGETS[platform][architecture];
  const packageTarget =
    platform === 'darwin'
      ? `${platform}-${architecture}`
      : platform === 'win32'
        ? `${platform}-${architecture}-msvc`
        : `${platform}-${architecture}-gnu`;
  return {
    supported: true,
    target,
    binaryPackage: `@gpuix/native-${packageTarget}`,
  };
}

export function currentNativeHostInput(): NativeHostInput {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  return {
    platform: process.platform,
    architecture: process.arch,
    ...(process.platform === 'linux' ? { linuxLibc: glibc ? 'glibc' : 'unknown' } : {}),
  };
}
