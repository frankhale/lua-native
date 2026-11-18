// Positive control for tools/lint/run.mjs. NOT part of the build.
//
// A linter that reports clean must first demonstrate it can report dirty, and
// that it is reading *this project's* .clang-tidy rather than its defaults. So
// this file is deliberately wrong in ways the configuration must catch, and
// deliberately unusual in ways the configuration must let through. run.mjs
// lints it first and refuses to go on unless both halves hold.
//
// Each MUST-FIRE shape is one the first lint run found in src/ for real.

#include <string>

namespace lint_control {

struct Handle {
  const char* Reason() const { return "gone"; }
  bool live = false;
};

// MUST-FIRE clang-analyzer-core.CallAndMessage: the null test is defeated by
// the dereference in the branch it guards. This was RejectIfWorkerBusy and
// LuaFunctionCallbackStatic.
inline std::string NullGuardDefeated(const Handle* handle) {
  if (!handle || !handle->live) {
    return std::string("not usable: ") + handle->Reason();
  }
  return "ok";
}

// MUST-FIRE cppcoreguidelines-init-variables.
inline int Uninitialized(const bool flag) {
  int status;
  if (flag) status = 1;
  else status = 2;
  return status;
}

// MUST-FIRE cppcoreguidelines-special-member-functions: an RAII guard that can
// be copied restores twice.
struct Guard {
  int* depth;
  explicit Guard(int* d) : depth(d) { ++*depth; }
  ~Guard() { --*depth; }
};

// MUST-FIRE readability-identifier-naming: locals and parameters are
// snake_case. This check does nothing at all unless .clang-tidy supplies its
// options, so its firing here is what proves those options are connected.
inline int CamelCaseLocal(const int inputValue) {
  const int resultValue = inputValue + 1;
  return resultValue;
}

// MUST-FIRE readability-identifier-naming, for a private member this time: the
// member rule has its own options, so it needs its own proof.
class Counter {
 public:
  [[nodiscard]] int Next() { return ++callCount; }

 private:
  int callCount = 0;
};

// MUST-NOT-FIRE readability-identifier-length / readability-magic-numbers /
// modernize-use-trailing-return-type: all three are switched off in
// .clang-tidy, and all three are on in any default-ish configuration. If one
// of them fires here, the project configuration was not the one applied.
inline int L(const int n) { return n * 42; }

}  // namespace lint_control
