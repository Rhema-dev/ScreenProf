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

export function extractInteractionText(response: any): string {
  const fromSteps = response?.steps
    ?.filter((step: any) => step?.type === 'model_output')
    .flatMap((step: any) => Array.isArray(step.content) ? step.content : [])
    .filter((content: any) => content?.type === 'text')
    .map((content: any) => content.text || '')
    .join('');
  return fromSteps || response?.output_text || '';
}

export function rateLimitCooldownMs(retryAfter: string | null, responseBody: string, now = Date.now()) {
  let delayMs = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
  }
  if (!(delayMs > 0)) {
    try {
      const details = JSON.parse(responseBody)?.error?.details;
      const retryDelay = Array.isArray(details)
        ? details.find((detail: any) => typeof detail?.retryDelay === 'string')?.retryDelay
        : undefined;
      const match = typeof retryDelay === 'string' ? retryDelay.match(/^(\d+(?:\.\d+)?)s$/) : null;
      if (match) delayMs = Number(match[1]) * 1000;
    } catch { /* use the default cooldown */ }
  }
  return Math.max(1000, Math.min(delayMs > 0 ? delayMs : 60_000, 15 * 60_000));
}
