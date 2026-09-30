# pi-anti-amnesia

A Pi extension that stores a per-session memory card and re-injects it exactly when the context needs realigning.

**English** · [Italiano](#italiano)

---

## English

### What it does

Every Pi session can hold one card. The agent writes it itself, the extension persists it
per session, and re-injects it at the moments when the context has been truncated and the
work would otherwise be lost.

The point is *not* summarisation. A summary is a lossy guess written by the model about
its own past. A card is an explicit checkpoint the agent authored while it still knew what
was true.

### Card isolation

- The card is stored at `~/.pi/anti-amnesia/cards/<session-key>.md`.
- The session key comes from `ctx.sessionManager.getSessionId()`.
- A key other than the active one is rejected — a session cannot read or write another
  session's memory.
- Project cards are never loaded as active memory: they may belong to another role or chat.
- The shared draft is only readable on an explicit `/card bootstrap`.

### Injection channels

| Channel | Fires |
|---|---|
| `session_compact` | after the context is compacted |
| `system_prompt` | every turn (off by default) |
| `periodic` | every N turns |
| `randomReview` | on a random cadence |
| `gate` | requires an explicit confirmation before the agent proceeds |

One card is injected per LLM call, even when compaction, the periodic timer and the review
all fall due together.

### Topic-split cards

Sections titled `## Topic: a, b, c` are archived. They are re-injected **only** when the
current turn actually mentions one of the declared keywords. Body text is never used to
guess: a bare "continue" must not wake archived work.

`## Always valid` and `## Active work` do not depend on user keywords at all.

### Card structure

```markdown
## Always valid
- role, stable rules, absolute paths

## Active work
- objective, verified state, next step, blockers

## Topic: crm, newsletter
- archived notes, loaded only on an explicit request
```

Section headings are recognised in **both** English and Italian, so a card written in one
language stays editable after the configuration switches to the other. The parser matches
any alias, never a single hardcoded name.

### Language (i18n)

The extension ships English and Italian catalogs and picks one automatically.

Resolution order — the language is resolved **once at startup and frozen for the whole
session**, so the model never sees the context switch language mid-conversation:

1. `PI_ANTI_AMNESIA_LANG` (env, explicit override — useful for testing)
2. `language` from `config.json` (when not `"auto"`)
3. `LC_ALL` → `LC_MESSAGES` → `LANG` → `LANGUAGE`
4. `Intl.DateTimeFormat().resolvedOptions().locale`
5. English

An unsupported value falls back instead of failing. Frozen language is deliberate: mixing
languages across turns is what produces hybrid, half-translated cards.

```sh
PI_ANTI_AMNESIA_LANG=en pi      # force English for one run
```

#### Adding a language

Copy `i18n/en.json` to `i18n/<code>.json`, translate the values, add the code to
`SUPPORTED` in `i18n.mjs`, and add your section aliases. Keys are the API: do not rename
them. A key used in one catalog but missing from the other fails the test suite, so a
half-finished translation cannot ship silently.

### Configuration

`config.json`, next to this file:

```json
{
  "language": "auto",
  "baseCard": "",
  "everyTurns": 15,
  "bootstrap": true,
  "periodicChannel": true,
  "randomReviewChannel": true,
  "systemPromptChannel": false,
  "onCompact": true,
  "gate": false,
  "active": true
}
```

| Key | Meaning |
|---|---|
| `language` | `"auto"`, `"en"` or `"it"` |
| `baseCard` | path to your own base card; empty uses the bundled `cards/base.<lang>.md` |
| `everyTurns` | periodic re-injection interval |

Precedence, lowest to highest: bundled defaults → `config.json` → project config
(`<project>/.pi/anti-amnesia/config.json`).

`language` and `baseCard` are **install-wide**, not per-session: they are deliberately
excluded from the session registry, otherwise a session would freeze them and later edits
to `config.json` would stop taking effect.

### Base card

`cards/base.en.md` and `cards/base.it.md` are simple templates with placeholders. Point
`baseCard` at your own file to use a different one. Cards are matched by language: an
Italian-locale install loads the Italian template.

### Commands

```
/card                          status + active channels
/card regenerate                archive the card and bootstrap again
/card every N                   periodic interval
/card on | off                  master switch
/card <channel> on | off        session_compact | system_prompt | periodic |
                                randomReview | gate
/card bootstrap                 force a bootstrap
/card now                       inject the card now
/card project                   write an archive copy (not auto-loaded)
/card list | delete <key> | purge <hours>
```

### Tool `memory_card`

- `memory_card()` reads the current session's card.
- `memory_card({ text, role })` creates or replaces the card.
- `memory_card({ activeWork: "..." })` updates **only** the `## Active work`
  checkpoint, preserving every other section verbatim, and refuses a legacy card with an
  ambiguous checkpoint rather than erasing a section by accident. Write
  `activeWork: "none"` when the work is done.

Cards are written to a temporary file and published only after a successful write.

`/reload` picks up a fresh copy of the ESM modules (`topic-scope.mjs`, `i18n.mjs`) — static
imports would stay cached in the process and keep serving the old version. **After updating
the extension in an open Pi session, run `/reload` before testing it.**

### Concurrency

Writes take a cross-process lock (`registry.json.lock`) held across the whole
read-modify-write, not just the rename. If the lock is held by a live writer the attempt
retries for about 800ms and then **fails explicitly** rather than corrupting the registry.
A crashed process can leave the lock behind: check that the PID written inside it is no
longer alive before removing it manually. It is never auto-removed, because that would
allow two concurrent writers.

### Verification

```sh
TSC=/path/to/typescript/bin/tsc ./check.sh
```

54 tests: typecheck, static guardrails, topic-scope parsing, i18n resolution, and a full
extension flow run against a disposable `HOME`.

### License

MIT — see `LICENSE`.

---

## Italiano

### Cosa fa

Ogni sessione Pi può avere una carta. L'agente la scrive da sé, l'estensione la conserva
per sessione e la reinietta nei momenti in cui il contesto è stato troncato e il lavoro
andrebbe perso.

Il punto **non** è la riassunzione. Un riassunto è una stima con perdita, scritta dal
modello sul proprio passato. Una carta è un checkpoint esplicito che l'agente ha redatto
mentre sapeva ancora cosa fosse vero.

### Isolamento delle carte

- La carta è salvata in `~/.pi/anti-amnesia/cards/<chiave-sessione>.md`.
- La chiave proviene da `ctx.sessionManager.getSessionId()`.
- Una chiave diversa da quella attiva viene rifiutata: una sessione non può leggere né
  scrivere la memoria di un'altra.
- Le carte di progetto non vengono mai caricate come memoria attiva: potrebbero
  appartenere a un altro ruolo o chat.
- La bozza condivisa è leggibile solo su `/card bootstrap` esplicito.

### Canali di iniezione

| Canale | Scatta |
|---|---|
| `session_compact` | dopo la compattazione del contesto |
| `system_prompt` | a ogni turno (spento di default) |
| `periodic` | ogni N turni |
| `randomReview` | a caso |
| `gate` | richiede una conferma esplicita prima di procedere |

Una sola carta iniettata per chiamata LLM, anche quando compattazione, timer periodico e
revisione scadono insieme.

### Carte divise per topic

Le sezioni intitolate `## Topic: a, b, c` sono archiviate. Vengono reiniettate **solo** se
il turno corrente contiene davvero una delle parole chiave dichiarate. Il corpo non viene
mai usato per indovinare: un "continua" secco non deve risvegliare lavoro archiviato.

`## Sempre valido` e `## Lavoro attivo` non dipendono da nessuna parola chiave.

### Struttura della carta

```markdown
## Sempre valido
- ruolo, regole stabili, path assoluti

## Lavoro attivo
- obiettivo, stato verificato, prossimo passo, blocchi

## Topic: crm, newsletter
- appunti archiviati, caricati solo su richiesta esplicita
```

Le intestazioni di sezione sono riconosciute **sia in inglese sia in italiano**: una carta
scritta in una lingua resta modificabile dopo il passaggio all'altra lingua. Il parser
riconosce qualsiasi alias, mai un nome unico hardcoded.

### Lingua (i18n)

L'estensione include cataloghi inglese e italiano e ne sceglie uno automaticamente.

Ordine di risoluzione — la lingua è risolta **una volta all'avvio e congelata per tutta la
sessione**, così il modello non vede mai il contesto cambiare lingua a metà conversazione:

1. `PI_ANTI_AMNESIA_LANG` (env, override esplicito — utile per i test)
2. `language` da `config.json` (quando non è `"auto"`)
3. `LC_ALL` → `LC_MESSAGES` → `LANG` → `LANGUAGE`
4. `Intl.DateTimeFormat().resolvedOptions().locale`
5. Inglese

Un valore non supportato ricade su un valore predefinito invece di fallire. La lingua congelata è una
scelta deliberata: mescolare le lingue fra un turno e l'altro è ciò che produce carte
meticciate e tradotte a metà.

```sh
PI_ANTI_AMNESIA_LANG=en pi      # forza l'inglese per una sessione
```

#### Aggiungere una lingua

Copia `i18n/en.json` in `i18n/<codice>.json`, traduci i valori, aggiungi il codice a
`SUPPORTED` in `i18n.mjs` e aggiungi i tuoi alias di sezione. Le chiavi sono l'API: non
rinominarle. Una chiave presente in un catalogo e assente nell'altro fa fallire la suite
di test, così una traduzione a metà non può essere pubblicata in silenzio.

### Configurazione

`config.json`, accanto a questo file:

```json
{
  "language": "auto",
  "baseCard": "",
  "everyTurns": 15,
  "bootstrap": true,
  "periodicChannel": true,
  "randomReviewChannel": true,
  "systemPromptChannel": false,
  "onCompact": true,
  "gate": false,
  "active": true
}
```

| Chiave | Significato |
|---|---|
| `language` | `"auto"`, `"en"` o `"it"` |
| `baseCard` | percorso della tua carta base; vuoto usa `cards/base.<lingua>.md` incluso |
| `everyTurns` | intervallo di reiniezione periodica |

Precedenza, dalla più bassa alla più alta: default inclusi → `config.json` → config di
progetto (`<progetto>/.pi/anti-amnesia/config.json`).

`language` e `baseCard` sono **di installazione**, non di sessione: sono esclusi di proposito
dal registro delle sessioni, altrimenti una sessione le congelerebbe e le modifiche
successive a `config.json` smetterebbero di avere effetto.

### Carta base

`cards/base.en.md` e `cards/base.it.md` sono modelli semplici con segnaposto. Punta
`baseCard` a un tuo file per usarne un altro. Le carte sono abbinate alla lingua: un
installazione con locale italiano carica il modello italiano.

### Comandi

```
/card                          stato + canali attivi
/card regenerate                archivia la carta e riavvia il bootstrap
/card every N                   intervallo periodico
/card on | off                  interruttore generale
/card <canale> on | off         session_compact | system_prompt | periodic |
                                randomReview | gate
/card bootstrap                 forza il bootstrap
/card now                       inietta la carta adesso
/card project                   crea una copia archivio (non caricata)
/card list | delete <chiave> | purge <ore>
```

### Tool `memory_card`

- `memory_card()` legge la carta della sessione corrente.
- `memory_card({ text, role })` crea o sostituisce la carta.
- `memory_card({ activeWork: "..." })` aggiorna **solo** il checkpoint
  `## Lavoro attivo`, preservando alla lettera ogni altra sezione, e rifiuta una carta
  legacy con checkpoint ambiguo invece di cancellare una sezione per errore. Scrivi
  `activeWork: "nessuno"` a lavoro finito.

Le carte sono scritte su file temporaneo e pubblicate solo dopo una scrittura riuscita.

`/reload` carica una copia fresca dei moduli ESM (`topic-scope.mjs`, `i18n.mjs`): gli
import statici resterebbero in cache nel processo e continuerebbero a servire la versione
vecchia. **Dopo aver aggiornato l'estensione in una sessione Pi già aperta, esegui
`/reload` prima di provarla.**

### Concorrenza

Le scritture prendono un lock cross-process (`registry.json.lock`) tenuto su tutto il
read-modify-write, non solo sul rename. Se il lock è tenuto da un writer vivo, il tentativo
riprova per circa 800ms e poi **fallisce esplicitamente** invece di corrompere il registro.
Un processo crashato può lasciare il lock: verifica che il PID scritto dentro non sia più
attivo prima di rimuoverlo a mano. Non viene mai rimosso automaticamente, perché
consentirebbe due writer concorrenti.

### Verifica

```sh
TSC=/percorso/typescript/bin/tsc ./check.sh
```

54 test: typecheck, guardrail statici, parsing delle sezioni, risoluzione i18n e un flusso
completo dell'estensione su `HOME` usa e getta.

### Licenza

MIT — vedi `LICENSE`.
