// This file has been automatically migrated to valid ESM format by Storybook.
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { StorybookConfig } from '@storybook/react-vite';

const __filename = fileURLToPath(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

function getAbsolutePath(value: string) {
  return dirname(fileURLToPath(import.meta.resolve(`${value}/package.json`)));
}

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: [
    getAbsolutePath('@storybook/addon-docs'),
    getAbsolutePath('@storybook/addon-onboarding'),
    getAbsolutePath('@storybook/addon-a11y'),
    getAbsolutePath('@chromatic-com/storybook'),
  ],
  framework: getAbsolutePath('@storybook/react-vite'),
  viteFinal: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': resolve(__dirname, '../src'),
    };
    return config;
  },
};

export default config;
