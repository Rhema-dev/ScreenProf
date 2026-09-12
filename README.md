# ScreenProf

ScreenProf is a privacy-first Windows desktop AI tutor. It captures a screen or window only when the user asks a question, sends that single image to Gemini, and guides the user through the visible interface one step at a time with a click-through highlight overlay.

## What is included

- Floating, always-on-top Electron assistant
- Draggable floating logo that expands into the assistant and collapses back in one click
- Secure, sandboxed React renderer with a narrow preload API
- Global `Ctrl + Space` shortcut and system tray controls
- Explicit screen/window source selection
- Event-driven screen capture (no continuous recording)
- Reduced capture payloads, minimal Gemini thinking, transient retry handling, and a 90-second network deadline
- Gemini 3.6 Flash multimodal analysis through the Interactions API with structured JSON output
- Complete tutorial plans generated in one request, with instant local step completion
- Per-step issue reporting that rechecks the screen and rewrites the remaining plan
- Fully recursive “Explain further” threads whose micro-steps can be completed, highlighted, reported, and expanded again without leaving the main guide
- Persistent New session control that safely resets the workspace while retaining previous guides in History
- Transparent, click-through overlay window
- Encrypted API-key storage through the operating system
- Local conversation history and instant vision pause
- Browser preview mode and coordinate-safety unit tests
- Windows installer configuration

Autonomous mouse/keyboard control is intentionally not part of this MVP.

## Run locally

```powershell
npm install
npm run dev
```

The packaged application uses the developer-configured Gemini API key. Users cannot view or replace it in Settings.

To review the UI without Electron or a key:

```powershell
npm run dev:web
```

The web preview uses a safe simulated tutor response. Screen capture and overlays require Electron.

## Quality checks

```powershell
npm run typecheck
npm test
npm run build
```

Create a Windows installer with:

```powershell
npm run package:win
```

Build output is written to `release/`.

## Privacy model

Screenshots are held in memory only and are not written to disk. Conversation history can be disabled or cleared. Capture is visible, user-triggered, and can be paused from the app or tray. Renderer sandboxing, context isolation, restrictive navigation, sender-validated IPC, and denied renderer permission requests form the desktop security boundary.
