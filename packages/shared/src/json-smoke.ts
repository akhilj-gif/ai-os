// Deterministic smoke for parseModelJson — the shared model-output JSON
// extractor now used by 7 capture/plan paths (graph, extract, experience,
// cognition, learning, coding, planner). Pure, no DB/model/network.
import { parseModelJson } from './json.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('parseModelJson');

// 1. Plain object.
check('parses a plain object', parseModelJson<{ a: number }>('{"a":1}')?.a === 1);

// 2. Prose before AND after (the greedy-match trap: a naive /\{[\s\S]*\}/ would
//    swallow the trailing brace of the prose and break).
const withProse = parseModelJson<{ a: number }>('Sure! Here you go:\n{"a":1}\nHope that helps :}');
check('ignores surrounding prose', withProse?.a === 1, JSON.stringify(withProse));

// 3. Nested objects — must return the OUTER object, not stop at the inner brace.
const nested = parseModelJson<{ outer: { inner: number }; tail: number }>('{"outer":{"inner":2},"tail":3}');
check('handles nesting', nested?.outer.inner === 2 && nested?.tail === 3);

// 4. Braces inside strings must not confuse the scanner.
const strBraces = parseModelJson<{ s: string; n: number }>('{"s":"a } b { c","n":4}');
check('braces inside strings', strBraces?.s === 'a } b { c' && strBraces?.n === 4);

// 5. Escaped quote inside a string.
const esc = parseModelJson<{ s: string }>('{"s":"he said \\"hi\\" }"}');
check('escaped quotes', esc?.s === 'he said "hi" }');

// 6. THE LIVE BUG: truncated mid-array (model hit its token cap). Must salvage
//    the complete elements instead of losing the whole capture.
const truncated = '{"entities":[{"name":"pgvector","kind":"tool"},{"name":"Akhil","kind":"person"},{"name":"partial';
const salvaged = parseModelJson<{ entities: Array<{ name: string }> }>(truncated);
check('salvages truncated array', salvaged?.entities?.length === 2, JSON.stringify(salvaged));
check('salvaged entries are intact', salvaged?.entities?.[0]?.name === 'pgvector' && salvaged?.entities?.[1]?.name === 'Akhil');

// 7. Truncated right after a comma (dangling comma must be dropped).
const danglingComma = parseModelJson<{ xs: number[] }>('{"xs":[1,2,3,');
check('drops a dangling comma', JSON.stringify(danglingComma?.xs) === '[1,2,3]', JSON.stringify(danglingComma));

// 8. Truncated inside a nested object — closes both brackets.
const deepTrunc = parseModelJson<{ a: { b: string } }>('{"a":{"b":"done"');
check('closes nested truncation', deepTrunc?.a?.b === 'done', JSON.stringify(deepTrunc));

// 9. No JSON at all → null (never throws).
check('returns null on no JSON', parseModelJson('I could not do that.') === null);

// 10. Garbage that starts a brace but has nothing salvageable → null, no throw.
check('returns null on unsalvageable', parseModelJson('{not json at all') === null);

console.log(fail === 0 ? `\nAll ${pass} json checks passed` : `\n${fail} of ${pass + fail} json checks FAILED`);
process.exit(fail === 0 ? 0 : 1);
