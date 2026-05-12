import vscodeIcons from '@iconify-json/vscode-icons/icons.json';
import { Icon, addCollection } from '@iconify/react/offline';

addCollection(vscodeIcons);

const DEFAULT_FILE_ICON = 'vscode-icons:default-file';
const DEFAULT_FOLDER_ICON = 'vscode-icons:default-folder';
const DEFAULT_FOLDER_OPEN_ICON = 'vscode-icons:default-folder-opened';

const FILE_NAME_ICON_MAP: Record<string, string> = {
  '.dockerignore': 'vscode-icons:file-type-docker',
  '.env': 'vscode-icons:file-type-dotenv',
  '.gitattributes': 'vscode-icons:file-type-git',
  '.gitignore': 'vscode-icons:file-type-git',
  '.gitmodules': 'vscode-icons:file-type-git',
  'bun.lock': 'vscode-icons:file-type-bun',
  'bunfig.toml': 'vscode-icons:file-type-bunfig',
  containerfile: 'vscode-icons:file-type-docker',
  dockerfile: 'vscode-icons:file-type-docker',
  license: 'vscode-icons:file-type-license',
  'package-lock.json': 'vscode-icons:file-type-npm',
  'package.json': 'vscode-icons:file-type-node',
  'pnpm-lock.yaml': 'vscode-icons:file-type-pnpm',
  'pnpm-lock.yml': 'vscode-icons:file-type-pnpm',
  'yarn.lock': 'vscode-icons:file-type-yarn',
  'tsconfig.json': 'vscode-icons:file-type-tsconfig',
};

const FILE_EXTENSION_ICON_MAP: Record<string, string> = {
  cjs: 'vscode-icons:file-type-js',
  css: 'vscode-icons:file-type-css',
  go: 'vscode-icons:file-type-go',
  html: 'vscode-icons:file-type-html',
  ini: 'vscode-icons:file-type-ini',
  js: 'vscode-icons:file-type-js',
  json: 'vscode-icons:file-type-json',
  jsx: 'vscode-icons:file-type-reactjs',
  md: 'vscode-icons:file-type-markdown',
  mjs: 'vscode-icons:file-type-js',
  mdx: 'vscode-icons:file-type-mdx',
  php: 'vscode-icons:file-type-php',
  py: 'vscode-icons:file-type-python',
  rs: 'vscode-icons:file-type-rust',
  scss: 'vscode-icons:file-type-scss',
  sh: 'vscode-icons:file-type-shell',
  sql: 'vscode-icons:file-type-sql',
  svg: 'vscode-icons:file-type-svg',
  toml: 'vscode-icons:file-type-toml',
  ts: 'vscode-icons:file-type-typescript',
  tsx: 'vscode-icons:file-type-reactts',
  xml: 'vscode-icons:file-type-xml',
  yaml: 'vscode-icons:file-type-yaml',
  yml: 'vscode-icons:file-type-yaml',
};

const FOLDER_ICON_MAP: Record<string, { closed: string; open: string }> = {
  '.github': {
    closed: 'vscode-icons:folder-type-github',
    open: 'vscode-icons:folder-type-github-opened',
  },
  '.storybook': {
    closed: 'vscode-icons:folder-type-config',
    open: 'vscode-icons:folder-type-config-opened',
  },
  __tests__: {
    closed: 'vscode-icons:folder-type-test',
    open: 'vscode-icons:folder-type-test-opened',
  },
  config: {
    closed: 'vscode-icons:folder-type-config',
    open: 'vscode-icons:folder-type-config-opened',
  },
  dist: {
    closed: 'vscode-icons:folder-type-dist',
    open: 'vscode-icons:folder-type-dist-opened',
  },
  docs: {
    closed: 'vscode-icons:folder-type-docs',
    open: 'vscode-icons:folder-type-docs-opened',
  },
  images: {
    closed: 'vscode-icons:folder-type-images',
    open: 'vscode-icons:folder-type-images-opened',
  },
  node_modules: {
    closed: 'vscode-icons:folder-type-node',
    open: 'vscode-icons:folder-type-node-opened',
  },
  packages: {
    closed: 'vscode-icons:folder-type-package',
    open: 'vscode-icons:folder-type-package-opened',
  },
  public: {
    closed: 'vscode-icons:folder-type-public',
    open: 'vscode-icons:folder-type-public-opened',
  },
  scripts: {
    closed: 'vscode-icons:folder-type-script',
    open: 'vscode-icons:folder-type-script-opened',
  },
  src: {
    closed: 'vscode-icons:folder-type-src',
    open: 'vscode-icons:folder-type-src-opened',
  },
  test: {
    closed: 'vscode-icons:folder-type-test',
    open: 'vscode-icons:folder-type-test-opened',
  },
  tests: {
    closed: 'vscode-icons:folder-type-test',
    open: 'vscode-icons:folder-type-test-opened',
  },
};

export function getFileIconName(filePath: string): string {
  const fileName = filePath.split('/').pop()?.toLowerCase() ?? '';

  if (fileName.startsWith('.env')) {
    return 'vscode-icons:file-type-dotenv';
  }

  if (fileName.startsWith('readme')) {
    return 'vscode-icons:file-type-markdown';
  }

  if (fileName.startsWith('vite.config.')) {
    return 'vscode-icons:file-type-vite';
  }

  if (fileName.startsWith('vitest.config.')) {
    return 'vscode-icons:file-type-vitest';
  }

  if (fileName.startsWith('tailwind.config.')) {
    return 'vscode-icons:file-type-tailwind';
  }

  if (fileName.startsWith('playwright.config.')) {
    return 'vscode-icons:file-type-playwright';
  }

  if (fileName.startsWith('storybook.')) {
    return 'vscode-icons:file-type-storybook';
  }

  if (fileName.startsWith('eslint.config.') || fileName === '.eslintrc') {
    return 'vscode-icons:file-type-eslint';
  }

  if (
    fileName.startsWith('prettier.config.') ||
    fileName === '.prettierrc' ||
    fileName === '.prettierignore'
  ) {
    return 'vscode-icons:file-type-prettier';
  }

  if (fileName.startsWith('.husky')) {
    return 'vscode-icons:file-type-husky';
  }

  if (fileName.includes('docker-compose') || fileName.includes('podman-compose')) {
    return 'vscode-icons:file-type-docker';
  }

  if (fileName.endsWith('.test.ts') || fileName.endsWith('.test.tsx')) {
    return 'vscode-icons:file-type-testts';
  }

  if (fileName.endsWith('.spec.ts') || fileName.endsWith('.spec.tsx')) {
    return 'vscode-icons:file-type-testts';
  }

  const namedIcon = FILE_NAME_ICON_MAP[fileName];
  if (namedIcon) {
    return namedIcon;
  }

  const extension = fileName.includes('.') ? fileName.split('.').pop() : null;
  if (!extension) {
    return DEFAULT_FILE_ICON;
  }

  return FILE_EXTENSION_ICON_MAP[extension] ?? DEFAULT_FILE_ICON;
}

export function getFolderIconName(folderPath: string, isOpen = false): string {
  const segments = folderPath.split('/').flatMap((segment) => {
    const lower = segment.toLowerCase();
    return lower ? [lower] : [];
  });

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const match = FOLDER_ICON_MAP[segments[index]];
    if (match) {
      return isOpen ? match.open : match.closed;
    }
  }

  return isOpen ? DEFAULT_FOLDER_OPEN_ICON : DEFAULT_FOLDER_ICON;
}

export function FileExtensionIcon({
  filePath,
  className,
}: {
  filePath: string;
  className?: string;
}) {
  return <Icon icon={getFileIconName(filePath)} className={className} aria-hidden="true" />;
}

export function FolderIcon({
  folderPath,
  isOpen = false,
  className,
}: {
  folderPath: string;
  isOpen?: boolean;
  className?: string;
}) {
  return (
    <Icon icon={getFolderIconName(folderPath, isOpen)} className={className} aria-hidden="true" />
  );
}
