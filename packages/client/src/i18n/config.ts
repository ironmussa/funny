import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '../locales/en/translation.json';
import es from '../locales/es/translation.json';
import pt from '../locales/pt/translation.json';

const resources = {
  en: { translation: en },
  es: { translation: es },
  pt: { translation: pt },
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'en', // default language
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes values
  },
});

export default i18n;
