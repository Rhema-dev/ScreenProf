import type { BootstrapData, CaptureSource, TutorPlan, TutorStep } from './types';

export const mockBootstrap: BootstrapData = {
  platform: 'browser-preview',
  settings: { visionPaused: false, historyEnabled: true },
  sessions: [],
};

export const mockSources: CaptureSource[] = [
  { id: 'demo-screen', name: 'Entire Screen', displayId: '1', kind: 'screen', appIcon: null, thumbnail: '' },
  { id: 'demo-window', name: 'Budget 2026 — Microsoft Excel', displayId: '1', kind: 'window', appIcon: null, thumbnail: '' },
];

export const mockStep: TutorStep = {
  title: 'Open the Insert tab',
  instruction: 'Click “Insert” in the top toolbar.',
  detail: 'This opens the tools you need to create a chart. You’ll see chart options appear below the toolbar.',
  targetLabel: 'Insert',
  target: { x: 214, y: 76, width: 78, height: 38 },
  confidence: 0.96,
  completed: false,
  needsClarification: false,
  clarification: null,
};

export const mockPlan: TutorPlan = {
  responseType: 'guide',
  title: 'Create a chart in Excel',
  summary: 'Use the Insert tab to choose a chart, then adjust its title and layout.',
  sections: [],
  confidence: 0.94,
  completed: false,
  steps: [
    mockStep,
    { ...mockStep, title: 'Choose a chart', instruction: 'Select the chart type you want from the Charts group.', detail: 'A column chart is a clear default for comparing values.', targetLabel: null, target: null, confidence: 0.9 },
    { ...mockStep, title: 'Confirm the preview', instruction: 'Click the chart preview to insert it into the sheet.', detail: 'The chart will appear over your selected data.', targetLabel: null, target: null, confidence: 0.88 },
    { ...mockStep, title: 'Name the chart', instruction: 'Click the chart title and type a descriptive name.', detail: 'Use a short title that explains what the values represent.', targetLabel: null, target: null, confidence: 0.86 },
  ],
};
