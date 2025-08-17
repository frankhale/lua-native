cmake_minimum_required(VERSION 3.31)

project(lua-native)

set(CMAKE_CXX_STANDARD 17)

# Output info about build type and platform
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Platform: ${CMAKE_SYSTEM_NAME}")
message(STATUS "Architecture: ${CMAKE_SYSTEM_PROCESSOR}")
message(STATUS "Compiler: ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")

# Use VCPKG_ROOT environment variable if set
if(DEFINED ENV{VCPKG_ROOT})
    set(CMAKE_TOOLCHAIN_FILE "$ENV{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake" CACHE STRING "Vcpkg toolchain file")
endif()

# Set vcpkg triplet based on OS and architecture
if(WIN32)
    set(VCPKG_TARGET_TRIPLET "x64-windows-static" CACHE STRING "Vcpkg target triplet")
elseif(APPLE)
    # Check for Apple Silicon vs Intel
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
        set(VCPKG_TARGET_TRIPLET "arm64-osx" CACHE STRING "Vcpkg target triplet")
    else()
        set(VCPKG_TARGET_TRIPLET "x64-osx" CACHE STRING "Vcpkg target triplet")
    endif()
else()
    message(WARNING "Unsupported platform - using default x64 triplet")
    set(VCPKG_TARGET_TRIPLET "x64-unknown" CACHE STRING "Vcpkg target triplet")
endif()

# Set platform-specific compiler and linker flags
if(WIN32 AND MSVC)
    # Windows with MSVC - static runtime
    set(PLATFORM_COMPILER_FLAGS "/MT$<$<CONFIG:Debug>:d>")
    set(PLATFORM_LINKER_FLAGS "/NODEFAULTLIB:MSVCRT;/NODEFAULTLIB:MSVCRTD;/INCREMENTAL:NO")
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

# Find Node.js headers and libraries automatically
# Try to find Node.js using node-gyp cache first, then system installation
find_path(NODE_INCLUDE_DIR node.h
    PATHS
        # Windows node-gyp cache paths
        "$ENV{APPDATA}/node-gyp/Cache/*/include/node"
        "$ENV{LOCALAPPDATA}/node-gyp/Cache/*/include/node"
        # macOS node-gyp cache paths
        "$ENV{HOME}/.node-gyp/*/include/node"
        "$ENV{HOME}/Library/Caches/node-gyp/*/include/node"
        # System installation paths
        "/usr/include/node"
        "/usr/local/include/node"
        "/opt/homebrew/include/node"  # macOS Homebrew ARM
        "/usr/local/opt/node/include/node"  # macOS Homebrew Intel
        "C:/Program Files/nodejs/include/node"
        "C:/Program Files (x86)/nodejs/include/node"
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

# Try to find Node.js version and architecture dynamically
function(find_node_library_dynamic)
    # On macOS, we need to find the actual Node.js library
    if(APPLE)
        message(STATUS "macOS detected - searching for Node.js library")
        
        # Try to find Node.js library in common macOS locations
        find_library(NODE_LIBRARY
            NAMES node libnode
            PATHS
                "/opt/homebrew/opt/node@22/lib"
                "/opt/homebrew/lib"
                "/usr/local/lib"
                "/usr/lib"
                "/System/Library/Frameworks"
                "/Library/Frameworks"
                "/System/Library/Frameworks/NodeJS.framework"
                "/Library/Frameworks/NodeJS.framework"
            NO_DEFAULT_PATH
        )
        
        # If not found with specific paths, try without restrictions
        if(NOT NODE_LIBRARY)
            find_library(NODE_LIBRARY NAMES node libnode)
        endif()
        
        if(NODE_LIBRARY)
            message(STATUS "Found Node.js library on macOS: ${NODE_LIBRARY}")
            # Verify it's actually a library file, not an executable
            if(EXISTS "${NODE_LIBRARY}")
                get_filename_component(NODE_LIBRARY_EXT "${NODE_LIBRARY}" EXT)
                if(NODE_LIBRARY_EXT STREQUAL "" OR NODE_LIBRARY_EXT STREQUAL ".exe")
                    message(STATUS "Found file is not a library, clearing NODE_LIBRARY")
                    unset(NODE_LIBRARY CACHE)
                else()
                    return()
                endif()
            endif()
        endif()
        
        # Try to find Node.js library in node-gyp cache
        file(GLOB NODE_GYP_CACHE_DIRS "$ENV{HOME}/Library/Caches/node-gyp/*")
        if(NODE_GYP_CACHE_DIRS)
            list(GET NODE_GYP_CACHE_DIRS 0 LATEST_NODE_CACHE)
            message(STATUS "Searching in node-gyp cache: ${LATEST_NODE_CACHE}")
            
            # Look for any library files in the cache
            file(GLOB_RECURSE NODE_LIB_FILES "${LATEST_NODE_CACHE}/*.a" "${LATEST_NODE_CACHE}/*.dylib")
            if(NODE_LIB_FILES)
                list(GET NODE_LIB_FILES 0 FIRST_LIB)
                message(STATUS "Found potential Node.js library in cache: ${FIRST_LIB}")
                set(NODE_LIBRARY "${FIRST_LIB}" CACHE STRING "Node.js library from cache")
                return()
            endif()
        endif()
        
        # On macOS, we need to find the actual Node.js library, not the executable
        # The executable cannot be linked against directly
        message(STATUS "macOS detected - Node.js library must be found separately")
        message(STATUS "Node.js executable cannot be used as a library for linking")
        
        # If we still haven't found anything, try a broader search
        message(STATUS "Performing final broad search for Node.js library")
        find_library(NODE_LIBRARY NAMES node libnode)
        if(NODE_LIBRARY)
            message(STATUS "Found Node.js library in broad search: ${NODE_LIBRARY}")
            return()
        endif()
    endif()
    
    # Try to get Node.js version from node-gyp cache
    file(GLOB NODE_GYP_CACHE_DIRS "$ENV{HOME}/Library/Caches/node-gyp/*")
    if(NODE_GYP_CACHE_DIRS)
        list(GET NODE_GYP_CACHE_DIRS 0 LATEST_NODE_CACHE)
        message(STATUS "Found node-gyp cache: ${LATEST_NODE_CACHE}")
        
        # Try different architecture subdirectories
        set(ARCH_DIRS "arm64" "x64" "x86_64")
        foreach(ARCH ${ARCH_DIRS})
            set(TEST_PATH "${LATEST_NODE_CACHE}/${ARCH}")
            if(EXISTS "${TEST_PATH}")
                message(STATUS "Found Node.js architecture directory: ${TEST_PATH}")
                find_library(NODE_LIBRARY
                    NAMES node libnode
                    PATHS "${TEST_PATH}"
                    NO_DEFAULT_PATH
                )
                if(NODE_LIBRARY)
                    message(STATUS "Found Node.js library: ${NODE_LIBRARY}")
                    return()
                endif()
            endif()
        endforeach()
    endif()
endfunction()

# Clear any previous NODE_LIBRARY value to ensure fresh detection
unset(NODE_LIBRARY CACHE)

# Try dynamic detection first
find_node_library_dynamic()

# If dynamic detection failed, fall back to traditional find_library
if(NOT NODE_LIBRARY)
    message(STATUS "Dynamic detection failed, trying traditional find_library")
    # Find Node.js library with improved node-gyp cache paths
find_library(NODE_LIBRARY
    NAMES node libnode
    PATHS
        # Windows node-gyp cache paths - improved with more specific paths
        "$ENV{USERPROFILE}/AppData/Local/node-gyp/Cache/*/x64"
        "$ENV{APPDATA}/Local/node-gyp/Cache/*/x64"
        "$ENV{APPDATA}/node-gyp/Cache/*/x64"
        "$ENV{APPDATA}/node-gyp/Cache/*/$(Configuration)"
        "$ENV{APPDATA}/node-gyp/Cache/*/Release"
        "$ENV{APPDATA}/node-gyp/Cache/*/Debug"
        "$ENV{LOCALAPPDATA}/node-gyp/Cache/*/x64"
        "$ENV{LOCALAPPDATA}/node-gyp/Cache/*/$(Configuration)"
        "$ENV{LOCALAPPDATA}/node-gyp/Cache/*/Release"
        "$ENV{LOCALAPPDATA}/node-gyp/Cache/*/Debug"
        # macOS node-gyp cache paths - improved structure
        "$ENV{HOME}/.node-gyp/*/$(Configuration)"
        "$ENV{HOME}/.node-gyp/*/out/Release"
        "$ENV{HOME}/.node-gyp/*/out/Debug"
        "$ENV{HOME}/Library/Caches/node-gyp/*/$(Configuration)"
        "$ENV{HOME}/Library/Caches/node-gyp/*/out/Release"
        "$ENV{HOME}/Library/Caches/node-gyp/*/out/Debug"
        # macOS node-gyp cache paths - direct architecture subdirectories
        "$ENV{HOME}/Library/Caches/node-gyp/*/arm64"
        "$ENV{HOME}/Library/Caches/node-gyp/*/x64"
        "$ENV{HOME}/Library/Caches/node-gyp/*/x86_64"
        # System installation paths
        "/usr/lib"
        "/usr/local/lib"
        "/opt/homebrew/lib/node_modules"  # macOS Homebrew ARM
        "/usr/local/opt/node/lib"  # macOS Homebrew Intel
        "C:/Program Files/nodejs"
        "C:/Program Files (x86)/nodejs"
    NO_DEFAULT_PATH
)

# If not found, try with default paths
if(NOT NODE_LIBRARY)
    find_library(NODE_LIBRARY NAMES node libnode)
endif()
endif()

message(STATUS "NODE_LIBRARY: ${NODE_LIBRARY}")

# Debug output for macOS
if(APPLE AND NOT NODE_LIBRARY)
    message(STATUS "macOS detected but NODE_LIBRARY not found")
    message(STATUS "Checking if Node.js executable exists...")
    find_program(DEBUG_NODE_EXECUTABLE NAMES node)
    if(DEBUG_NODE_EXECUTABLE)
        message(STATUS "Node.js executable found at: ${DEBUG_NODE_EXECUTABLE}")
    else()
        message(STATUS "Node.js executable not found")
    endif()
endif()

# Core static library (pure C++)
add_library(lua_native_core STATIC
        src/core/lua-runtime.h
        src/core/lua-runtime.cpp
)

target_include_directories(lua_native_core PUBLIC ${LUA_INCLUDE_DIR} src)
target_link_libraries(lua_native_core PUBLIC ${LUA_LIBRARIES})

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

# Link libraries - handle different Node.js linking strategies
if(NODE_LIBRARY)
    if(NODE_LIBRARY STREQUAL "NODE_RUNTIME_LINK")
        message(STATUS "Linking against Node.js executable: ${NODE_EXECUTABLE}")
        # On macOS, we link against the Node.js executable directly
        target_link_libraries(lua-native PRIVATE lua_native_core ${NODE_EXECUTABLE})
        # Set runtime path to the Node.js executable
        set_target_properties(lua-native PROPERTIES
            BUILD_WITH_INSTALL_RPATH TRUE
            INSTALL_RPATH "${NODE_EXECUTABLE}"
        )
    else()
        message(STATUS "Linking against Node.js library: ${NODE_LIBRARY}")
        target_link_libraries(lua-native PRIVATE ${NODE_LIBRARY} lua_native_core)
    endif()
else()
    if(APPLE)
        # On macOS with Homebrew, Node.js doesn't provide a separate library file
        # We need to use a different approach - link against the Node.js executable
        # or use runtime symbol resolution
        message(STATUS "macOS detected - using runtime symbol resolution for Node.js")
        
        # Try to find the Node.js executable for runtime linking
        find_program(NODE_EXECUTABLE NAMES node
            PATHS
                "/opt/homebrew/bin"
                "/usr/local/bin"
                "/usr/bin"
        )
        
        if(NODE_EXECUTABLE)
            message(STATUS "Found Node.js executable: ${NODE_EXECUTABLE}")
            # On macOS, we link against the core library and use runtime symbol resolution
            target_link_libraries(lua-native PRIVATE lua_native_core)
            # Add runtime symbol resolution flags
            target_link_options(lua-native PRIVATE 
                "-Wl,-undefined,dynamic_lookup"
            )
            # Set runtime path to the Node.js executable
            set_target_properties(lua-native PROPERTIES
                BUILD_WITH_INSTALL_RPATH TRUE
                INSTALL_RPATH "${NODE_EXECUTABLE}"
            )
        else()
            message(FATAL_ERROR "Node.js executable not found on macOS")
        endif()
    else()
        message(FATAL_ERROR "Node.js library not found. Cannot build native addon without Node.js library.")
    endif()
endif()

# Add standard CRT libraries (Windows MSVC only)
if(WIN32 AND MSVC)
    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
        target_link_libraries(lua-native PRIVATE libcpmtd.lib libcmtd.lib)
    else()
        target_link_libraries(lua-native PRIVATE libcpmt.lib libcmt.lib)
    endif()
endif()

# Define NAPI_DISABLE_CPP_EXCEPTIONS to match node-addon-api requirements
target_compile_definitions(lua-native PRIVATE
        NAPI_DISABLE_CPP_EXCEPTIONS
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