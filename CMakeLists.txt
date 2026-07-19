# 3.20 covers everything used here (CMAKE_MSVC_RUNTIME_LIBRARY/CMP0091 needs
# 3.15, list(SORT COMPARE NATURAL) needs 3.18). The previous 3.31 floor rejected
# stock CMake on current LTS distros for no reason (F7).
cmake_minimum_required(VERSION 3.20)

# Use VCPKG_ROOT environment variable if set
if(DEFINED ENV{VCPKG_ROOT})
    set(CMAKE_TOOLCHAIN_FILE "$ENV{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake" CACHE STRING "Vcpkg toolchain file")
endif()

# Set vcpkg triplet based on OS and architecture
# NOTE: CMAKE_SYSTEM_PROCESSOR is not available until after project(), so we
# use CMAKE_HOST_SYSTEM_PROCESSOR (available at CMake startup) with a uname
# fallback to detect the architecture before the vcpkg toolchain runs.
if(NOT DEFINED _LUA_NATIVE_DETECTED_ARCH)
    if(CMAKE_HOST_SYSTEM_PROCESSOR)
        set(_LUA_NATIVE_DETECTED_ARCH "${CMAKE_HOST_SYSTEM_PROCESSOR}")
    elseif(APPLE OR UNIX)
        execute_process(COMMAND uname -m OUTPUT_VARIABLE _LUA_NATIVE_DETECTED_ARCH OUTPUT_STRIP_TRAILING_WHITESPACE)
    endif()
endif()

if(WIN32)
    set(VCPKG_TARGET_TRIPLET "x64-windows-static" CACHE STRING "Vcpkg target triplet")
elseif(APPLE)
    # Check for Apple Silicon vs Intel
    if(_LUA_NATIVE_DETECTED_ARCH MATCHES "arm64|aarch64")
        set(VCPKG_TARGET_TRIPLET "arm64-osx" CACHE STRING "Vcpkg target triplet")
    else()
        set(VCPKG_TARGET_TRIPLET "x64-osx" CACHE STRING "Vcpkg target triplet")
    endif()
else()
    message(WARNING "Unsupported platform - using default x64 triplet")
    set(VCPKG_TARGET_TRIPLET "x64-unknown" CACHE STRING "Vcpkg target triplet")
endif()

project(lua-native)

set(CMAKE_CXX_STANDARD 17)

# Set platform-specific compiler and linker flags
# NOTE: Must be after project() so CMAKE_CXX_COMPILER_ID and MSVC are available.
if(WIN32 AND MSVC)
    # Windows with MSVC - static runtime and function-level linking
    set(PLATFORM_COMPILER_FLAGS /MT$<$<CONFIG:Debug>:d> /Gy)
    set(PLATFORM_LINKER_FLAGS "/NODEFAULTLIB:MSVCRT" "/NODEFAULTLIB:MSVCRTD" "/INCREMENTAL:NO")
    if(CMAKE_BUILD_TYPE STREQUAL "Release")
        list(APPEND PLATFORM_COMPILER_FLAGS "/GL")
        list(APPEND PLATFORM_LINKER_FLAGS "/OPT:REF" "/OPT:ICF" "/LTCG")
    endif()
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    set(CompilerFlags
            CMAKE_CXX_FLAGS
            CMAKE_CXX_FLAGS_DEBUG
            CMAKE_CXX_FLAGS_RELEASE
            CMAKE_C_FLAGS
            CMAKE_C_FLAGS_DEBUG
            CMAKE_C_FLAGS_RELEASE
    )
    foreach(CompilerFlag ${CompilerFlags})
        string(REPLACE "/MD" "/MT" ${CompilerFlag} "${${CompilerFlag}}")
    endforeach()
elseif(APPLE)
    # macOS - Clang doesn't support -static-libgcc, use appropriate flags
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        set(PLATFORM_COMPILER_FLAGS "-fPIC")
        # Clang on macOS doesn't need static linking flags like GCC
        # The system libraries are handled differently
    else()
        # Fallback for GCC on macOS (rare)
        set(PLATFORM_LINKER_FLAGS "-static-libgcc;-static-libstdc++")
    endif()
endif()

# Output info about build type and platform
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Platform: ${CMAKE_SYSTEM_NAME}")
message(STATUS "Architecture: ${CMAKE_SYSTEM_PROCESSOR}")
message(STATUS "Compiler: ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")

# Find Lua via vcpkg
find_package(Lua REQUIRED)

# Add after find_package(Lua REQUIRED)
message(STATUS "Lua found: ${LUA_FOUND}")
message(STATUS "Lua include dir: ${LUA_INCLUDE_DIR}")
message(STATUS "Lua libraries: ${LUA_LIBRARIES}")

# Find node-addon-api headers - improve search paths
find_path(NAPI_INCLUDE_DIR napi.h
    PATHS 
        "${CMAKE_SOURCE_DIR}/node_modules/node-addon-api"
        "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api"
        "../node_modules/node-addon-api"
    NO_DEFAULT_PATH
)

# Print node-addon-api location for debugging
message(STATUS "NAPI_INCLUDE_DIR: ${NAPI_INCLUDE_DIR}")

if(NOT NAPI_INCLUDE_DIR)
    message(FATAL_ERROR "node-addon-api headers not found. Run 'npm install' to install dependencies.")
endif()

# Find Node.js headers and libraries automatically.
#
# IMPORTANT: find_path()/find_library() treat PATHS entries literally — a "*" in
# a path is NOT expanded. Every node-gyp cache directory must therefore be
# globbed into an explicit candidate list first; passing the wildcard straight to
# find_path silently matches nothing (F3).

# Collects "<cache-root>/<version><suffix>" for every installed node-gyp version,
# newest first, into the named output variable.
function(collect_node_gyp_dirs OUT_VAR SUFFIX)
    set(_result "")
    foreach(_cache_root
            "$ENV{APPDATA}/node-gyp/Cache"
            "$ENV{LOCALAPPDATA}/node-gyp/Cache"
            "$ENV{USERPROFILE}/AppData/Local/node-gyp/Cache"
            "$ENV{HOME}/.node-gyp"
            "$ENV{HOME}/Library/Caches/node-gyp")
        if(EXISTS "${_cache_root}")
            file(GLOB _versions "${_cache_root}/*")
            # Newest version first, so a stale old cache never wins.
            list(SORT _versions COMPARE NATURAL ORDER DESCENDING)
            foreach(_v ${_versions})
                if(IS_DIRECTORY "${_v}")
                    list(APPEND _result "${_v}${SUFFIX}")
                endif()
            endforeach()
        endif()
    endforeach()
    set(${OUT_VAR} "${_result}" PARENT_SCOPE)
endfunction()

collect_node_gyp_dirs(NODE_INCLUDE_CANDIDATES "/include/node")
list(APPEND NODE_INCLUDE_CANDIDATES
        "/usr/include/node"
        "/usr/local/include/node"
        "/opt/homebrew/include/node"  # macOS Homebrew ARM
        "/usr/local/opt/node/include/node"  # macOS Homebrew Intel
        "C:/Program Files/nodejs/include/node"
        "C:/Program Files (x86)/nodejs/include/node"
)

find_path(NODE_INCLUDE_DIR node.h
    PATHS ${NODE_INCLUDE_CANDIDATES}
    NO_DEFAULT_PATH
)

# If not found, try with default paths
if(NOT NODE_INCLUDE_DIR)
    find_path(NODE_INCLUDE_DIR node.h)
endif()

if(NOT NODE_INCLUDE_DIR)
    message(FATAL_ERROR "Node.js headers not found. Please install Node.js or set NODE_INCLUDE_DIR manually.")
endif()

message(STATUS "NODE_INCLUDE_DIR: ${NODE_INCLUDE_DIR}")

# Node.js library discovery.
#
# A .node addon resolves Node's symbols from the hosting process at load time,
# so on macOS (and ELF platforms) the correct strategy is dynamic lookup, NOT
# linking a libnode: binding against a Homebrew libnode would hard-tie the addon
# to a Node build that need not match the one running it. Only Windows requires
# a real import library (node.lib), which node-gyp caches per version/arch (F3/F7).
set(NODE_LIBRARY "")

if(WIN32)
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(_node_arch "x64")
    else()
        set(_node_arch "x86")
    endif()
    # Cache layout: <cache>/<version>/<arch>/node.lib
    collect_node_gyp_dirs(NODE_LIB_CANDIDATES "/${_node_arch}")
    find_library(NODE_LIBRARY
        NAMES node
        PATHS ${NODE_LIB_CANDIDATES}
        NO_DEFAULT_PATH
    )
    if(NOT NODE_LIBRARY)
        message(FATAL_ERROR
            "node.lib not found for arch '${_node_arch}'.\n"
            "Populate the node-gyp cache first (it downloads the headers and "
            "import library):\n"
            "    npx node-gyp install\n"
            "or point -DNODE_LIBRARY=<path to node.lib> at an existing copy.")
    endif()
    message(STATUS "NODE_LIBRARY: ${NODE_LIBRARY}")
else()
    message(STATUS "NODE_LIBRARY: (none - using runtime symbol resolution)")
endif()

# Core static library (pure C++)
add_library(lua_native_core STATIC
        src/core/lua-runtime.h
        src/core/lua-runtime.cpp
)

target_include_directories(lua_native_core PUBLIC ${LUA_INCLUDE_DIR} src)
target_link_libraries(lua_native_core PUBLIC ${LUA_LIBRARIES})

# The core compiles the same translation unit as the gyp build, so it must see
# the same preprocessor environment (F7). LUA_STATIC matches the static vcpkg
# triplets; NOMINMAX/WIN32_LEAN_AND_MEAN keep windows.h from injecting min/max
# macros into this TU.
target_compile_definitions(lua_native_core PRIVATE LUA_STATIC)
if(WIN32)
    target_compile_definitions(lua_native_core PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
elseif(APPLE)
    target_compile_definitions(lua_native_core PRIVATE _DARWIN_C_SOURCE)
endif()

# Define the shared library for the Node.js addon (adapter)
add_library(lua-native SHARED src/lua-native.h src/lua-native.cpp)

# Set the output name and extension to match Node.js addon expectations
set_target_properties(lua-native PROPERTIES
        PREFIX ""
        SUFFIX ".node"
        OUTPUT_NAME "lua-native"
)

# Apply platform-specific compiler and linker flags
if(DEFINED PLATFORM_COMPILER_FLAGS)
    target_compile_options(lua-native PRIVATE ${PLATFORM_COMPILER_FLAGS})
endif()

if(DEFINED PLATFORM_LINKER_FLAGS)
    target_link_options(lua-native PRIVATE ${PLATFORM_LINKER_FLAGS})
endif()

# Include directories
target_include_directories(lua-native PRIVATE
        ${LUA_INCLUDE_DIR}
        ${NAPI_INCLUDE_DIR}
        ${NODE_INCLUDE_DIR}
        src
)

# Link libraries. Windows links node.lib; every other platform resolves Node's
# symbols from the hosting process at load time (F3/F7). The old code linked a
# discovered libnode when one happened to exist and set INSTALL_RPATH to the node
# *executable* (rpath entries are directories, so that was a no-op) — both are
# gone.
target_link_libraries(lua-native PRIVATE lua_native_core)

if(WIN32)
    target_link_libraries(lua-native PRIVATE ${NODE_LIBRARY})
elseif(APPLE)
    target_link_options(lua-native PRIVATE "-Wl,-undefined,dynamic_lookup")
else()
    # ELF shared objects permit undefined symbols by default; nothing to add.
endif()

# Add standard CRT libraries (Windows MSVC only)
if(WIN32 AND MSVC)
    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
        target_link_libraries(lua-native PRIVATE libcpmtd.lib libcmtd.lib)
    else()
        target_link_libraries(lua-native PRIVATE libcpmt.lib libcmt.lib)
    endif()
endif()

# Must match binding.gyp exactly: the binding layer is written for C++ exception
# mode (its error handling relies on node-addon-api throwing Napi::Error into the
# surrounding try/catch, and the core throws std::runtime_error). Defining
# NAPI_DISABLE_CPP_EXCEPTIONS here instead would still compile, but failed N-API
# calls would set a pending exception and return, so the addon would silently
# continue past failed conversions with default-constructed values — a
# behaviourally different binary from the gyp build (F2).
target_compile_definitions(lua-native PRIVATE
        NODE_ADDON_API_CPP_EXCEPTIONS
        NAPI_VERSION=8  # Set appropriate NAPI version
        NODE_ADDON_API_DISABLE_DEPRECATED
)

# Platform-specific definitions
if(WIN32)
    target_compile_definitions(lua-native PRIVATE
            WIN32_LEAN_AND_MEAN
            NOMINMAX
    )
elseif(APPLE)
    target_compile_definitions(lua-native PRIVATE
            _DARWIN_C_SOURCE
    )
endif()

# Set output directory based on build configuration and platform
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(OUTPUT_DIR "${CMAKE_SOURCE_DIR}/build/Debug")
else()
    set(OUTPUT_DIR "${CMAKE_SOURCE_DIR}/build/Release")
endif()

# Add platform-specific subdirectory if needed
if(APPLE)
    set(OUTPUT_DIR "${OUTPUT_DIR}/macos")
elseif(WIN32)
    set(OUTPUT_DIR "${OUTPUT_DIR}/windows")
endif()

set_target_properties(lua-native PROPERTIES
        LIBRARY_OUTPUT_DIRECTORY "${OUTPUT_DIR}"
        RUNTIME_OUTPUT_DIRECTORY "${OUTPUT_DIR}"
)

message(STATUS "Output directory set to: ${OUTPUT_DIR}")

# Google Test setup - only build tests in Debug mode
message(STATUS "CMAKE_BUILD_TYPE: ${CMAKE_BUILD_TYPE}")
message(STATUS "Checking if tests should be built...")

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    message(STATUS "Debug mode detected - building tests")
    enable_testing()    

    # Add test executable (core-only)
    add_executable(lua-native-test
        tests/cpp/lua-native-test.cpp
        vendor/googletest/googletest/src/gtest-all.cc
    )
    
    # Set test executable properties
    set_target_properties(lua-native-test PROPERTIES
        OUTPUT_NAME "lua-native-test"
    )
    
    # Apply platform-specific compiler and linker flags to test
    if(DEFINED PLATFORM_COMPILER_FLAGS)
        target_compile_options(lua-native-test PRIVATE ${PLATFORM_COMPILER_FLAGS})
    endif()
    
    if(DEFINED PLATFORM_LINKER_FLAGS)
        target_link_options(lua-native-test PRIVATE ${PLATFORM_LINKER_FLAGS})
    endif()
    
    # Include directories for test
    target_include_directories(lua-native-test PRIVATE
        ${LUA_INCLUDE_DIR}
        src
        vendor/googletest/googletest/include
        vendor/googletest/googletest
    )
    
    # Link libraries for test
    target_link_libraries(lua-native-test PRIVATE lua_native_core)
    
    # Add standard CRT libraries for test (Windows MSVC only)
    if(WIN32 AND MSVC)
        if(CMAKE_BUILD_TYPE STREQUAL "Debug")
            target_link_libraries(lua-native-test PRIVATE libcpmtd.lib libcmtd.lib)
        else()
            target_link_libraries(lua-native-test PRIVATE libcpmt.lib libcmt.lib)
        endif()
    endif()
    
    # No Node-API in core tests
    
    # Platform-specific definitions for test
    if(WIN32)
        target_compile_definitions(lua-native-test PRIVATE
            WIN32_LEAN_AND_MEAN
            NOMINMAX
        )
    elseif(APPLE)
        target_compile_definitions(lua-native-test PRIVATE
            _DARWIN_C_SOURCE
        )
    endif()
    
    # Set test output directory
    set_target_properties(lua-native-test PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${OUTPUT_DIR}"
    )
    
    # Enable CTest integration
    add_test(NAME lua-native-test COMMAND lua-native-test)
    
    message(STATUS "Google Test setup complete - test executable: lua-native-test (Debug mode only)")
else()
    message(STATUS "Tests disabled - only built in Debug mode (current build type: ${CMAKE_BUILD_TYPE})")
endif()