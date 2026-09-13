import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  session,
  Tray,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type {
  CaptureResult,
  AuthState,
  NestedExplanation,
  ResponseSection,
  ResponseType,
  SessionMessage,
  StoredSettings,
  TargetBounds,
  TutorPlan,
  TutorSession,
  TutorStep,
} from './types';
import { clampTarget, normalizedToPixels } from './tutor-utils';

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
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wbruqwwdflojipkarhcp.supabase.co';
const SUPABASE_FUNCTION_URL = process.env.SUPABASE_FUNCTION_URL
  || `${SUPABASE_URL}/functions/v1/gemini-tutor`;
// Supabase publishable keys are intentionally safe to distribute in clients.
// Access to data and functions is still controlled by RLS and user authentication.
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
  || 'sb_publishable_ZeT-yErjnHyZgzghdgW5lg_vV3iq1yj';

interface StoredAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string | null;
  userId: string;
}

let refreshInFlight: Promise<StoredAuthSession> | null = null;

const defaultSettings: StoredSettings = {
  visionPaused: false,
  historyEnabled: true,
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

function readAuthSession(): StoredAuthSession | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const decrypted = safeStorage.decryptString(fs.readFileSync(dataPath('auth-session.bin')));
    const value = JSON.parse(decrypted) as Partial<StoredAuthSession>;
    if (!value.accessToken || !value.refreshToken || !Number.isFinite(value.expiresAt)) return null;
    const userId = value.userId || userIdFromAccessToken(value.accessToken);
    if (!userId) return null;
    return {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: Number(value.expiresAt),
      email: value.email == null ? null : String(value.email),
      userId,
    };
  } catch {
    return null;
  }
}

function userIdFromAccessToken(accessToken: string) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload?.sub === 'string' ? payload.sub.slice(0, 128) : '';
  } catch {
    return '';
  }
}

function sessionFile() {
  const userId = readAuthSession()?.userId;
  if (!userId) return null;
  const accountHash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return `sessions-${accountHash}.json`;
}

function readSessions() {
  const file = sessionFile();
  return file ? readJson<TutorSession[]>(file, []) : [];
}

function writeSessions(sessions: TutorSession[]) {
  const file = sessionFile();
  if (!file) throw new Error('Sign in before changing conversation history.');
  writeJson(file, sessions);
}

function writeAuthSession(session: StoredAuthSession) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this computer.');
  }
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataPath('auth-session.bin'), safeStorage.encryptString(JSON.stringify(session)));
}

function clearAuthSession() {
  try {
    fs.unlinkSync(dataPath('auth-session.bin'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function publicAuthState(session = readAuthSession()): AuthState {
  return {
    signedIn: Boolean(session),
    email: session?.email || null,
  };
}

async function supabaseAuthRequest(pathname: string, body: Record<string, unknown>) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let result: any = {};
  try { result = JSON.parse(raw); } catch { /* use the status error */ }
  if (!response.ok) {
    throw new Error(String(result?.msg || result?.message || result?.error_description || `Sign-in failed (${response.status}).`).slice(0, 500));
  }
  return result;
}

function sessionFromAuthResponse(result: any, fallbackUserId = ''): StoredAuthSession | null {
  if (!result?.access_token || !result?.refresh_token) return null;
  const userId = typeof result.user?.id === 'string'
    ? result.user.id
    : userIdFromAccessToken(String(result.access_token)) || fallbackUserId;
  if (!userId) return null;
  return {
    accessToken: String(result.access_token),
    refreshToken: String(result.refresh_token),
    expiresAt: Number(result.expires_at) || Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600),
    email: result.user?.email == null ? null : String(result.user.email),
    userId,
  };
}

async function signIn(email: string, password: string): Promise<AuthState> {
  const result = await supabaseAuthRequest('token?grant_type=password', { email, password });
  const session = sessionFromAuthResponse(result);
  if (!session) throw new Error('Supabase did not return a valid sign-in session.');
  writeAuthSession(session);
  return publicAuthState(session);
}

async function signUp(email: string, password: string): Promise<AuthState> {
  const result = await supabaseAuthRequest('signup', { email, password });
  const session = sessionFromAuthResponse(result);
  if (session) {
    writeAuthSession(session);
    return publicAuthState(session);
  }
  return {
    signedIn: false,
    email,
    message: 'Check your email to confirm your account, then sign in.',
  };
}

async function refreshAuthSession(session: StoredAuthSession): Promise<StoredAuthSession> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const result = await supabaseAuthRequest('token?grant_type=refresh_token', {
        refresh_token: session.refreshToken,
      });
      const refreshed = sessionFromAuthResponse(result, session.userId);
      if (!refreshed) throw new Error('Supabase did not return a valid refreshed session.');
      writeAuthSession(refreshed);
      return refreshed;
    } catch (error) {
      clearAuthSession();
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function getAccessToken() {
  const session = readAuthSession();
  if (!session) throw new Error('Sign in from Settings to use the AI tutor.');
  if (session.expiresAt > Math.floor(Date.now() / 1000) + 60) return session.accessToken;
  return (await refreshAuthSession(session)).accessToken;
}

async function signOut(): Promise<AuthState> {
  const session = readAuthSession();
  if (session) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.accessToken}`,
        },
      });
    } catch {
      // Local sign-out must still succeed if the network is unavailable.
    }
  }
  clearAuthSession();
  return publicAuthState(null);
}

function getSettings(): StoredSettings {
  const stored = readJson<Partial<StoredSettings>>('settings.json', defaultSettings);
  return {
    visionPaused: typeof stored.visionPaused === 'boolean' ? stored.visionPaused : defaultSettings.visionPaused,
    historyEnabled: typeof stored.historyEnabled === 'boolean' ? stored.historyEnabled : defaultSettings.historyEnabled,
  };
}

function publicSettings() {
  const settings = getSettings();
  return {
    visionPaused: settings.visionPaused,
    historyEnabled: settings.historyEnabled,
  };
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

function appIconPath() {
  return isDev
    ? path.join(app.getAppPath(), 'public', 'screenprof-icon.png')
    : path.join(__dirname, '../dist/screenprof-icon.png');
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
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: appIconPath(),
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
  return nativeImage.createFromPath(appIconPath()).resize({ width: 16, height: 16 });
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
  mainWindow.setMovable(true);
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
    responseType: {
      type: 'string',
      enum: ['guide', 'explanation', 'troubleshooting'],
      description: 'The presentation style that best matches the user request.',
    },
    title: { type: 'string', description: 'A short title for the complete tutorial.' },
    summary: { type: 'string', description: 'A concise direct answer or description of the overall approach.' },
    sections: {
      type: 'array',
      description: 'Explanatory or diagnostic sections. Use an empty array for a straightforward guide.',
      minItems: 0,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short section heading.' },
          content: { type: 'string', description: 'A concise paragraph written for the user.' },
          points: {
            type: 'array',
            minItems: 0,
            maxItems: 6,
            items: { type: 'string' },
            description: 'Optional supporting facts, observations, or cautions.',
          },
        },
        required: ['title', 'content', 'points'],
        additionalProperties: false,
      },
    },
    steps: {
      type: 'array',
      description: 'Ordered user actions for guides and troubleshooting. Use an empty array for explanations.',
      minItems: 0,
      maxItems: 12,
      items: tutorStepSchema,
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    completed: { type: 'boolean' },
  },
  required: ['responseType', 'title', 'summary', 'sections', 'steps', 'confidence', 'completed'],
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

function validateSection(value: any): ResponseSection {
  return {
    title: String(value?.title || 'What this means').slice(0, 120),
    content: String(value?.content || '').slice(0, 2400),
    points: Array.isArray(value?.points)
      ? value.points.slice(0, 6).map((point: unknown) => String(point).slice(0, 600))
      : [],
  };
}

function validatePlan(value: any): TutorPlan {
  if (!value || typeof value !== 'object' || !Array.isArray(value.steps) || !Array.isArray(value.sections)) {
    throw new Error('Gemini returned an invalid tutorial plan.');
  }
  const responseType: ResponseType = ['guide', 'explanation', 'troubleshooting'].includes(value.responseType)
    ? value.responseType
    : 'guide';
  if (responseType !== 'explanation' && value.steps.length === 0) {
    throw new Error('Gemini returned a guide without any steps.');
  }
  const sections = value.sections.slice(0, 6).map(validateSection);
  if (responseType === 'explanation' && sections.length === 0) {
    sections.push(validateSection({ title: 'Explanation', content: value.summary, points: [] }));
  }
  return {
    responseType,
    title: String(value.title || 'Your guide').slice(0, 120),
    summary: String(value.summary || '').slice(0, 1000),
    sections,
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

async function requestTutorService(body: Record<string, unknown>) {
  const accessToken = await getAccessToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100_000);
  try {
    const response = await fetch(SUPABASE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let result: any;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new Error(response.ok
        ? 'The tutor service returned an invalid response.'
        : `The tutor service failed (${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(String(result?.error || `The tutor service failed (${response.status}).`).slice(0, 500));
    }
    return result;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('The tutor service did not respond within 100 seconds. Check your connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function askGemini(question: string, capture: CaptureResult, previousPlan?: TutorPlan, issue?: string, currentStepIndex?: number): Promise<TutorPlan> {
  const imageData = capture.dataUrl.split(',')[1];
  return validatePlan(await requestTutorService({
    operation: 'ask',
    question,
    sourceName: capture.sourceName,
    imageData,
    previousPlan,
    issue,
    currentStepIndex,
  }));
}

async function explainGemini(question: string, step: TutorStep, capture: CaptureResult, ancestry: string[] = [], issue?: string): Promise<NestedExplanation> {
  const imageData = capture.dataUrl.split(',')[1];
  return validateExplanation(await requestTutorService({
    operation: 'explain',
    question,
    sourceName: capture.sourceName,
    imageData,
    step,
    ancestry,
    issue,
  }));
}

function saveConversation(question: string, plan: TutorPlan, capture: CaptureResult, sessionId?: string, issue?: string) {
  if (!getSettings().historyEnabled) return null;
  const sessions = readSessions();
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
  writeSessions(sessions.slice(0, 50));
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
    auth: publicAuthState(),
    sessions: readSessions(),
    platform: process.platform,
    collapsed,
  }));
  secureHandle('sources:list', () => listSources());
  secureHandle('screen:capture', (_event, sourceId: string) => captureSource(sourceId));
  secureHandle('auth:sign-in', (_event, payload: { email?: string; password?: string }) => {
    const email = String(payload?.email || '').trim().toLowerCase().slice(0, 320);
    const password = String(payload?.password || '');
    if (!email || !password) throw new Error('Enter your email and password.');
    return signIn(email, password);
  });
  secureHandle('auth:sign-up', (_event, payload: { email?: string; password?: string }) => {
    const email = String(payload?.email || '').trim().toLowerCase().slice(0, 320);
    const password = String(payload?.password || '');
    if (!email || password.length < 8) throw new Error('Enter an email and a password of at least 8 characters.');
    return signUp(email, password);
  });
  secureHandle('auth:sign-out', () => signOut());
  secureHandle('tutor:ask', async (_event, payload: { question: string; sourceId: string; sessionId?: string; previousPlan?: TutorPlan; issue?: string; currentStepIndex?: number }) => {
    const question = String(payload?.question || '').trim().slice(0, 2000);
    if (!question) throw new Error('Tell ScreenProf what you want to do.');
    const capture = await captureSource(String(payload?.sourceId || ''));
    const plan = await askGemini(question, capture, payload.previousPlan, payload.issue, payload.currentStepIndex);
    const sessionId = saveConversation(question, plan, capture, payload.sessionId, payload.issue);
    if (plan.steps[0]?.target) showOverlay(plan.steps[0], capture.displayId);
    return { plan, sessionId, capture, sessions: readSessions() };
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
  secureHandle('settings:update', (_event, update: { visionPaused?: boolean; historyEnabled?: boolean }) => {
    const settings = getSettings();
    if (typeof update.visionPaused === 'boolean') settings.visionPaused = update.visionPaused;
    if (typeof update.historyEnabled === 'boolean') settings.historyEnabled = update.historyEnabled;
    writeJson('settings.json', settings);
    mainWindow?.webContents.send('settings:changed', publicSettings());
    return publicSettings();
  });
  secureHandle('history:clear', () => { writeSessions([]); return []; });
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
