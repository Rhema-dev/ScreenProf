export type TutorMode = 'observe' | 'guide';

export interface TargetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

export interface TutorPlan {
  title: string;
  summary: string;
  steps: TutorStep[];
  confidence: number;
  completed: boolean;
}

export interface NestedExplanation {
  summary: string;
  steps: TutorStep[];
  tip: string | null;
}

export interface CaptureResult {
  dataUrl: string;
  sourceId: string;
  sourceName: string;
  displayId: string;
  capturedAt: string;
}

export interface StoredSettings {
  visionPaused: boolean;
  historyEnabled: boolean;
  model: string;
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
