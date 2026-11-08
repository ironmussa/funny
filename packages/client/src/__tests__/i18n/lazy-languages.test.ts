import { afterEach, describe, expect, test } from 'vitest';

import i18n, { changeLanguage, SUPPORTED_LANGUAGES } from '@/i18n/config';

describe('lazy language bundles', () => {
  afterEach(async () => {
    await changeLanguage('en');
  });

  test('only English ships in the initial resources', () => {
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(true);
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(false);
    expect(i18n.hasResourceBundle('pt', 'translation')).toBe(false);
  });

  test('every supported language is still offered', () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(['en', 'es', 'pt']);
  });

  test('a language loads its translations the first time it is chosen', async () => {
    const key = 'settings.language';
    const english = i18n.t(key);

    await changeLanguage('es');

    expect(i18n.language).toBe('es');
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(true);
    expect(i18n.t(key)).not.toBe(english);
    expect(i18n.t(key)).not.toBe(key);
  });
});
