// Robust extraction of a JSON object out of model text (2026-08-08 error pass).
//
// Every "distill/extract/plan" path in the OS asks a model for one JSON object
// and used to do `text.match(/\{[\s\S]*\}/)` + JSON.parse. That has TWO real
// failure modes, both observed live in api.err.log:
//   1. GREEDY match — with any prose after the object (or nested braces), the
//      match runs to the LAST `}` in the whole response, which may be an inner
//      object's brace, yielding malformed JSON.
//   2. TRUNCATION — when the model hits its token cap mid-array, the text has
//      unclosed brackets, so parsing dies with
//      "Expected ',' or ']' after array element in JSON at position …"
//      and the whole capture is silently lost (knowledge-graph updates, skills).
//
// This scans for the FIRST balanced object (string-aware, so braces inside
// strings don't confuse it) and, when the text is truncated, REPAIRS it by
// rewinding to the last completed element and closing the open brackets — so a
// cut-off response still yields the entities/steps it did manage to emit.

/** Parse the first JSON object in `text`, tolerating trailing prose and
 *  truncation. Returns null when nothing salvageable is present. */
export function parseModelJson<T = unknown>(text: string): T | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  const stack: string[] = []; // expected closers, innermost last
  let inString = false;
  let escaped = false;
  let expectValue = false; // is the next string a VALUE (cuttable) or a KEY?
  let cutAt = -1; // index to cut at: just past the last COMPLETED element
  let cutStack: string[] = []; // bracket stack at that point

  const mark = (at: number): void => {
    cutAt = at;
    cutStack = [...stack];
  };

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        // Only a completed VALUE is a safe cut point — cutting after a key
        // (`{"a":1,"b"`) would produce invalid JSON.
        if (expectValue && stack.length) {
          mark(i + 1);
          expectValue = false;
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      expectValue = ch === '['; // array elements are values; object keys are not
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        // A complete, balanced object — the normal path.
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
      mark(i + 1); // a nested container just closed = a completed element
      expectValue = false;
      continue;
    }
    if (ch === ':') {
      expectValue = true;
      continue;
    }
    if (ch === ',') {
      // A comma proves everything before it at this depth is complete. Cut
      // BEFORE the comma so the dangling separator is dropped.
      mark(i);
      expectValue = stack[stack.length - 1] === ']'; // next is a value in an array, a key in an object
      continue;
    }
  }

  // Ran out of text with brackets still open → truncated. Rewind to the last
  // completed element, drop a dangling comma, and close what is still open.
  if (cutAt > start) {
    let repaired = text.slice(start, cutAt).replace(/,\s*$/, '');
    for (let i = cutStack.length - 1; i >= 0; i--) repaired += cutStack[i];
    try {
      return JSON.parse(repaired) as T;
    } catch {
      return null;
    }
  }
  return null;
}
