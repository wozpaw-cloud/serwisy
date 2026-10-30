# Jak wrzucić serwis na serwer

Serwis działa bez własnego serwera. GitHub przechowuje kod i codziennie rano uruchamia import cenników, a Cloudflare udostępnia gotowe strony w internecie. Ty zakładasz konta i wklejasz dwa klucze. Resztę robi automat.

**Koszty:** GitHub i Cloudflare w darmowych planach wystarczą. Płacisz tylko za domenę .pl, zwykle od kilkudziesięciu do ok. 150 zł rocznie, zależnie od rejestratora (sprawdź cenę odnowienia, nie tylko pierwszego roku).

**Czas:** około godziny Twojej pracy, plus kilka dni, w których automat wczytuje historię cen.

---

## 1. GitHub: konto i repozytorium

1. Załóż konto na [github.com](https://github.com) (jeśli go nie masz).
2. Utwórz nowe repozytorium: nazwa `serwisy`, widoczność **Private**, bez README i bez innych plików (ma być puste).
3. Wrzuć do niego kod. Masz dwie drogi:
   - **Najprościej:** połącz swoje konto GitHub z Claude w ustawieniach claude.ai i napisz mi nazwę repozytorium (np. `twoja-nazwa/serwisy`). Wypchnę kod sam.
   - **Samodzielnie:** zainstaluj aplikację [GitHub Desktop](https://desktop.github.com), rozpakuj `serwisy-kod.zip`, w aplikacji dodaj rozpakowany folder jako repozytorium (Add local repository, a gdy zapyta, „create a repository”), zrób pierwszy commit i opublikuj go do repozytorium `serwisy` jako prywatne.

## 2. Cloudflare: konto, klucz i identyfikator konta

1. Załóż darmowe konto na [dash.cloudflare.com](https://dash.cloudflare.com).
2. Włącz **R2** (miejsce na bazę z historią cen): w menu po lewej R2 Object Storage. Cloudflare może poprosić o kartę albo PayPal. Opłaty pojawiłyby się dopiero po przekroczeniu darmowego limitu (10 GB), a baza zajmie dużo mniej.
3. Skopiuj **Account ID**: jest na stronie głównej konta i w sekcji Workers (prawa kolumna, „Account ID”).
4. Utwórz klucz API: ikona profilu → My Profile → API Tokens → Create Token → szablon **Edit Cloudflare Workers** → Continue → Create Token. Skopiuj klucz od razu, bo później go nie zobaczysz. Szablon zawiera już uprawnienia do Workers i R2.

## 3. GitHub: wklej klucze

W repozytorium `serwisy`: Settings → Secrets and variables → Actions → New repository secret. Dodaj dwa sekrety:

| Nazwa | Wartość |
|---|---|
| `CLOUDFLARE_API_TOKEN` | klucz z kroku 2.4 |
| `CLOUDFLARE_ACCOUNT_ID` | identyfikator z kroku 2.3 |

Klucze wklejasz tylko tutaj. Nie wysyłaj ich nikomu, także mnie.

## 4. Pierwsze uruchomienie: podgląd danych

To sprawdzenie, czy portal dane.gov.pl odpowiada tak, jak zakłada program. Nic nie publikuje.

1. W repozytorium: zakładka **Actions** → po lewej „Ceny mieszkań - import i publikacja” → **Run workflow**.
2. Zaznacz „Tylko podgląd” i uruchom.
3. Po kilku minutach otwórz przebieg, krok „Podgląd surowych pól API”, i skopiuj jego treść do rozmowy ze mną. Sprawdzę nazwy pól i w razie potrzeby poprawię import.

## 5. Właściwe uruchomienie

1. Actions → Run workflow, tym razem **bez** zaznaczania podglądu.
2. Automat wczytuje historię cenników od września 2025 r. Pracuje po 4 godziny dziennie i sam kontynuuje kolejnego dnia, aż skończy. Zwykle zajmuje to kilka dni. W tym czasie serwis jeszcze się nie publikuje.
3. Gdy historia jest pełna, automat wczytuje bieżące cenniki, buduje serwis i publikuje go. Adres znajdziesz w kroku „Opublikuj w Cloudflare Workers”, w postaci `cenaoddewelopera.<twoja-nazwa>.workers.dev`.
4. Obejrzyj serwis: nie powinno być żółtego paska „dane przykładowe”, a liczby powinny wyglądać rozsądnie. Jeśli coś się nie zgadza, skopiuj mi zawartość kroku z importem.

Od tej chwili serwis aktualizuje się sam codziennie około 6:20 (czasu zimowego). Jeśli import zobaczy coś podejrzanego (np. nagły spadek liczby lokali o ponad 25%), wstrzyma publikację, a w R2 zostawi plik z alarmem.

## 6. Domena cenaoddewelopera.pl

Cloudflare nie sprzedaje domen .pl, więc domenę kupujesz u polskiego rejestratora (np. OVHcloud, home.pl, nazwa.pl, cyber_Folks), a obsługę przekazujesz do Cloudflare:

1. Kup domenę `cenaoddewelopera.pl`.
2. W Cloudflare: Add a domain → wpisz domenę → plan **Free**. Cloudflare poda dwa adresy serwerów nazw (nameservers).
3. W panelu rejestratora zmień serwery nazw domeny na te dwa adresy. Aktywacja trwa zwykle od kilku godzin do doby.
4. Gdy Cloudflare pokaże domenę jako aktywną, daj mi znać: włączę adres w pliku `sites/mieszkania/wrangler.jsonc`. Możesz to zrobić też sam: usuń dwa ukośniki przed `"routes"`. Następna publikacja podepnie serwis pod domenę.

## 7. Przed włączeniem reklam

- Uzupełnij dane wydawcy na stronie prywatności i w pliku `sites/mieszkania/src/config.ts` (nazwa wydawcy i adres e-mail są tymczasowe).
- Wniosek do AdSense złóż dopiero, gdy serwis będzie działał na domenie z prawdziwymi danymi przez kilka tygodni.
- W Unii Europejskiej reklamy Google wymagają okna zgody na pliki cookie od certyfikowanego dostawcy. Google ma własne, darmowe narzędzie do tego w ustawieniach AdSense („Prywatność i wiadomości”).
- Reklamy włącza zmienna `ADS=1` i sekret `ADSENSE_CLIENT` (identyfikator wydawcy `ca-pub-…`). Ustawię je, gdy konto zostanie zaakceptowane.

---

**Coś nie działa?** Skopiuj mi treść czerwonego kroku z zakładki Actions. Najczęstsze przyczyny: literówka w nazwie sekretu, klucz API bez uprawnień do R2 albo niewłączone R2 w Cloudflare.
