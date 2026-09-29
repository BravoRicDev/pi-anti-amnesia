#!/usr/bin/env bash
# Typecheck + test suite for pi-anti-amnesia.
#
# The Pi type packages (@earendil-works/pi-coding-agent, typebox) are resolved
# through `paths` in tsconfig.check.json, so no local node_modules is needed.
# Point PI_CODING_AGENT at your Pi installation root, which contains dist/ and
# node_modules/. TSC can be set explicitly to override the TypeScript binary.
set -euo pipefail
cd "$(dirname "$0")"

# --- Locate the Pi installation -------------------------------------------
# Solo un valore che punta davvero a una directory vale: l'ambiente può avere
# una PI_CODING_AGENT booleana o generica impostata per altro scopo, e accettarla
# alla cieca trasformerebbe un semplice `check.sh` in un fallimento incomprensibile.
PI_CODING_AGENT="${PI_CODING_AGENT:-}"
if [ -n "$PI_CODING_AGENT" ] && [ ! -d "$PI_CODING_AGENT" ]; then
  echo "note: PI_CODING_AGENT='$PI_CODING_AGENT' is not a directory, ignoring it." >&2
  PI_CODING_AGENT=""
fi
if [ -z "$PI_CODING_AGENT" ]; then
  for c in \
    "$HOME/.hermes/node/lib/node_modules/@earendil-works/pi-coding-agent" \
    "$HOME/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent" \
    "$HOME/.local/share/pi/node_modules/@earendil-works/pi-coding-agent" \
    "$(dirname "$(dirname "$(command -v pi 2>/dev/null || echo /nonexistent)")")/lib/node_modules/@earendil-works/pi-coding-agent"; do
    if [ -d "$c" ]; then PI_CODING_AGENT="$c"; break; fi
  done
fi

if [ -z "$PI_CODING_AGENT" ] || [ ! -d "$PI_CODING_AGENT" ]; then
  echo "Cannot locate the Pi installation (the folder holding dist/ and node_modules/)." >&2
  echo "Set PI_CODING_AGENT=/path/to/pi-coding-agent and retry." >&2
  exit 1
fi
export PI_CODING_AGENT

# --- Locate the TypeScript binary ------------------------------------------
# TypeScript non sta necessariamente sotto l'installazione di Pi: puo' vivere in
# un albero npm globale, in un tool harness, o essere gia' nel PATH. Si cercano
# tutti, nell'ordine: esplicito, PATH, installazione Pi, poi alberi noti.
TSC="${TSC:-}"
if [ -z "$TSC" ] && command -v tsc >/dev/null 2>&1; then
  TSC="$(command -v tsc)"
fi
if [ -z "$TSC" ]; then
  for c in \
    "$PI_CODING_AGENT/node_modules/.bin/tsc" \
    "$PI_CODING_AGENT/node_modules/typescript/bin/tsc" \
    "$HOME/.hermes/node/lib/node_modules/typescript/bin/tsc" \
    "$HOME/.hermes/hermes-agent/node_modules/typescript/bin/tsc" \
    "$HOME/.pi/agent/npm/node_modules/typescript/bin/tsc"; do
    if [ -x "$c" ]; then TSC="$c"; break; fi
  done
fi

if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  echo "tsc not found. Set TSC=/path/to/tsc or install typescript." >&2
  exit 1
fi

echo "Pi installation: $PI_CODING_AGENT"
echo "TypeScript:       $TSC"

# TypeScript non espande variabili d'ambiente dentro `paths`, e fissare li
# percorsi assoluti renderebbe il repo non portabile. Il tsconfig del repository
# resta quindi pulito; qui se ne genera uno risolvendo l'installazione Pi
# trovata sopra, e si typechecka quello.
# typeRoots vuole il CONTENITORE dei pacchetti @types, non il pacchetto: con
# .../@types/node tsc cerca .../@types/node/node e fallisce con TS2688.
TYPES_ROOT="$PI_CODING_AGENT/node_modules/@types"
[ -d "$TYPES_ROOT" ] || TYPES_ROOT="$(cd "$(dirname "$TSC")/../.." && pwd)/node_modules/@types"

# Ripulisci il file risolto anche se tsc fallisce: con `set -e` il rm dopo
# l'invocazione non verrebbe mai raggiunto.
RESOLVED="tsconfig.check.resolved.json"
trap 'rm -f "$RESOLVED"' EXIT

cat > "$RESOLVED" <<JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "lib": ["ES2022", "dom"],
    "typeRoots": ["$TYPES_ROOT"],
    "types": ["node"],
    "paths": {
      "@earendil-works/pi-coding-agent": ["$PI_CODING_AGENT/dist/index.d.ts"],
      "@earendil-works/pi-agent-core": ["$PI_CODING_AGENT/node_modules/@earendil-works/pi-agent-core/dist/index.d.ts"],
      "typebox": ["$PI_CODING_AGENT/node_modules/typebox"]
    }
  },
  "include": ["index.ts", "i18n.d.mts", "topic-scope.d.mts"]
}
JSON

"$TSC" -p "$RESOLVED" "$@"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
node --test tests/topic-scope.test.mjs tests/i18n.test.mjs tests/extension-flow.test.mjs
