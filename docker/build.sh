#!/bin/bash
# Build Docker image for mqtt-sql-admin
# Tags the image with both the version from msa.properties and 'latest'
# Usage: ./build.sh [--no-cache] [--release]
#   --no-cache  Build without using Docker cache
#   --release   Minify app.js for production build

set -e

# Parse arguments
NO_CACHE=""
RELEASE=""
for arg in "$@"; do
    case $arg in
        --no-cache)
            NO_CACHE="--no-cache"
            ;;
        --release)
            RELEASE="1"
            ;;
    esac
done

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Read version from msa.properties
PROPERTIES_FILE="$PROJECT_DIR/msa.properties"
if [[ ! -f "$PROPERTIES_FILE" ]]; then
    echo "Error: msa.properties not found at $PROPERTIES_FILE"
    exit 1
fi

VERSION=$(grep -E "^version=" "$PROPERTIES_FILE" | cut -d'=' -f2 | tr -d '[:space:]')
if [[ -z "$VERSION" ]]; then
    echo "Error: version not found in msa.properties"
    exit 1
fi

IMAGE_NAME="mqtt-sql-admin"

echo "Building $IMAGE_NAME version $VERSION..."
if [[ -n "$NO_CACHE" ]]; then
    echo "  (using --no-cache)"
fi

# If release build, minify app.js
CLEANUP_MINIFIED=""
if [[ -n "$RELEASE" ]]; then
    echo "  (release build - minifying app.js)"
    
    # Check if terser is available
    if ! command -v terser &> /dev/null; then
        echo "Error: terser is not installed. Install it with: npm install -g terser"
        exit 1
    fi
    
    # Backup original and create minified version
    APP_JS="$PROJECT_DIR/admin/app.js"
    APP_JS_BACKUP="$PROJECT_DIR/admin/app.js.bak"
    
    cp "$APP_JS" "$APP_JS_BACKUP"
    terser "$APP_JS_BACKUP" --compress --mangle -o "$APP_JS"
    
    CLEANUP_MINIFIED="1"
    
    ORIGINAL_SIZE=$(wc -c < "$APP_JS_BACKUP")
    MINIFIED_SIZE=$(wc -c < "$APP_JS")
    REDUCTION=$((100 - (MINIFIED_SIZE * 100 / ORIGINAL_SIZE)))
    echo "  app.js: ${ORIGINAL_SIZE} bytes -> ${MINIFIED_SIZE} bytes (${REDUCTION}% reduction)"
fi

# Build and tag with version, passing host user UID/GID
docker build $NO_CACHE \
    --build-arg UID=$(id -u) \
    --build-arg GID=$(id -g) \
    -t "$IMAGE_NAME:$VERSION" \
    -t "$IMAGE_NAME:latest" \
    -f "$PROJECT_DIR/docker/Dockerfile" \
    "$PROJECT_DIR"

# Restore original app.js if we minified it
if [[ -n "$CLEANUP_MINIFIED" ]]; then
    mv "$APP_JS_BACKUP" "$APP_JS"
fi

echo ""
echo "Successfully built:"
echo "  - $IMAGE_NAME:$VERSION"
echo "  - $IMAGE_NAME:latest"
if [[ -n "$RELEASE" ]]; then
    echo "  (release build with minified app.js)"
fi
