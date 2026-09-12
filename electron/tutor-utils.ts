import type { TargetBounds } from './types';

export function clampTarget(target: TargetBounds | null): TargetBounds | null {
  if (!target) return null;
  const x = Math.max(0, Math.min(1000, Number(target.x) || 0));
  const y = Math.max(0, Math.min(1000, Number(target.y) || 0));
  return {
    x,
    y,
    width: Math.max(8, Math.min(1000 - x, Number(target.width) || 8)),
    height: Math.max(8, Math.min(1000 - y, Number(target.height) || 8)),
  };
}

export function normalizedToPixels(target: TargetBounds, width: number, height: number): TargetBounds {
  return {
    x: Math.round((target.x / 1000) * width),
    y: Math.round((target.y / 1000) * height),
    width: Math.round((target.width / 1000) * width),
    height: Math.round((target.height / 1000) * height),
  };
}

export function migrateGeminiModel(model: string) {
  return model === 'gemini-2.5-flash' ? 'gemini-3.6-flash' : model;
}

export function extractInteractionText(response: any): string {
  const fromSteps = response?.steps
    ?.filter((step: any) => step?.type === 'model_output')
    .flatMap((step: any) => Array.isArray(step.content) ? step.content : [])
    .filter((content: any) => content?.type === 'text')
    .map((content: any) => content.text || '')
    .join('');
  return fromSteps || response?.output_text || '';
}
