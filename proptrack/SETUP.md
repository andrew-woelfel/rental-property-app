# PropTrack — macOS Setup Guide

Your rental property manager as a native Mac app.
Data saves to `~/Library/Application Support/com.proptrack.app/proptrack-data.json`

---

## Prerequisites (one-time)

### 1. Install Xcode Command Line Tools
Open Terminal and run:
```bash
xcode-select --install
```
Click "Install" in the popup. Takes ~5 minutes.

### 2. Install Homebrew (if you don't have it)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 3. Install Rust
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
When prompted, choose option 1 (default install). Then reload your shell:
```bash
source "$HOME/.cargo/env"
```

### 4. Install Node.js (if you don't have it)
```bash
brew install node
```
Verify: `node --version` should show v18+

---

## Project Setup

### 5. Move this project folder somewhere permanent
```bash
mv ~/Downloads/proptrack ~/projects/proptrack
# or wherever you keep code
cd ~/projects/proptrack
```

### 6. Install JavaScript dependencies
```bash
npm install
```

### 7. Generate placeholder icons (required to build)
Tauri needs icon files. Run this to create simple placeholder icons:
```bash
mkdir -p src-tauri/icons

# Create a simple PNG icon using sips (built into macOS)
# We'll make a 512x512 dark square as placeholder
python3 - <<'EOF'
import struct, zlib

def make_png(size, r, g, b):
    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    row = b'\x00' + bytes([r, g, b] * size)
    idat = zlib.compress(row * size)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

for sz, name in [(32,'32x32'), (128,'128x128'), (256,'128x128@2x')]:
    open(f'src-tauri/icons/{name}.png','wb').write(make_png(sz, 14, 14, 12))
print("Icons created")
EOF
```

For a proper icon later, replace these with a real `.icns` file.
Tauri also needs `.icns` and `.ico` — for now copy the 128px PNG as placeholders:
```bash
cp src-tauri/icons/128x128.png src-tauri/icons/icon.icns
cp src-tauri/icons/128x128.png src-tauri/icons/icon.ico
```

---

## Running in Development

```bash
npm run tauri dev
```

This opens the app in a native window with hot reload — change any code in `src/` and it updates instantly. First run takes 3-5 minutes while Rust compiles. Subsequent runs are fast.

---

## Building the .app for Production

```bash
npm run tauri build
```

When done (~5-10 min first time), your app is at:
```
src-tauri/target/release/bundle/macos/PropTrack.app
```

And a `.dmg` installer at:
```
src-tauri/target/release/bundle/dmg/PropTrack_1.0.0_aarch64.dmg
```

Drag `PropTrack.app` into your `/Applications` folder. Done.

---

## Data & Backups

Your data lives at:
```
~/Library/Application Support/com.proptrack.app/proptrack-data.json
```

This is plain JSON — easy to back up, open in any text editor, or inspect.

To back up: copy that file anywhere.
To restore: replace the file before opening the app.

---

## Troubleshooting

**"command not found: cargo"**
Run `source "$HOME/.cargo/env"` and try again.

**Build fails with "error: linker 'cc' not found"**
Run `xcode-select --install` again.

**"invalid icon" error during build**
Make sure all 5 icon files exist in `src-tauri/icons/`.
Check: `ls src-tauri/icons/`

**App opens but shows blank white screen**
Run `npm run tauri dev` instead of the built app — it'll show errors in the terminal.

**"App can't be opened because Apple cannot check it for malicious software"**
Right-click the app → Open → Open anyway. This is because the app isn't notarized (paid Apple developer account required for notarization).

---

## Upgrading the App Icon (optional)

1. Create a 1024x1024 PNG of your desired icon
2. Use `iconutil` or an online tool to convert to `.icns`
3. Replace `src-tauri/icons/icon.icns` and the PNG files
4. Re-run `npm run tauri build`

---

## Project Structure

```
proptrack/
├── src/
│   ├── main.jsx          ← React entry point
│   └── App.jsx           ← All UI + logic (edit this to customize)
├── src-tauri/
│   ├── src/main.rs       ← Rust backend (minimal, don't need to touch)
│   ├── tauri.conf.json   ← App config (window size, permissions, etc.)
│   ├── Cargo.toml        ← Rust dependencies
│   └── icons/            ← App icons
├── index.html
├── package.json
└── vite.config.js
```
