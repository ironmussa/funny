import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execute } from '@funny/core/git';

export async function createCorrectnessFixture(root: string): Promise<void> {
  await Promise.all([
    writeFixtureFile(
      root,
      'src/UserService.ts',
      [
        'export class UserService {}',
        'export const greeting = "hello world";',
        'export const title = "Hello World";',
        'export const joined = "helloworld";',
        '',
      ].join('\n'),
    ),
    writeFixtureFile(root, 'src/user-service.test.ts', 'test("hello world", () => {});\n'),
    writeFixtureFile(root, 'src/account-controller.ts', 'export function accountController() {}\n'),
    writeFixtureFile(root, 'docs/guide.md', '# Guide\nhello world\n'),
    writeFixtureFile(root, 'ignored/secret.ts', 'export const secret = "hello world";\n'),
    writeFixtureFile(root, '.gitignore', 'ignored/\n'),
  ]);
  await execute('git', ['init', '--quiet'], { cwd: root });
  await execute('git', ['add', '.'], { cwd: root });
}

export async function createLargeFixture(root: string, fileCount: number): Promise<void> {
  await writeFixtureFile(root, '.gitignore', 'ignored/\n');
  const batchSize = 500;
  for (let offset = 0; offset < fileCount; offset += batchSize) {
    const batch: Array<Promise<void>> = [];
    for (let index = offset; index < Math.min(offset + batchSize, fileCount); index += 1) {
      const group = String(index % 100).padStart(3, '0');
      const extension = index % 7 === 0 ? 'md' : 'ts';
      const marker = index % 97 === 0 ? 'shared benchmark needle' : 'ordinary fixture content';
      batch.push(
        writeFixtureFile(
          root,
          `packages/group-${group}/src/generated-component-${String(index).padStart(6, '0')}.${extension}`,
          `export const generated${index} = ${JSON.stringify(`${marker} ${index}`)};\n`,
        ),
      );
    }
    await Promise.all(batch);
  }
  await execute('git', ['init', '--quiet'], { cwd: root });
  await execute('git', ['add', '.'], { cwd: root });
}

async function writeFixtureFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, contents, 'utf8');
}
