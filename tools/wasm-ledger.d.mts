// Types for the part of the WASM ledger the suite reads. The rest of
// `wasm-ledger.mjs` is used only by `tools/wasm-verify/`, which is plain JS.

/** A suite test's name as the ledger spells it: its `describe` chain and title. */
export declare function testKey(ancestors: string[], title: string): string;

/** The tests the suite must not start on a target, full name to reason.
 *  Empty for the native binding. */
export declare function notRunOn(family: 'native' | 'wasm'): Map<string, string>;
