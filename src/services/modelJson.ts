/** The JSON object in a model reply, shared by every Copilot feature. No `vscode` here. */

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The JSON object in a model reply. Models often wrap it in prose or a code fence, or add a note
 * after it, so the first balanced top-level object is taken when the whole reply does not parse.
 */
export function parseModelJson(text: string): Record<string, unknown> | undefined {
  const attempt = (candidate: string) => {
    try { const value: unknown = JSON.parse(candidate); return record(value) ? value : undefined; } catch { return undefined; }
  };
  const whole = attempt(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (whole) { return whole; }
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (char === '\\') { index++; } else if (char === '"') { inString = false; }
      } else if (char === '"') { inString = true; }
      else if (char === '{') { depth++; }
      else if (char === '}' && --depth === 0) {
        const value = attempt(text.slice(start, index + 1));
        if (value) { return value; }
        break;
      }
    }
  }
  return undefined;
}
