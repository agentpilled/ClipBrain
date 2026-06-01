#!/bin/bash
set -e

PLIST_NAME="com.clipbrain.serve.plist"
LEGACY_PLIST_NAME="com.gbrain.serve.plist"
CONFIG_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$CONFIG_DIR/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LEGACY_DEST="$HOME/Library/LaunchAgents/$LEGACY_PLIST_NAME"
BUN_PATH="${BUN_PATH:-}"
if [ -z "$BUN_PATH" ]; then
  BUN_PATH="$(command -v bun || true)"
fi
LOG_PATH="$HOME/Library/Logs/clipbrain.log"

if [ -z "$BUN_PATH" ]; then
  echo "bun not found. Install Bun first: https://bun.sh"
  exit 1
fi
BUN_DIR="$(dirname "$BUN_PATH")"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

cat > "$DEST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clipbrain.serve</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_PATH</string>
        <string>run</string>
        <string>server.ts</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$BUN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>StandardOutPath</key>
    <string>$LOG_PATH</string>
    <key>StandardErrorPath</key>
    <string>$LOG_PATH</string>
</dict>
</plist>
PLISTEOF

echo "Wrote plist to $DEST"

launchctl unload "$DEST" 2>/dev/null || true
launchctl unload "$LEGACY_DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "Loaded $PLIST_NAME - ClipBrain is now running and will auto-start on login."
