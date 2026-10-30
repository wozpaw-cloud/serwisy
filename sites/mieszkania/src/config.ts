// Ustawienia serwisu. Panel zarządzania zmienia "ads" i "publish" przez commit.
export const SITE = {
  name: 'Cena od dewelopera',
  domain: 'cenaoddewelopera.pl',
  publisher: 'Proste Dane',
  publisherUrl: 'https://prostedane.pl',
  contactEmail: 'kontakt@prostedane.pl',
  /** Reklamy AdSense. Włączamy dopiero po akceptacji konta. */
  ads: process.env.ADS === '1',
  adsClient: process.env.ADSENSE_CLIENT ?? '',
  /** Minimalna liczba lokali w ofercie, żeby miasto dostało własną stronę. */
  minCityUnits: Number(process.env.MIN_CITY_UNITS ?? 20),
  source: {
    name: 'dane.gov.pl, cenniki deweloperów (ustawa o jawności cen mieszkań)',
    url: 'https://dane.gov.pl/',
  },
};
