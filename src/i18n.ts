export type Lang = 'de' | 'en';

export const base = import.meta.env.BASE_URL.replace(/\/$/, '');

export const paths = {
  de: { home: `${base}/`, rules: `${base}/spielregeln/`, legal: `${base}/impressum/`, privacy: `${base}/datenschutz/` },
  en: { home: `${base}/en/`, rules: `${base}/en/rules/`, legal: `${base}/en/legal-notice/`, privacy: `${base}/en/privacy/` },
} as const;

export type PageKey = keyof typeof paths.de;

export const ui = {
  de: {
    siteName: 'Rummy',
    tagline: 'Rommé mit Plättchen',
    navHome: 'Start',
    navRules: 'Spielregeln',
    navLegal: 'Impressum',
    navPrivacy: 'Datenschutz',
    otherLang: 'English',
    footer: 'Rummy ist ein Spiel von Robert Peringer.',
    skip: 'Zum Inhalt springen',
  },
  en: {
    siteName: 'Rummy',
    tagline: 'Tile rummy',
    navHome: 'Home',
    navRules: 'Rules',
    navLegal: 'Legal notice',
    navPrivacy: 'Privacy',
    otherLang: 'Deutsch',
    footer: 'Rummy is a game by Robert Peringer.',
    skip: 'Skip to content',
  },
} as const;
