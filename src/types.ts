export interface TargetBounds { x: number; y: number; width: number; height: number }
export interface TutorStep {
  title: string;
  instruction: string;
  detail: string;
  targetLabel: string | null;
  target: TargetBounds | null;
  confidence: number;
  completed: boolean;
  needsClarification: boolean;
  clarification: string | null;
}
export type ResponseType = 'guide' | 'explanation' | 'troubleshooting';
export interface ResponseSection {
  title: string;
  content: string;
  points: string[];
}
export interface TutorPlan {
  responseType: ResponseType;
  title: string;
  summary: string;
  sections: ResponseSection[];
  steps: TutorStep[];
  confidence: number;
  completed: boolean;
}
export interface NestedExplanation {
  summary: string;
  steps: TutorStep[];
  tip: string | null;
}
export interface CaptureSource {
  id: string;
  name: string;
  displayId: string;
  thumbnail: string;
  appIcon: string | null;
  kind: 'screen' | 'window';
}
export interface CaptureResult {
  dataUrl: string;
  sourceId: string;
  sourceName: string;
  displayId: string;
  capturedAt: string;
}
export interface PublicSettings {
  visionPaused: boolean;
  historyEnabled: boolean;
}
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  step?: TutorStep;
  plan?: TutorPlan;
}
export interface TutorSession {
  id: string;
  title: string;
  sourceName: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}
export interface BootstrapData {
  settings: PublicSettings;
  sessions: TutorSession[];
  platform: string;
  collapsed?: boolean;
}

export interface ScreenProfBridge {
  bootstrap(): Promise<BootstrapData>;
  listSources(): Promise<CaptureSource[]>;
  capture(sourceId: string): Promise<CaptureResult>;
  askTutor(payload: { question: string; sourceId: string; sessionId?: string; previousPlan?: TutorPlan; issue?: string; currentStepIndex?: number }): Promise<{ plan: TutorPlan; sessionId: string | null; capture: CaptureResult; sessions: TutorSession[] }>;
  explainStep(payload: { question: string; sourceId: string; step: TutorStep; ancestry?: string[]; issue?: string }): Promise<NestedExplanation>;
  updateSettings(update: { visionPaused?: boolean; historyEnabled?: boolean }): Promise<PublicSettings>;
  clearHistory(): Promise<TutorSession[]>;
  hideOverlay(): Promise<void>;
  showOverlay(step: TutorStep): Promise<void>;
  minimize(): Promise<void>;
  collapse(): Promise<void>;
  expand(): Promise<void>;
  hide(): Promise<void>;
  onWindowState(callback: (payload: { collapsed: boolean }) => void): () => void;
  onOverlay(callback: (payload: { target: TargetBounds; label: string }) => void): () => void;
  onSettingsChanged(callback: (payload: PublicSettings) => void): () => void;
}

declare global {
  interface Window { screenProf?: ScreenProfBridge }
}
