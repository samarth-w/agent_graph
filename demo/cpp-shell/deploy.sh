#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# deploy.sh — Build, test, and deploy the task_queue project.
#
# Edge cases tested:
#   - function keyword form
#   - paren form
#   - function with hyphens in name
#   - source/dot imports
#   - aliases
#   - heredoc (should not confuse parser)
#   - subshell $(...)
#   - pipe chains
#   - multiline commands with backslash
#   - empty function body
#   - nested function calls
#   - trap handler
#   - case statement (keywords not treated as calls)
#   - arrays
#   - comments between functions
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── Source configuration ──────────────────────────────────────
source ./config.sh
. /etc/profile.d/colors.sh

# ── Constants ─────────────────────────────────────────────────
BUILD_DIR="./build"
LOG_FILE="/tmp/deploy.log"
VERSION="1.0.0"
TARGETS=("debug" "release" "test")

# ── Aliases ───────────────────────────────────────────────────
alias cmake-build="cmake --build"
alias run-tests="ctest --output-on-failure"
alias deploy-prod="rsync -avz"

# ── Functions (keyword form) ──────────────────────────────────

# Log a message with timestamp
function log-message {
    local level="$1"
    local msg="$2"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $msg" | tee -a "$LOG_FILE"
}

# Empty function body edge case
function noop {
    :
}

# Function with complex body
function check-prerequisites {
    log-message "INFO" "Checking prerequisites..."

    # Nested command substitution edge case
    local gcc_ver=$(gcc --version | head -1)
    local cmake_ver=$(cmake --version | head -1)

    if ! command -v g++ &>/dev/null; then
        log-message "ERROR" "g++ not found"
        return 1
    fi

    if ! command -v cmake &>/dev/null; then
        log-message "ERROR" "cmake not found"
        return 1
    fi

    log-message "INFO" "GCC: $gcc_ver"
    log-message "INFO" "CMake: $cmake_ver"
    return 0
}

# ── Functions (paren form) ────────────────────────────────────

# Configure the build
configure-build() {
    local build_type="${1:-Release}"
    log-message "INFO" "Configuring $build_type build..."

    mkdir -p "$BUILD_DIR"
    cmake -S . -B "$BUILD_DIR" \
        -DCMAKE_BUILD_TYPE="$build_type" \
        -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
}

# Compile the project
compile() {
    local jobs
    jobs=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

    log-message "INFO" "Compiling with $jobs jobs..."
    cmake --build "$BUILD_DIR" -j "$jobs"

    if [ $? -eq 0 ]; then
        log-message "INFO" "Build succeeded"
    else
        log-message "ERROR" "Build failed"
        return 1
    fi
}

# Run the test suite
run-test-suite() {
    log-message "INFO" "Running tests..."

    cd "$BUILD_DIR"
    ctest --output-on-failure -j4
    local result=$?
    cd -

    if [ $result -eq 0 ]; then
        log-message "INFO" "All tests passed"
    else
        log-message "ERROR" "$result tests failed"
        return 1
    fi
}

# Edge case: heredoc inside function (should not break parser)
generate-report() {
    cat <<EOF
============================
  Build Report
  Version: $VERSION
  Date:    $(date)
  Status:  $1
============================
EOF
}

# Edge case: function that calls many others in pipe chain
analyze-output() {
    cat "$LOG_FILE" \
        | grep -E "ERROR|WARN" \
        | sort \
        | uniq -c \
        | sort -rn \
        | head -20
}

# Edge case: case statement (keywords should not be extracted as calls)
parse-args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --debug)
                BUILD_TYPE="Debug"
                shift
                ;;
            --release)
                BUILD_TYPE="Release"
                shift
                ;;
            --clean)
                clean-build
                shift
                ;;
            --help|-h)
                show-help
                exit 0
                ;;
            *)
                log-message "WARN" "Unknown arg: $1"
                shift
                ;;
        esac
    done
}

show-help() {
    echo "Usage: $0 [--debug|--release|--clean|--help]"
    echo ""
    echo "Options:"
    echo "  --debug    Build in debug mode"
    echo "  --release  Build in release mode (default)"
    echo "  --clean    Clean build directory first"
    echo "  --help     Show this help"
}

clean-build() {
    log-message "INFO" "Cleaning build directory..."
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
}

# Deploy to server
deploy-to-server() {
    local target="${1:-staging}"
    local binary="$BUILD_DIR/task_queue"

    if [ ! -f "$binary" ]; then
        log-message "ERROR" "Binary not found: $binary"
        return 1
    fi

    log-message "INFO" "Deploying to $target..."

    case "$target" in
        staging)
            rsync -avz "$binary" staging.example.com:/opt/app/
            ;;
        production)
            rsync -avz "$binary" prod.example.com:/opt/app/
            ssh prod.example.com "systemctl restart task-queue"
            ;;
    esac

    generate-report "deployed-$target"
}

# Edge case: trap handler (function reference in trap)
cleanup-on-exit() {
    log-message "INFO" "Cleaning up temp files..."
    rm -f /tmp/deploy_*.tmp
}
trap cleanup-on-exit EXIT

# ── Main flow ─────────────────────────────────────────────────
function main {
    BUILD_TYPE="Release"
    parse-args "$@"

    log-message "INFO" "Starting deployment pipeline v$VERSION"

    check-prerequisites || exit 1
    configure-build "$BUILD_TYPE"
    compile || exit 1
    run-test-suite || exit 1
    deploy-to-server "staging"
    analyze-output
    generate-report "success"

    log-message "INFO" "Pipeline complete!"
}

# Only run main if not being sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
