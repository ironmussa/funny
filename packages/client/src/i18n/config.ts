import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// English is the default and the fallback, so it ships in the main bundle.
// The other languages (~65 KB of JSON each) load only when someone picks them.
import en from '../locales/en/translation.json';

export const SUPPORTED_LANGUAGES = ['en', 'es', 'pt'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

type TranslationModule = { default: Record<string, unknown> };
const LAZY_TRANSLATIONS: Record<
  Exclude<SupportedLanguage, 'en'>,
  () => Promise<TranslationModule>
> = {
  es: () => import('../locales/es/translation.json'),
  pt: () => import('../locales/pt/translation.json'),
};

i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en', // default language
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes values
  },
});

/** Load a language's translations if needed, then switch to it. */
export async function changeLanguage(code: string): Promise<void> {
  const load = LAZY_TRANSLATIONS[code as keyof typeof LAZY_TRANSLATIONS];
  if (load && !i18n.hasResourceBundle(code, 'translation')) {
    const translations = await load();
    i18n.addResourceBundle(code, 'translation', translations.default, true, true);
  }
  await i18n.changeLanguage(code);
}

export default i18n;
