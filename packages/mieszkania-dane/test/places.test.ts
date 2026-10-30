import { describe, expect, it } from 'vitest';
import { cleanCounty, powiatCity, properName, resolvePlace, stripPlace, POWIAT_CITIES } from '../src/places.ts';

const place = (city: string, gmina: string | null, county: string | null = null, voivodeship: string | null = null) =>
  resolvePlace({ city, gmina, county, voivodeship });

describe('nazwy gmin i powiatów', () => {
  it('lista miast na prawach powiatu ma 66 pozycji', () => {
    expect(Object.values(POWIAT_CITIES).flat()).toHaveLength(66);
  });

  it('usuwa przedrostki i dopiski', () => {
    expect(stripPlace('Gmina Komorniki')).toBe('Komorniki');
    expect(stripPlace('gm. Dopiewo')).toBe('Dopiewo');
    expect(stripPlace('GM.DOPIEWO')).toBe('DOPIEWO');
    expect(stripPlace('Gmina miejsko-wiejska Murowana Goślina')).toBe('Murowana Goślina');
    expect(stripPlace('Murowana Goślina - obszar wiejski')).toBe('Murowana Goślina');
    expect(stripPlace('Murowana Goślina - miasto')).toBe('Murowana Goślina');
    expect(stripPlace('Komorniki (gmina wiejska)')).toBe('Komorniki');
    expect(stripPlace('m. st. Warszawa')).toBe('Warszawa');
    expect(stripPlace('Miasto Stołeczne Warszawa')).toBe('Warszawa');
    expect(stripPlace('Powiat poznański')).toBe('poznański');
    // Nie rusza nazw, które tylko zaczynają się podobnie.
    expect(stripPlace('Miastko')).toBe('Miastko');
    expect(stripPlace('Gmurowo')).toBe('Gmurowo');
  });

  it('poprawia wielkość liter tylko w zapisie wersalikami lub małymi literami', () => {
    expect(properName('KOMORNIKI')).toBe('Komorniki');
    expect(properName('józefów nad wisłą')).toBe('Józefów nad Wisłą');
    expect(properName('Kazimierz Dolny')).toBe('Kazimierz Dolny');
  });

  it('powiat ziemski małą literą, grodzki jako nazwa miasta', () => {
    expect(cleanCounty('Powiat POZNAŃSKI')).toBe('poznański');
    expect(cleanCounty('warszawski zachodni')).toBe('warszawski zachodni');
    expect(cleanCounty('m. st. Warszawa')).toBe('Warszawa');
    expect(cleanCounty('X')).toBeNull();
  });

  it('rozpoznaje miasto na prawach powiatu z dzielnicą w nazwie, ale sprawdza województwo', () => {
    expect(powiatCity('Warszawa-Mokotów', 'mazowieckie')).toBe('Warszawa');
    expect(powiatCity('Kraków Podgórze', 'małopolskie')).toBe('Kraków');
    expect(powiatCity('Bielsko-Biała', 'śląskie')).toBe('Bielsko-Biała');
    expect(powiatCity('Opole Lubelskie', 'lubelskie')).toBeNull();
    expect(powiatCity('Leszno', 'mazowieckie')).toBeNull(); // wieś pod Warszawą, nie miasto w Wielkopolsce
    expect(powiatCity('Leszno', 'wielkopolskie')).toBe('Leszno');
    expect(powiatCity('Opole Lubelskie', null)).toBeNull();
  });

  it('w miastach na prawach powiatu gminą jest miasto, nawet gdy wpisano dzielnicę', () => {
    expect(place('Warszawa', 'Białołęka', 'm. st. Warszawa', 'mazowieckie')).toEqual({ city: 'Warszawa', gmina: 'Warszawa', county: 'Warszawa', urban: true });
    expect(place('WARSZAWA', 'Mokotów', 'Warszawa', 'mazowieckie').gmina).toBe('Warszawa');
    expect(place('Mokotów', null, 'm.st. Warszawa', 'mazowieckie').city).toBe('Warszawa');
  });

  it('pomyłka w polu powiatu nie przenosi wsi do miasta, gdy gmina mówi co innego', () => {
    expect(place('Plewiska', 'Komorniki', 'Poznań', 'wielkopolskie')).toEqual({ city: 'Plewiska', gmina: 'Komorniki', county: 'Poznań', urban: false });
  });

  it('gminy podmiejskie: ujednolicone zapisy', () => {
    expect(place('Skórzewo', 'Gmina Dopiewo', 'Powiat poznański', 'wielkopolskie')).toEqual({ city: 'Skórzewo', gmina: 'Dopiewo', county: 'poznański', urban: false });
    expect(place('Dąbrowa', 'gm. Dopiewo', 'POZNAŃSKI', 'wielkopolskie').gmina).toBe('Dopiewo');
    expect(place('Plewiska', 'KOMORNIKI', 'poznański', 'wielkopolskie').gmina).toBe('Komorniki');
    expect(place('Komorniki', 'X', 'poznański', 'wielkopolskie').gmina).toBeNull();
  });
});
