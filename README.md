# Vuggevagt

Babyalarm mellem to Android-telefoner. Én står ved barnet og lytter, én er hos
dig og siger til. Lyden går **direkte mellem telefonerne** (WebRTC, krypteret
end-to-end) — serveren hjælper kun de to telefoner med at finde hinanden og kan
hverken høre eller gemme noget.

**Live:** https://bordingcode.github.io/vuggevagt/
**Første nat:** [docs/FOERSTE-NAT.md](docs/FOERSTE-NAT.md) ← læs den

## Det vigtigste at vide
- **Telefonen ved barnet skal have skærmen tændt og være sat til strøm.**
  Android lukker for mikrofonen, når en browser kommer i baggrunden (siden
  Android 9 kræver det en "foreground service", som kun en rigtig app kan lave).
  Appen holder selv skærmen tændt med Wake Lock og gør den helt sort.
- **Din egen telefon må gerne have skærmen slukket.** Den opfører sig som en
  musikafspiller, og det tillader Android gerne.
- **Hvis forbindelsen dør, hyler din telefon** — og den holder ikke op af sig
  selv. En babyalarm der bliver stille uden at sige det, er værre end ingen.

## Uden oplader (barnevogn)
Skærmen skal stadig være tændt, så batteriet er begrænsningen. `js/battery.js`
måler det **faktiske** forbrug på den telefon (Battery Status API) og viser
`%/time` + `ca. X t tilbage` begge steder. Når telefonen ikke oplader, slår
appen selv en sparetilstand til: prikken holder op med at ånde, niveaubjælken
tegnes 1× i sekundet i stedet for 10×, og niveauet sendes hvert 500 ms i stedet
for hvert 200 ms — men altid som **peak siden sidst**, så en kort gråd aldrig
kan falde ned mellem to pakker. Forældretelefonen advarer ved 20 % og 10 %.

## Sådan hænger det sammen
```
barnets telefon  ──── lyd, krypteret, direkte ────  din telefon
       │                                                 │
       └──── kun ved opkobling ──►  Cloudflare Worker ◄──┘
                                    (finder hinanden)
```
- `js/peer.js` — WebRTC. Opus med `usedtx=1` (næsten ingen data når der er
  stille) og `ptime=60` (færre pakker = mindre radio = mindre batteri).
- `js/meter.js` — lydniveau i en AudioWorklet (egen lydtråd, som Android ikke
  må bremse) + støjporten der afgør hvornår en lyd "tæller".
- `js/main.js` — de to roller, alarmerne, genopkobling.
- `worker/` — signalering: én Durable Object per parringskode, gratisplanen.

Målt på en rigtig forbindelse: **24,2 kbit/s mens der bliver larmet,
0,15 kbit/s når der er stille** — 99 % mindre data om natten.

## Sikkerhed
Parringskoden er 8 tegn (32^8 ≈ 10^12 muligheder). Det **første par telefoner**
der bruger en kode, låser rummet til sig: derefter kan ingen tredje enhed komme
ind, heller ikke med koden. "Glem parring" bryder låsen igen.

## Udvikling
```
python3 -m http.server 8477         # og åbn http://localhost:8477
```
Testkroge (kun til udvikling):
- `?ns=baby` / `?ns=parent` — hver fane får sit eget "telefon"-lager, så én
  maskine kan spille begge roller.
- `?fakemic=1` — bytter mikrofonen ud med en genereret tone. Ingen
  tilladelser, ingen mikrofon nødvendig.
- `window.__vv` — `.state`, `.peer`, `.stats()`, `.loud(v)`, `.fakeNoise(db)`,
  `.errors` (skal være tom).

**Deploy:** commit + push til `main` (GitHub Pages). Husk at hæve `?v=` på
`css/main.css` og `js/main.js` i `index.html` **og** i `sw.js`, samt
`CACHE`-strengen i `sw.js` — ellers serverer telefonerne den gamle kode.

Worker:
```
source ~/.cloudflare-token && export CLOUDFLARE_API_TOKEN
cd worker && npx wrangler deploy
```

## TODO: TURN-relæ (virker uden, men ikke altid udenfor hjemmet)
Uden relæ kobler telefonerne direkte sammen. Det virker altid på samme wifi og
som regel også over mobilnet — men nogle mobilnet (CGNAT) lukker ikke to
telefoner direkte sammen, og så skal trafikken relæes.

Cloudflare har et gratis relæ (1.000 GB/måned; vi bruger ~2 GB). Sådan tændes det:
1. Cloudflare-dashboard → **Realtime** → **TURN Keys** → opret en nøgle
   (kald den `vuggevagt`).
2. ```
   cd worker
   npx wrangler secret put TURN_KEY_ID      # nøglens ID
   npx wrangler secret put TURN_API_TOKEN   # nøglens token
   npx wrangler deploy
   ```
Appen henter selv relæ-oplysningerne fra `/ice` bagefter — ingen ændringer i
appen. Statuslinjen nederst viser "via relæ", når det bliver brugt.

(API-tokenet i `~/.cloudflare-token` har ikke rettigheder til Realtime, derfor
skal nøglen laves i dashboardet.)

## Det her er ikke medicinsk udstyr
Hjemmelavet hjælpemiddel. Et ekstra øre, ikke en garanti.
