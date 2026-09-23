# Beállítás – Crypto Decision Engine 04

1. A ZIP tartalmát töltsd fel a GitHub `crypto-decision-engine` repó gyökerébe.
2. Cloudflare → Workers & Pages → Create application → Import a repository → válaszd a GitHub repót.
3. A Worker neve legyen `crypto-decision-engine-04` (ezt már a wrangler.toml tartalmazza).
4. Deploy.
5. A Worker kap egy `workers.dev` címet. Nyisd meg ezt a címet.
6. A dashboard automatikusan lekéri az állapotot. A **FRISSÍTÉS ÉS ELEMZÉS** gomb manuálisan lefuttatja a scan + paper-trading ciklust.
7. A Cron két UTC időpontban indul (06:00 és 07:00 UTC), de a Worker csak akkor futtatja a napi automatikus ciklust, amikor a `Europe/Budapest` helyi idő 08:00. Így a nyári/téli időszámítás is kezelhető.

A D1 adatbázis és a táblák már létre lettek hozva. A `wrangler.toml` a megadott D1 ID-t használja.
