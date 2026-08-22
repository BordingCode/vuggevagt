# Vuggevagt — projektguide

Babyalarm-PWA mellem to Android-telefoner. Vanilla ES-moduler, **intet
byggetrin**. Repo `BordingCode/vuggevagt`, GitHub Pages.
Signalering: Cloudflare Worker + Durable Object (`worker/`).

**Sproget i appen er dansk.** Kode og kommentarer er på engelsk.

## Den hårde begrænsning (lav ikke om på den uden at læse her)
Android lukker for mikrofonen, når Chrome er i baggrunden — siden Android 9
kræver mikrofon i baggrunden en foreground service, som kun en rigtig app kan
lave. Derfor:
- **Barnets telefon:** skærmen SKAL være tændt (Wake Lock), telefonen på strøm.
  Wake Lock frigives automatisk når siden bliver skjult og skal tages igen på
  `visibilitychange` — det gør `acquireWakeLock()`.
- **Forældrenes telefon:** må gerne have slukket skærm. Lydafspilning er tilladt
  i baggrunden, og `<audio>`-elementet må derfor **aldrig** mutes eller sættes
  til volume 0 — så holder Android op med at regne siden for "spiller medie".
  Minimum er 0.05 (se `applyVolume()`).

## Sikkerhedsreglen i appen
Alarmen for **mistet forbindelse** er vigtigere end alt andet. En babyalarm der
fejler stille er farligere end ingen babyalarm. Derfor:
- Heartbeat hvert 2. sekund over datakanalen, `DEAD_MS = 8000`.
- `deadReason === 'blind'` (barnets telefon kom i baggrunden) må **ikke** ryddes
  af at netværket kommer sig — kun barnets telefon selv kan melde den er tilbage.
- `onLinkUp()` må aldrig male en rask status hen over en aktiv alarm.

## Fælder vi allerede er faldet i
- **`AudioContext.resume()` returnerer et løfte der ALDRIG resolver** uden et
  brugertryk. Await det aldrig i opstartsstien — `Alarm.unlock()` har derfor et
  400ms race, og `armOnFirstGesture()` prøver igen ved første tryk.
- **Datakanalen står "open" et stykke tid efter den anden telefon er væk.**
  Signalering under genopkobling skal tvinges over WebSocket
  (`peer.post(msg, true)`), ellers ryger tilbuddet ud i ingenting og de to
  telefoner finder aldrig hinanden igen.
- Mikrofonsporet udløser `negotiationneeded` med det samme — længe før nogen
  lytter. Det første tilbud går tabt; `kick()` gensender det, og `rebuild()`
  bygger hele forbindelsen forfra når modparten dukker op.

## Test uden telefoner
`?ns=<navn>` (eget lager per fane) + `?fakemic=1` (genereret tone i stedet for
mikrofon) + `window.__vv`. To faner = to telefoner. NB: skifter man fane, bliver
den anden fane rigtigt skjult, og "blind"-alarmen går — det er korrekt opførsel,
men det forurener test af ren linjedød (pin `visibilityState` i testen).

## Deploy — hver ændring
Hæv `?v=` på ændrede filer i `index.html` **og** `sw.js`, og hæv `CACHE` i
`sw.js`. Ellers serveres gammel kode. Commit + push til `main`.
