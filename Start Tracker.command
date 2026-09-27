#!/bin/bash
# Double-click this file on a Mac to start the tracker.
# The first time, macOS may block it: right-click it > Open > Open. (README step 4)

cd "$(dirname "$0")" || exit 1

# /usr/bin/python3 is only a placeholder until Apple's Command Line Tools are installed.
if ! xcode-select -p >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/python3 ] && [ ! -x /usr/local/bin/python3 ]; then
    echo "Python 3 isn't installed yet. A window will pop up to install Apple's developer tools."
    echo "Click Install, wait for it to finish, then double-click Start Tracker again."
    xcode-select --install
    read -r -p "Press Return to close this window."
    exit 1
fi

echo "=========================================================="
echo "  EcoCAR Vehicle Tracker"
echo "  Keep this window open while tracking. Closing it stops the tracker."
echo "  The tracker opens in your browser: http://localhost:8765 (settings: the gear, top right)"
echo "=========================================================="
echo

# caffeinate keeps the Mac from sleeping while the tracker runs.
exec caffeinate -dis python3 tracker/tracker.py
