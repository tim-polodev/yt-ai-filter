# YouTube AI Video Filter (`yt-ai-filter`)

A Chrome & Edge (Manifest V3) extension that evaluates YouTube video titles against your natural-language blocking prompt using **TypeSafe Jev** (`typesafe/jev`) via [Command Code](https://commandcode.ai/models).

Instead of removing matched videos from the feed, the extension **blurs both the thumbnail and the title**, suppresses YouTube's inline hover video preview, and overlays an interactive badge showing the **Jev `noul` probability**, the blocking rule, and a **Click to peek** toggle.

---

## Features

- **Natural-language filtering**: Enter prompts like `"Block all ai slops, brain rot, bad news about stock markets"`.
- **Non-destructive blurring**: Blurs thumbnails, inline hover previews, and titles while keeping page layout intact.
- **Transparent scoring & Click-to-Peek**: Displays Jev's calibrated `noul` probability (e.g. `Filtered • Jev 94% (noul 0.94)`) and lets you click a blurred video to temporarily peek or re-blur.
- **Prompt-scoped caching**: Caches evaluated `(model, prompt, title)` pairs in `chrome.storage.local` so scrolling or revisiting pages avoids duplicate API calls.
- **Flexible provider settings**: Defaults to `typesafe/jev` on `https://api.commandcode.ai/provider/v1/systemone`, with optional support for Cloudflare AI Gateway and Command Code chat models (`/chat/completions`).

---

## Setup & Installation

### Option A — Build with `.env` (Recommended for pre-filled API key)

1. **Clone the repository and create your local `.env`**:
   ```bash
   cp .env.example .env
   ```
2. **Edit `.env`** and add your Command Code API key:
   ```dotenv
   CMD_API_KEY=your_command_code_api_key_here
   CMD_BASE_URL=https://api.commandcode.ai/provider/v1
   CMD_MODEL=typesafe/jev
   CF_AIG_AUTH=
   ```
   *(Your `.env` file and generated `background/env-config.js` / `dist/` outputs are gitignored and never committed.)*

3. **Build the extension**:
   ```bash
   npm run build
   ```
   This generates `background/env-config.js` from `.env` and outputs a clean extension package in `dist/`.

4. **Load in Chrome or Edge**:
   - Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
   - Enable **Developer mode**.
   - Click **Load unpacked** and select the generated `dist/` folder (or the project root).

### Option B — Zero-Build Setup (Configure API key in the Popup UI)

You can also load the repository root directly via **Load unpacked** without creating a `.env` file, then click the extension icon in your browser toolbar and paste your Command Code API key into **Command Code API key** → **Save & Apply**.

---

## Security & Git Hooks (`gitleaks` + `semgrep`)

This repository includes pre-commit and pre-push Git hooks in `.githooks/` to prevent accidentally committing credentials (including Command Code `user_*` API keys) or introducing JavaScript/MV3 security vulnerabilities.

### Prerequisites

Install `gitleaks` and `semgrep` (macOS Homebrew example):
```bash
brew install gitleaks semgrep
```

### Enable Git Hooks

Run once after cloning (or automatically via `npm install`):
```bash
git config core.hooksPath .githooks
```

### What the Hooks Check

- **`.githooks/pre-commit`**:
  - Runs `gitleaks git --staged --redact` with [.gitleaks.toml](.gitleaks.toml) on staged changes.
  - Runs `semgrep scan --config .semgrep.yml --config p/javascript --error` on the codebase (excluding gitignored `.env`, `dist/`, and `background/env-config.js`).
- **`.githooks/pre-push`**:
  - Runs `gitleaks git --redact` across commit history and re-runs the `semgrep` scan before pushing.

### Manual Security Scans

```bash
npm run scan:secrets         # Scan git history with gitleaks
npm run scan:secrets:staged  # Scan staged changes with gitleaks
npm run scan:sast            # Run semgrep SAST checks
npm run scan                 # Run both gitleaks and semgrep
```
