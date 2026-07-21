{
  "variables": {
    # Default to skipping the C++ test target so that source installs on
    # consumer machines (which run the `install` script) build only the addon.
    # Overridden to 0 by the build-debug script (`-Dskip_test=0`).
    "skip_test%": 1,
    # Build the C++ test binary with AddressSanitizer + UBSan (macOS/Linux,
    # clang/gcc). Off by default; the `build-asan` script sets `-Dsanitize=1`.
    # Only the standalone test executable is instrumented — the .node addon is
    # left alone because Node itself is not sanitized and would need the ASan
    # runtime preloaded to load an instrumented addon.
    "sanitize%": 0,
    # Build the C++ test binary with ThreadSanitizer instead. The core suite is
    # single-threaded, so this mostly documents that — the real worker/finalizer
    # races live in the async TS suite (see addon_tsan). `build-cpp-tsan` sets it.
    "cpp_tsan%": 0,
    # Instrument the .node ADDON with ASan+UBSan (addon_asan) or TSan
    # (addon_tsan). Used with the run-sanitized-ts.js harness, which preloads the
    # matching sanitizer runtime so an un-sanitized Node can load the instrumented
    # addon and run the TS suite under it. Mutually exclusive. Off by default so
    # the normal build-debug addon stays loadable everywhere.
    "addon_asan%": 0,
    "addon_tsan%": 0
  },
  "targets": [
    {
      "target_name": "lua-native",
      "sources": [
        "src/lua-native.cpp",
        "src/core/lua-runtime.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!(npm run get-vcpkg-include --silent)",
        "src"
      ],
      # Single source of truth for the vcpkg Lua library. gyp folds a
      # target-level "libraries" into link_settings itself, so a separate
      # link_settings block (and the copy in the OS=='win' condition below)
      # would only be a third place to forget to update.
      "libraries": [
        "<!(npm run get-vcpkg-lib --silent)"
      ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "winmm.lib",
            "user32.lib",
            "gdi32.lib",
            "kernel32.lib",
            "advapi32.lib"
          ],
          "defines": [
            "WIN32_LEAN_AND_MEAN",
            "NOMINMAX"
          ],
          "configurations": {
            "Debug": {
              "defines": [
                "DEBUG",
                "LUA_STATIC"
              ],
              "msvs_settings": {
                "VCCLCompilerTool": {
                  "RuntimeLibrary": 1,
                  "ExceptionHandling": 1,
                  "DebugInformationFormat": 1,
                  "Optimization": 0,
                  "BasicRuntimeChecks": 3,
                  "BufferSecurityCheck": "false",
                  "EnableFunctionLevelLinking": "true"
                },
                "VCLinkerTool": {
                  "GenerateDebugInformation": "true",
                  "LinkIncremental": 0,
                  "LinkTimeCodeGeneration": 0,
                  "AdditionalOptions": [
                    "/NODEFAULTLIB:MSVCRT",
                    "/NODEFAULTLIB:MSVCRTD",
                    "/NODEFAULTLIB:LIBCMT",
                    "/INCREMENTAL:NO"
                  ]
                }
              }
            },
            "Release": {
              "defines": [
                "NDEBUG",
                "LUA_STATIC"
              ],
              "msvs_settings": {
                "VCCLCompilerTool": {
                  "RuntimeLibrary": 0,
                  "ExceptionHandling": 1,
                  "Optimization": 2,
                  "BufferSecurityCheck": "false",
                  "EnableFunctionLevelLinking": "true",
                  "WholeProgramOptimization": "true"
                },
                "VCLinkerTool": {
                  "LinkTimeCodeGeneration": 1,
                  "LinkIncremental": 0,
                  "AdditionalDependencies": [
                    "libcpmt.lib",
                    "libcmt.lib"
                  ],
                  "AdditionalOptions": [
                    "/NODEFAULTLIB:MSVCRT",
                    "/NODEFAULTLIB:LIBCMT",
                    "/INCREMENTAL:NO",
                    "/OPT:REF",
                    "/OPT:ICF"
                  ]
                }
              }
            }
          }
        }],
        ["OS=='mac'", {
          "defines": [
            "LUA_STATIC",
            "_DARWIN_C_SOURCE"
          ],
          "cflags": [
            "-std=c++17",
            "-fPIC"
          ],
          "cflags_cc": [
            "-std=c++17",
            "-fPIC",
            "-fexceptions"
          ],
          "ldflags": [
            "-static-libgcc",
            "-static-libstdc++"
          ],
          "xcode_settings": {
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "GCC_ENABLE_CPP_RTTI": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "26.0"
          }
        }],
        # ASan+UBSan on the addon (addon_asan) — run via run-sanitized-ts.js,
        # which preloads the ASan runtime so an un-sanitized Node can load this
        # instrumented .node. Recoverable (no -fno-sanitize-recover) so a UBSan
        # finding is logged rather than crashing the whole test process mid-suite;
        # a real ASan memory error still aborts the run via ASAN_OPTIONS.
        ["addon_asan!=0", {
          "cflags": [ "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g" ],
          "cflags_cc": [ "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g" ],
          "ldflags": [ "-fsanitize=address,undefined" ],
          "xcode_settings": {
            "OTHER_CFLAGS": [ "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g" ],
            "OTHER_CPLUSPLUSFLAGS": [ "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g" ],
            "OTHER_LDFLAGS": [ "-fsanitize=address,undefined" ]
          }
        }],
        # TSan on the addon (addon_tsan). Note: TSan reasons about happens-before
        # from the accesses it sees; Node/libuv/V8 and static Lua are NOT
        # instrumented, so expect false positives from cross-boundary
        # synchronization it can't observe. Kept recoverable; triage with a
        # suppressions file (TSAN_OPTIONS=suppressions=...).
        ["addon_tsan!=0", {
          "cflags": [ "-fsanitize=thread", "-fno-omit-frame-pointer", "-g" ],
          "cflags_cc": [ "-fsanitize=thread", "-fno-omit-frame-pointer", "-g" ],
          "ldflags": [ "-fsanitize=thread" ],
          "xcode_settings": {
            "OTHER_CFLAGS": [ "-fsanitize=thread", "-fno-omit-frame-pointer", "-g" ],
            "OTHER_CPLUSPLUSFLAGS": [ "-fsanitize=thread", "-fno-omit-frame-pointer", "-g" ],
            "OTHER_LDFLAGS": [ "-fsanitize=thread" ]
          }
        }]
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NODE_ADDON_API_DISABLE_DEPRECATED",
        "NODE_ADDON_API_CPP_EXCEPTIONS"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions"
      ]
    }
  ],
  "conditions": [
    ["skip_test!=1", {
      "targets": [
          {
            "target_name": "lua-native-test",
            "type": "executable",
            "sources": [
              "src/core/lua-runtime.cpp",
              "tests/cpp/lua-native-test.cpp",
              "vendor/googletest/googletest/src/gtest-all.cc"
            ],
            "include_dirs": [
              "<!(npm run get-vcpkg-include --silent)",
              "src",
              "vendor/googletest/googletest/include",
              "vendor/googletest/googletest"
            ],
          # See the addon target: one declaration only (F10).
          "libraries": [
              "<!(npm run get-vcpkg-lib --silent)"
          ],
          "conditions": [
            ["OS=='win'", {
              "libraries": [
                "winmm.lib",
                "user32.lib",
                "gdi32.lib",
                "kernel32.lib",
                "advapi32.lib"                
              ],
              "defines": [
                "WIN32_LEAN_AND_MEAN",
                "NOMINMAX"
              ],
              "configurations": {
                "Debug": {
                  "defines": [
                    "DEBUG",
                    "LUA_STATIC"
                  ],
                  "msvs_settings": {
                    "VCCLCompilerTool": {
                      "RuntimeLibrary": 1,
                      "ExceptionHandling": 1,
                      "DebugInformationFormat": 1,
                      "Optimization": 0,
                      "BasicRuntimeChecks": 3,
                      "BufferSecurityCheck": "false",
                      "EnableFunctionLevelLinking": "true"
                    },
                    "VCLinkerTool": {
                      "GenerateDebugInformation": "true",
                      "LinkIncremental": 0,
                      "LinkTimeCodeGeneration": 0,
                      "AdditionalOptions": [
                        "/NODEFAULTLIB:MSVCRT",
                        "/NODEFAULTLIB:MSVCRTD",
                        "/NODEFAULTLIB:LIBCMT",
                        "/INCREMENTAL:NO"
                      ]
                    }
                  }
                },
                "Release": {
                  "defines": [
                    "NDEBUG",
                    "LUA_STATIC"
                  ],
                  "msvs_settings": {
                    "VCCLCompilerTool": {
                      "RuntimeLibrary": 0,
                      "ExceptionHandling": 1,
                      "Optimization": 2,
                      "BufferSecurityCheck": "false",
                      "EnableFunctionLevelLinking": "true",
                      "WholeProgramOptimization": "true"
                    },
                    "VCLinkerTool": {
                      "LinkTimeCodeGeneration": 1,
                      "LinkIncremental": 0,
                      "AdditionalDependencies": [
                        "libcpmt.lib",
                        "libcmt.lib"                        
                      ],
                      "AdditionalOptions": [
                        "/NODEFAULTLIB:MSVCRT",
                        "/NODEFAULTLIB:LIBCMT",
                        "/INCREMENTAL:NO",
                        "/OPT:REF",
                        "/OPT:ICF"
                      ]
                    }
                  }
                }
              }
            }],
            ["OS=='mac'", {
              "defines": [
                "LUA_STATIC",
                "_DARWIN_C_SOURCE"
              ],
              "cflags": [
                "-std=c++17",
                "-fPIC"
              ],
              "cflags_cc": [
                "-std=c++17",
                "-fPIC",
                "-fexceptions"
              ],
              "ldflags": [
                "-static-libgcc",
                "-static-libstdc++"
              ],
              "xcode_settings": {
                "CLANG_CXX_LIBRARY": "libc++",
                "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
                "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
                "GCC_ENABLE_CPP_RTTI": "YES",
                "MACOSX_DEPLOYMENT_TARGET": "26.0"
              }
            }],
            # AddressSanitizer + UBSan for the standalone test binary. Enabled by
            # -Dsanitize=1 (the `build-asan` script). -fno-sanitize-recover=all
            # makes UBSan abort on the first violation instead of logging and
            # continuing, so a failure fails the test run. On macOS the flags must
            # go through xcode_settings (cflags/ldflags are ignored there); the
            # cflags/ldflags copies cover a gcc/clang Linux build.
            ["sanitize!=0", {
              "cflags": [
                "-fsanitize=address,undefined",
                "-fno-omit-frame-pointer",
                "-fno-sanitize-recover=all",
                "-g"
              ],
              "cflags_cc": [
                "-fsanitize=address,undefined",
                "-fno-omit-frame-pointer",
                "-fno-sanitize-recover=all",
                "-g"
              ],
              "ldflags": [
                "-fsanitize=address,undefined"
              ],
              "xcode_settings": {
                "OTHER_CFLAGS": [
                  "-fsanitize=address,undefined",
                  "-fno-omit-frame-pointer",
                  "-fno-sanitize-recover=all",
                  "-g"
                ],
                "OTHER_CPLUSPLUSFLAGS": [
                  "-fsanitize=address,undefined",
                  "-fno-omit-frame-pointer",
                  "-fno-sanitize-recover=all",
                  "-g"
                ],
                "OTHER_LDFLAGS": [
                  "-fsanitize=address,undefined"
                ]
              }
            }],
            # ThreadSanitizer for the standalone test binary (-Dcpp_tsan=1). The
            # core suite is single-threaded, so this is expected to find nothing —
            # it exists as a regression guard if threading is ever added to the
            # core, and to document that the real races live in the async TS suite.
            ["cpp_tsan!=0", {
              "cflags": [ "-fsanitize=thread", "-fno-omit-frame-pointer", "-g" ],
              "cflags_cc": [ "-fsanitize=thread", "-fno-omit-frame-pointer", "-g" ],
              "ldflags": [ "-fsanitize=thread" ],
              "xcode_settings": {
                "OTHER_CFLAGS": [ "-fsanitize=thread", "-fno-omit-frame-pointer", "-g" ],
                "OTHER_CPLUSPLUSFLAGS": [ "-fsanitize=thread", "-fno-omit-frame-pointer", "-g" ],
                "OTHER_LDFLAGS": [ "-fsanitize=thread" ]
              }
            }]
          ],
            "defines": [],
          "cflags_cc": [
            "-std=c++17"
          ]
        }
      ]
    }]
  ]
}