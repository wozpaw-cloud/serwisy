// Promocja deweloperów: baner na górze stron i wyróżnione inwestycje.
// Panel zarządzania będzie zmieniał ten plik przez commit. Każda promocja jest
// oznaczona na stronie ("Reklama" / "Promowane"); dane i ceny zawsze z cenników.

export interface Banner {
  /** Adres strony reklamodawcy. */
  href: string;
  /** Nazwa reklamodawcy (widoczna w oznaczeniu reklamy). */
  advertiser: string;
  /** Obraz banera 970×250 (plik w public/reklamy/) albo baner tekstowy. */
  image?: string;
  title?: string;
  text?: string;
  /** Tylko na stronach tych miast (slugi), puste = wszędzie. */
  cities?: string[];
  /** Do kiedy (RRRR-MM-DD) baner jest wyświetlany. */
  until?: string;
}

export interface Promoted {
  /** Adres strony inwestycji w serwisie, np. "wroclaw-apartamenty-krakowska". */
  slug: string;
  /** Krótki dopisek dewelopera, np. "Ostatnie mieszkania z ogródkiem". */
  note?: string;
  until?: string;
}

export const PROMO: { banners: Banner[]; promoted: Promoted[] } = {
  banners: [],
  promoted: [],
};
