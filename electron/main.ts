import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type {
  CaptureResult,
  NestedExplanation,
  SessionMessage,
  StoredSettings,
  TargetBounds,
  TutorPlan,
  TutorSession,
  TutorStep,
} from './types';
import { clampTarget, extractInteractionText, migrateGeminiModel, normalizedToPixels } from './tutor-utils';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let collapsed = true;
let selectedSourceId = '';
let lastCapture: CaptureResult | null = null;
const ORB_SIZE = 76;
const PANEL_WIDTH = 440;
const PANEL_HEIGHT = 780;
const BUNDLED_GEMINI_API_KEY = 'AQ.Ab8RN6JLUC_N9kOJIV4dHTIS44nGvzhoTWna6l7AygLPPtrPoA';

const defaultSettings: StoredSettings = {
  visionPaused: false,
  historyEnabled: true,
  model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
};

function dataPath(file: string) {
  return path.join(app.getPath('userData'), file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(dataPath(file), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataPath(file), JSON.stringify(value, null, 2), 'utf8');
}

function getSettings(): StoredSettings {
  const settings = { ...defaultSettings, ...readJson<StoredSettings>('settings.json', defaultSettings) };
  // Transparently move installations created before Gemini 2.5 Flash was retired.
  settings.model = migrateGeminiModel(settings.model);
  return settings;
}

function publicSettings() {
  const settings = getSettings();
  return {
    visionPaused: settings.visionPaused,
    historyEnabled: settings.historyEnabled,
    model: settings.model,
  };
}

function getApiKey() {
  return BUNDLED_GEMINI_API_KEY;
}

function isAllowedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const url = event.senderFrame?.url || event.sender.getURL();
  if (isDev) return url.startsWith('http://localhost:5173');
  return url.startsWith('file://') && url.includes('/dist/index.html');
}

function secureHandle(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isAllowedSender(event)) throw new Error('Blocked IPC request from an untrusted renderer.');
    return handler(event, ...args);
  });
}

function loadApp(win: BrowserWindow, query?: Record<string, string>) {
  if (isDev) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL!);
    Object.entries(query || {}).forEach(([key, value]) => url.searchParams.set(key, value));
    return win.loadURL(url.toString());
  }
  return win.loadFile(path.join(__dirname, '../dist/index.html'), { query });
}

function createMainWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    x: workArea.x + workArea.width - ORB_SIZE - 18,
    y: workArea.y + workArea.height - ORB_SIZE - 18,
    width: ORB_SIZE,
    height: ORB_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.webContents.send('window:state', { collapsed: true });
  });
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const expected = isDev ? 'http://localhost:5173' : 'file://';
    if (!url.startsWith(expected)) event.preventDefault();
  });
  void loadApp(mainWindow);
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void loadApp(overlayWindow, { overlay: '1' });
}

function trayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path d="M8 5.5h32a5 5 0 0 1 5 5v23a5 5 0 0 1-5 5H25.8L16 45l1.9-6.5H8a5 5 0 0 1-5-5v-23a5 5 0 0 1 5-5Z" fill="#e85f43"/><path d="m11.5 20.1 12.7-6.8 12.7 6.8-12.7 6.8-12.7-6.8Z" fill="white"/><path d="M16.7 23.1v5.1c0 2.2 3.4 4 7.5 4s7.5-1.8 7.5-4v-5.1l-7.5 4-7.5-4Z" fill="white" opacity=".92"/><path d="M36.9 20.2v7.2" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round"/><circle cx="36.9" cy="29.4" r="2" fill="white"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('ScreenProf');
  const rebuild = () => {
    const paused = getSettings().visionPaused;
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open ScreenProf', click: () => showMainWindow() },
      {
        label: paused ? 'Resume AI vision' : 'Pause AI vision',
        click: () => {
          const settings = getSettings();
          settings.visionPaused = !settings.visionPaused;
          writeJson('settings.json', settings);
          mainWindow?.webContents.send('settings:changed', publicSettings());
          rebuild();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  rebuild();
  tray.on('click', showMainWindow);
}

function showMainWindow() {
  expandMainWindow();
}

function fit(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function expandMainWindow() {
  if (!mainWindow) return;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const area = display.workArea;
  const opensLeft = current.x + current.width / 2 > area.x + area.width / 2;
  const x = fit(opensLeft ? current.x + current.width - PANEL_WIDTH : current.x, area.x, area.x + area.width - PANEL_WIDTH);
  const y = fit(current.y, area.y, area.y + area.height - PANEL_HEIGHT);
  mainWindow.setMinimumSize(1, 1);
  mainWindow.setResizable(true);
  mainWindow.setBounds({ x, y, width: PANEL_WIDTH, height: PANEL_HEIGHT }, true);
  mainWindow.setMinimumSize(390, 640);
  mainWindow.setSkipTaskbar(false);
  collapsed = false;
  mainWindow.webContents.send('window:state', { collapsed: false });
  mainWindow.show();
  mainWindow.focus();
}

function collapseMainWindow() {
  if (!mainWindow) return;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const area = display.workArea;
  const x = fit(current.x + current.width - ORB_SIZE, area.x, area.x + area.width - ORB_SIZE);
  const y = fit(current.y, area.y, area.y + area.height - ORB_SIZE);
  mainWindow.setMinimumSize(1, 1);
  mainWindow.setResizable(false);
  mainWindow.setBounds({ x, y, width: ORB_SIZE, height: ORB_SIZE }, true);
  mainWindow.setSkipTaskbar(true);
  collapsed = true;
  mainWindow.webContents.send('window:state', { collapsed: true });
  mainWindow.showInactive();
}

async function listSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 300 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((source) => !source.name.toLowerCase().includes('screenprof'))
    .map((source) => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.toDataURL() || null,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    }));
}

async function captureSource(sourceId: string): Promise<CaptureResult> {
  if (getSettings().visionPaused) throw new Error('AI vision is paused. Resume it before sharing your screen.');
  if (!sourceId || sourceId.length > 200) throw new Error('Choose a screen or window to share.');
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1152, height: 720 },
    fetchWindowIcons: false,
  });
  const source = sources.find((item) => item.id === sourceId);
  if (!source) throw new Error('That screen source is no longer available. Choose it again.');
  const result: CaptureResult = {
    dataUrl: source.thumbnail.toJPEG(72).toString('base64').replace(/^/, 'data:image/jpeg;base64,'),
    sourceId: source.id,
    sourceName: source.name,
    displayId: source.display_id,
    capturedAt: new Date().toISOString(),
  };
  selectedSourceId = sourceId;
  lastCapture = result;
  return result;
}

const tutorStepSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short title for this step, at most 6 words.' },
    instruction: { type: 'string', description: 'A concise imperative instruction for the user.' },
    detail: { type: 'string', description: 'One short helpful explanation, including what success looks like.' },
    targetLabel: { type: ['string', 'null'], description: 'The exact visible label of the UI target, or null.' },
    target: {
      anyOf: [
        {
          type: 'object',
          properties: {
            x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
      description: 'Visible target bounds normalized to a 0-1000 coordinate space, or null.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    completed: { type: 'boolean' },
    needsClarification: { type: 'boolean' },
    clarification: { type: ['string', 'null'] },
  },
  required: ['title', 'instruction', 'detail', 'targetLabel', 'target', 'confidence', 'completed', 'needsClarification', 'clarification'],
  additionalProperties: false,
};

const tutorPlanSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short title for the complete tutorial.' },
    summary: { type: 'string', description: 'One sentence describing the overall approach.' },
    steps: {
      type: 'array',
      description: 'The complete ordered procedure from the current screen to the finished goal.',
      minItems: 1,
      maxItems: 12,
      items: tutorStepSchema,
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    completed: { type: 'boolean' },
  },
  required: ['title', 'summary', 'steps', 'confidence', 'completed'],
  additionalProperties: false,
};

const nestedExplanationSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'A clearer plain-language explanation of this one step.' },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      description: 'An ordered mini-guide whose steps use the same shape and behavior as the main guide.',
      items: tutorStepSchema,
    },
    tip: { type: ['string', 'null'], description: 'One useful caution or recognition tip, or null.' },
  },
  required: ['summary', 'steps', 'tip'],
  additionalProperties: false,
};

function validateStep(value: any): TutorStep {
  if (!value || typeof value !== 'object') throw new Error('Gemini returned an invalid tutor step.');
  return {
    title: String(value.title || 'Next step').slice(0, 100),
    instruction: String(value.instruction || '').slice(0, 800),
    detail: String(value.detail || '').slice(0, 1200),
    targetLabel: value.targetLabel == null ? null : String(value.targetLabel).slice(0, 200),
    target: clampTarget(value.target),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    completed: Boolean(value.completed),
    needsClarification: Boolean(value.needsClarification),
    clarification: value.clarification == null ? null : String(value.clarification).slice(0, 800),
  };
}

function validatePlan(value: any): TutorPlan {
  if (!value || typeof value !== 'object' || !Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error('Gemini returned an invalid tutorial plan.');
  }
  return {
    title: String(value.title || 'Your guide').slice(0, 120),
    summary: String(value.summary || '').slice(0, 1000),
    steps: value.steps.slice(0, 12).map(validateStep),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    completed: Boolean(value.completed),
  };
}

function validateExplanation(value: any): NestedExplanation {
  if (!value || typeof value !== 'object' || !Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error('Gemini returned an invalid expanded explanation.');
  }
  return {
    summary: String(value.summary || '').slice(0, 1200),
    steps: value.steps.slice(0, 6).map(validateStep),
    tip: value.tip == null ? null : String(value.tip).slice(0, 600),
  };
}

async function requestStructured(apiKey: string, model: string, prompt: string, imageData: string, schema: unknown, maxOutputTokens: number) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          store: false,
          input: [
            { type: 'text', text: prompt },
            { type: 'image', mime_type: 'image/jpeg', data: imageData },
          ],
          generation_config: {
            thinking_level: 'minimal',
            max_output_tokens: maxOutputTokens,
          },
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema,
          },
        }),
      });
      if (!response.ok) {
        const raw = await response.text();
        let message = `Gemini request failed (${response.status}).`;
        try { message = JSON.parse(raw)?.error?.message || message; } catch { /* keep safe message */ }
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, 900));
          continue;
        }
        throw new Error(message.slice(0, 500));
      }
      const json = await response.json() as any;
      const text = extractInteractionText(json);
      if (!text) throw new Error('Gemini returned an empty response.');
      return JSON.parse(text);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error('Gemini did not respond within 90 seconds. Check your connection or try a smaller window capture.');
      }
      if (attempt === 0 && error instanceof TypeError) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('Unable to reach Gemini after two attempts.');
}

async function askGemini(question: string, capture: CaptureResult, previousPlan?: TutorPlan, issue?: string, currentStepIndex?: number): Promise<TutorPlan> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('ScreenProf is not configured for live screen guidance.');
  const model = getSettings().model.replace(/[^a-zA-Z0-9._-]/g, '');
  const imageData = capture.dataUrl.split(',')[1];
  const revisionContext = previousPlan
    ? `\nExisting plan: ${JSON.stringify(previousPlan)}\nThe user reported a problem at step ${(currentStepIndex ?? 0) + 1}: ${String(issue || 'The step did not work').slice(0, 1000)}\nRewrite the complete plan to fit the newly visible screen. Preserve already completed steps at the beginning and revise the current and remaining steps.`
    : '';
  const prompt = `You are ScreenProf, a careful desktop software tutor.\n\nUser goal: ${question}\nVisible source: ${capture.sourceName}${revisionContext}\n\nCreate the complete ordered tutorial now, from the current state through completion. Do not make the user wait for a separate AI request after every step.\n\nRules:\n- Return every step needed for the whole task, up to 12 concise steps.\n- Each step must contain exactly one user action.\n- Only claim a control is currently visible when supported by the screenshot.\n- Coordinates use the screenshot itself, normalized from 0 to 1000.\n- Supply target coordinates only for a control visible on this screenshot; use null for controls that appear on later screens.\n- If the goal is already complete, set completed true.\n- If a step is uncertain, say what the user should look for and use a null target instead of inventing UI.\n- Do not request or expose passwords, financial data, authentication codes, API keys, or other secrets.\n- Warn before irreversible or consequential actions.\n- Keep every instruction crisp and practical.`;
  return validatePlan(await requestStructured(apiKey, model, prompt, imageData, tutorPlanSchema, 1200));
}

async function explainGemini(question: string, step: TutorStep, capture: CaptureResult, ancestry: string[] = [], issue?: string): Promise<NestedExplanation> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('ScreenProf is not configured for live screen guidance.');
  const model = getSettings().model.replace(/[^a-zA-Z0-9._-]/g, '');
  const imageData = capture.dataUrl.split(',')[1];
  const ancestryContext = ancestry.length ? `\nParent path: ${ancestry.map((item) => String(item).slice(0, 300)).join(' > ')}` : '';
  const issueContext = issue ? `\nThe user reported this problem with the selected step: ${String(issue).slice(0, 1000)}` : '';
  const prompt = `You are ScreenProf. The user wants a clearer inline mini-guide for one step in an existing desktop tutorial.\n\nOverall goal: ${question}\nApplication or screen: ${capture.sourceName}${ancestryContext}\nSelected step: ${step.instruction}\nExisting detail: ${step.detail}${issueContext}\n\nExplain only this selected step as 2 to 6 tiny, ordered steps. Every returned step must contain exactly one user action and use the same full step shape as a main tutorial step, including a concise detail and success cue. The returned steps may themselves be expanded later, so make each one independently understandable. Supply target coordinates only for controls visibly supported by this screenshot; otherwise use null. Do not repeat the whole tutorial, branch to another task, or include actions that belong after the selected parent step. Use plain, concise language.`;
  return validateExplanation(await requestStructured(apiKey, model, prompt, imageData, nestedExplanationSchema, 1800));
}

function saveConversation(question: string, plan: TutorPlan, capture: CaptureResult, sessionId?: string, issue?: string) {
  if (!getSettings().historyEnabled) return null;
  const sessions = readJson<TutorSession[]>('sessions.json', []);
  const now = new Date().toISOString();
  let current = sessions.find((item) => item.id === sessionId);
  if (!current) {
    current = {
      id: crypto.randomUUID(),
      title: question.slice(0, 62),
      sourceName: capture.sourceName,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    sessions.unshift(current);
  }
  const messages: SessionMessage[] = [
    { id: crypto.randomUUID(), role: 'user', content: issue ? `Issue: ${issue}` : question, createdAt: now },
    { id: crypto.randomUUID(), role: 'assistant', content: plan.summary, createdAt: now, step: plan.steps[0], plan },
  ];
  current.messages.push(...messages);
  current.updatedAt = now;
  writeJson('sessions.json', sessions.slice(0, 50));
  return current.id;
}

function showOverlay(step: TutorStep, displayId?: string) {
  // Electron does not expose reliable bounds for arbitrary captured windows.
  // Avoid translating window-relative AI coordinates onto the full desktop.
  if (!step.target || !overlayWindow || (lastCapture && !lastCapture.sourceId.startsWith('screen:'))) return;
  const displays = screen.getAllDisplays();
  const display = displays.find((item) => String(item.id) === displayId) || screen.getPrimaryDisplay();
  overlayWindow.setBounds(display.bounds);
  const pixelTarget = normalizedToPixels(step.target, display.bounds.width, display.bounds.height);
  overlayWindow.webContents.send('overlay:render', {
    target: pixelTarget,
    label: step.targetLabel || step.instruction,
  });
  overlayWindow.showInactive();
}

function registerIpc() {
  secureHandle('app:bootstrap', async () => ({
    settings: publicSettings(),
    sessions: readJson<TutorSession[]>('sessions.json', []),
    platform: process.platform,
    collapsed,
  }));
  secureHandle('sources:list', () => listSources());
  secureHandle('screen:capture', (_event, sourceId: string) => captureSource(sourceId));
  secureHandle('tutor:ask', async (_event, payload: { question: string; sourceId: string; sessionId?: string; previousPlan?: TutorPlan; issue?: string; currentStepIndex?: number }) => {
    const question = String(payload?.question || '').trim().slice(0, 2000);
    if (!question) throw new Error('Tell ScreenProf what you want to do.');
    const capture = await captureSource(String(payload?.sourceId || ''));
    const plan = await askGemini(question, capture, payload.previousPlan, payload.issue, payload.currentStepIndex);
    const sessionId = saveConversation(question, plan, capture, payload.sessionId, payload.issue);
    if (plan.steps[0]?.target) showOverlay(plan.steps[0], capture.displayId);
    return { plan, sessionId, capture, sessions: readJson<TutorSession[]>('sessions.json', []) };
  });
  secureHandle('tutor:explain', async (_event, payload: { question: string; sourceId: string; step: TutorStep; ancestry?: string[]; issue?: string }) => {
    const question = String(payload?.question || '').trim().slice(0, 2000);
    const sourceId = String(payload?.sourceId || '');
    const step = validateStep(payload?.step);
    const ancestry = Array.isArray(payload?.ancestry) ? payload.ancestry.slice(0, 20).map((item) => String(item).slice(0, 300)) : [];
    const issue = payload?.issue == null ? undefined : String(payload.issue).trim().slice(0, 1000);
    if (!question) throw new Error('The tutorial goal is missing.');
    // Expanding a step is an explicit user request, so capture the current UI once
    // to make the nested explanation match what is visible now.
    const capture = await captureSource(sourceId);
    return explainGemini(question, step, capture, ancestry, issue);
  });
  secureHandle('settings:update', (_event, update: { visionPaused?: boolean; historyEnabled?: boolean; model?: string }) => {
    const settings = getSettings();
    if (typeof update.visionPaused === 'boolean') settings.visionPaused = update.visionPaused;
    if (typeof update.historyEnabled === 'boolean') settings.historyEnabled = update.historyEnabled;
    if (typeof update.model === 'string' && /^[a-zA-Z0-9._-]{2,80}$/.test(update.model)) settings.model = update.model;
    writeJson('settings.json', settings);
    mainWindow?.webContents.send('settings:changed', publicSettings());
    return publicSettings();
  });
  secureHandle('history:clear', () => { writeJson('sessions.json', []); return []; });
  secureHandle('overlay:hide', () => overlayWindow?.hide());
  secureHandle('overlay:show', (_event, step: TutorStep) => showOverlay(validateStep(step), lastCapture?.displayId));
  secureHandle('window:minimize', () => mainWindow?.minimize());
  secureHandle('window:collapse', () => collapseMainWindow());
  secureHandle('window:expand', () => expandMainWindow());
  secureHandle('window:hide', () => mainWindow?.hide());
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerIpc();
  createMainWindow();
  createOverlayWindow();
  createTray();
  globalShortcut.register('CommandOrControl+Space', showMainWindow);
  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
    showMainWindow();
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && quitting) app.quit();
});
