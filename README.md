# ScreenProf

ScreenProf is a privacy-first Windows desktop AI tutor. It captures a screen or window only when the user asks a question, sends that single image to Gemini, and guides the user through the visible interface one step at a time with a click-through highlight overlay.

## What is included

- Floating, always-on-top Electron assistant
- Draggable floating logo that expands into the assistant and collapses back in one click
- Secure, sandboxed React renderer with a narrow preload API
- Global `Ctrl + Space` shortcut and system tray controls
- Explicit screen/window source selection
- Event-driven screen capture (no continuous recording)
- Reduced capture payloads, high Gemini thinking, transient retry handling, and a 90-second network deadline
- Gemini 3.8 Flash multimodal analysis with 3.5/3.1 Flash-Lite rate-limit fallbacks
- Request-aware explanations, guides, and troubleshooting responses generated in one request
- Per-step issue reporting that rechecks the screen and rewrites the remaining plan
- Fully recursive “Explain further” threads whose micro-steps can be completed, highlighted, reported, and expanded again without leaving the main guide
- Persistent New session control that safely resets the workspace while retaining previous guides in History
- Transparent, click-through overlay window
- Gemini API requests proxied through an authenticated Supabase Edge Function
- Local conversation history and instant vision pause
- Browser preview mode and coordinate-safety unit tests
- Windows installer configuration

Autonomous mouse/keyboard control is intentionally not part of this MVP.

## Run locally

```powershell
npm install
npm run dev
```

The packaged application calls the `gemini-tutor` Supabase Edge Function. The Gemini API key is stored only as the Edge Function secret `GEMINI_API_KEY`; it is never bundled with the desktop application. Users sign in with Supabase Auth, and credentials are encrypted locally with the operating system's secure storage.

Deploy backend changes with:

```powershell
npx supabase db push
npx supabase functions deploy gemini-tutor --use-api
```

The backend limits each user to 30 tutor requests per hour and the project to 200 requests per hour.

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

Screenshots are held in memory only and are not written to disk. On each tutor request, the selected screenshot passes through the Supabase Edge Function to Gemini with `store: false`; application code does not persist the image. Conversation history is stored locally in an account-scoped file and can be disabled or cleared. Capture is visible, user-triggered, and can be paused from the app or tray. Renderer sandboxing, context isolation, restrictive navigation, sender-validated IPC, and denied renderer permission requests form the desktop security boundary.
