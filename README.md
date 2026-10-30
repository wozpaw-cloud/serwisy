# Serwisy

Sieć serwisów analitycznych na otwartych danych publicznych. Pierwszy z nich: **Cena od dewelopera** (cenaoddewelopera.pl), czyli ceny mieszkań i domów z jawnych cenników deweloperów w dane.gov.pl.

Kod napisała AI (Claude). Liczby wylicza program z danych; teksty AI są oznaczone na stronach.

## Struktura

```
packages/mieszkania-dane/   import cenników, baza SQLite z historią, analizy
  src/normalize.ts          liczby, daty, nazwy (przecinek dziesiętny, "X", Windows-1250)
  src/columns.ts            rozpoznawanie kolumn po treści nagłówka
  src/places.ts             ujednolicanie miejscowości, gmin i powiatów (66 miast na prawach powiatu)
  src/parse.ts              CSV, XLSX, XML, JSON -> wspólny rekord + kontrola zakresów
  src/ingest.ts             zapis do bazy: przedziały obecności i zmiany cen
  src/analytics.ts          mediany, indeks cen tych samych lokali, obniżki, podaż
  src/harvest.ts            klient API dane.gov.pl (codzienny import i uzupełnianie historii)
  src/sample.ts             DANE PRZYKŁADOWE w formacie wzorcowego cennika
  src/cli.ts                komendy i bramka jakości
sites/mieszkania/           serwis w Astro (strony statyczne), hosting Cloudflare Workers
content/mieszkania/raporty/ komentarze AI do raportów miesięcznych (status: szkic | zatwierdzony)
.github/workflows/          codzienny import, budowa i publikacja
data/                       baza i pliki robocze (poza repozytorium)
```

**Wdrożenie krok po kroku: [WDROZENIE.md](WDROZENIE.md).**

## Komendy

```bash
npm ci
npm test                        # testy importu i analiz
npm run mieszkania:sample       # dane przykładowe + import do data/mieszkania.sqlite
npm run mieszkania:build        # budowa serwisu do sites/mieszkania/dist
npx tsx packages/mieszkania-dane/src/cli.ts harvest --dry-run --limit 3   # surowe pola z API
npx tsx packages/mieszkania-dane/src/cli.ts harvest                       # import z dane.gov.pl
npx tsx packages/mieszkania-dane/src/cli.ts backfill --minutes 240        # historia od 09.2025 (wznawialna)
```

Serwis zbudowany z danych przykładowych pokazuje na każdej stronie baner „Podgląd na danych przykładowych” i ma `noindex`. Rozpoznaje to po identyfikatorach zbiorów, a nie po ustawieniu.

## Do sprawdzenia przy pierwszym imporcie prawdziwych danych

Kod powstał bez dostępu sieciowego do dane.gov.pl, więc te elementy trzeba obejrzeć w logu pierwszego uruchomienia:

1. **API dane.gov.pl** (`harvest.ts`): nazwy pól zasobu (`download_url`, `data_date`) i wyszukiwanie zbiorów po tytule. Pierwsze uruchomienie: Actions → „Ceny mieszkań” → `dry_run`.
2. **Nagłówki cenników** (`columns.ts`): nieznane kolumny trafiają do `data/alarms.json` jako „nowe kolumny”. Reguły dopisujemy w `RULES`.
3. **Historia sprzed startu**: `cli.ts backfill` wczytuje po jednym cenniku na tydzień od września 2025 r. Workflow robi to sam: po 4 godziny dziennie, aż wszystkie zbiory trafią do `backfill_done`. Dopiero potem importuje bieżące cenniki i publikuje serwis.

## Bramka jakości

Import kończy się kodem 2 i nie publikuje serwisu, jeśli liczba lokali w ofercie spadnie o ponad 25% względem poprzedniego udanego importu. Alarmy i podsumowanie trafiają do `data/alarms.json` i `data/last-run.json` (oraz do R2), skąd odczyta je panel.

## Sekrety (GitHub → Settings → Secrets)

- `CLOUDFLARE_API_TOKEN`: uprawnienia Workers Scripts (edycja) i R2 (edycja)
- `CLOUDFLARE_ACCOUNT_ID`
- później: `ADSENSE_CLIENT`, zmienna `ADS=1` po akceptacji konta AdSense
