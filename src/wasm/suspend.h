// Letting the event loop have a turn in the middle of a deferred run
// (docs/WASM.md, "The two deferred doors"). The engine's half is JavaScript
// Promise Integration, and is set up in shell.js under "suspension".

#pragma once

namespace js {

// Called from the runtime's execution hook. Suspends the run if it has held
// the thread long enough.
void PauseIfDue();

// The run starting, or going on, now.
void StartSlice();

// The table index of the function that suspends, from the shell.
void SetPause(double index);

}  // namespace js
