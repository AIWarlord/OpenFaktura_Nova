#!/bin/bash
# OpenFaktura — spouštěč pro macOS
cd "$(dirname "$0")"

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  NODE="runtime/mac-arm64/node"
else
  NODE="runtime/mac-x64/node"
fi

# odstranit případnou karanténu a nastavit spustitelnost (poprvé)
xattr -dr com.apple.quarantine "$NODE" "$0" 2>/dev/null
chmod +x "$NODE" 2>/dev/null

if [ ! -f "$NODE" ]; then
  echo "Chybí runtime pro tvůj Mac ($ARCH). Očekávám soubor: $NODE"
  read -r -p "Stiskni Enter pro zavření…" _
  exit 1
fi

# návratový kód 75 = server se po aktualizaci chce restartovat
while true; do
  echo "Spouštím OpenFaktura…"
  "$NODE" server.js
  [ $? -eq 75 ] || break
done

echo ""
echo "OpenFaktura byla ukončena. Toto okno můžeš zavřít."
read -r -p "" _
