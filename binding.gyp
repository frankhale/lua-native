{
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
      "libraries": [
        "<!(npm run get-vcpkg-lib --silent)"
      ],
      "link_settings": {
          "libraries": [
            "<!(npm run get-vcpkg-lib --silent)"
          ]
      },
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "<!(npm run get-vcpkg-lib --silent)",
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
          "cflags_cc": [
            "-fno-exceptions"
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
            "MACOSX_DEPLOYMENT_TARGET": "15.0"
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
            "target_name": "test",
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
          "libraries": [
              "<!(npm run get-vcpkg-lib --silent)"
          ],
          "link_settings": {
              "libraries": [
                  "<!(npm run get-vcpkg-lib --silent)"
              ]
          },
          "conditions": [
            ["OS=='win'", {
              "libraries": [
                "<!(npm run get-vcpkg-lib --silent)",
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
              "cflags_cc": [
                "-fno-exceptions"
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
                "MACOSX_DEPLOYMENT_TARGET": "15.0"
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