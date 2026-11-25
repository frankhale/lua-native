#include "suspend.h"

#include <chrono>
#include <cstdint>

namespace {

using Clock = std::chrono::steady_clock;

// How long a run holds the thread at a time. Long enough that the turns between
// cost little, short enough that a page does not miss a frame to one.
constexpr std::chrono::milliseconds kSlice{8};

// One run executes at a time, however many are suspended, so one slice is
// being timed.
struct Suspension {
  void (*pause)() = nullptr;
  Clock::time_point slice_start;
};

Suspension& State() {
  static Suspension state;
  return state;
}

}  // namespace

void js::SetPause(const double index) {
  // A table index is what a function pointer is on this target.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast,performance-no-int-to-ptr): as above
  State().pause = reinterpret_cast<void (*)()>(static_cast<uintptr_t>(index));
}

void js::StartSlice() { State().slice_start = Clock::now(); }

void js::PauseIfDue() {
  if (Clock::now() - State().slice_start < kSlice) return;
  if (State().pause == nullptr) return;
  State().pause();
  StartSlice();
}
