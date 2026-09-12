import { describe, expect, it } from 'vitest';
import { clampTarget, extractInteractionText, migrateGeminiModel, normalizedToPixels } from './tutor-utils';

describe('tutor coordinate safety', () => {
  it('clamps model coordinates to the normalized screenshot', () => {
    expect(clampTarget({ x: -20, y: 990, width: 1200, height: 100 })).toEqual({
      x: 0,
      y: 990,
      width: 1000,
      height: 10,
    });
  });

  it('enforces a visible minimum target size', () => {
    expect(clampTarget({ x: 100, y: 100, width: 0, height: 1 })).toEqual({
      x: 100,
      y: 100,
      width: 8,
      height: 8,
    });
  });

  it('maps normalized coordinates onto a display', () => {
    expect(normalizedToPixels({ x: 250, y: 500, width: 100, height: 200 }, 1920, 1080)).toEqual({
      x: 480,
      y: 540,
      width: 192,
      height: 216,
    });
  });

  it('migrates the retired default without overriding custom models', () => {
    expect(migrateGeminiModel('gemini-2.5-flash')).toBe('gemini-3.6-flash');
    expect(migrateGeminiModel('gemini-3.8-flash')).toBe('gemini-3.8-flash');
  });

  it('reads structured text from an Interactions API response', () => {
    expect(extractInteractionText({
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'ignored' }] },
        { type: 'model_output', content: [{ type: 'text', text: '{"title":"Next step"}' }] },
      ],
    })).toBe('{"title":"Next step"}');
  });
});
