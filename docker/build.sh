#!/bin/bash
# Build Docker image for mqbase
# Tags the image with both the version from mqbase.properties and 'latest'
# Usage: ./build.sh [--no-cache] [--release] [--distroless]
#   --no-cache    Build without using Docker cache
#   --release     Minify app.js for production build
#   --distroless  Build using distroless base image (tagged as X.X.X-distroless)

set -e

# Registry configuration
DOCKERHUB_REPO="dotstartech/mqbase"
GHCR_REPO="ghcr.io/dotstartech/mqbase"

# Parse arguments
NO_CACHE=""
RELEASE=""
DISTROLESS=""
for arg in "$@"; do
    case $arg in
        --no-cache)
            NO_CACHE="--no-cache"
            ;;
        --release)
            RELEASE="1"
            ;;
        --distroless)
            DISTROLESS="1"
            ;;
    esac
done

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Read version from mqbase.properties
PROPERTIES_FILE="$PROJECT_DIR/mqbase.properties"
if [[ ! -f "$PROPERTIES_FILE" ]]; then
    echo "Error: mqbase.properties not found at $PROPERTIES_FILE"
    exit 1
fi

VERSION=$(grep -E "^version=" "$PROPERTIES_FILE" | cut -d'=' -f2 | tr -d '[:space:]')
if [[ -z "$VERSION" ]]; then
    echo "Error: version not found in mqbase.properties"
    exit 1
fi

IMAGE_NAME="mqbase"

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

# Determine Dockerfile and version suffix
if [[ -n "$DISTROLESS" ]]; then
    DOCKERFILE="$PROJECT_DIR/docker/Dockerfile.distroless"
    VERSION_TAG="${VERSION}-distroless"
    LATEST_TAG="latest-distroless"
    echo "  (distroless build)"
else
    DOCKERFILE="$PROJECT_DIR/docker/Dockerfile"
    VERSION_TAG="$VERSION"
    LATEST_TAG="latest"
fi

# Build and tag with version, passing host user UID/GID
docker build $NO_CACHE \
    --build-arg UID=$(id -u) \
    --build-arg GID=$(id -g) \
    -t "$IMAGE_NAME:$VERSION_TAG" \
    -t "$IMAGE_NAME:$LATEST_TAG" \
    -t "$DOCKERHUB_REPO:$VERSION_TAG" \
    -t "$DOCKERHUB_REPO:$LATEST_TAG" \
    -t "$GHCR_REPO:$VERSION_TAG" \
    -t "$GHCR_REPO:$LATEST_TAG" \
    -f "$DOCKERFILE" \
    "$PROJECT_DIR"

# Restore original app.js if we minified it
if [[ -n "$CLEANUP_MINIFIED" ]]; then
    mv "$APP_JS_BACKUP" "$APP_JS"
fi

echo ""
echo "Successfully built:"
echo "  - $IMAGE_NAME:$VERSION_TAG"
echo "  - $IMAGE_NAME:$LATEST_TAG"
echo "  - $DOCKERHUB_REPO:$VERSION_TAG"
echo "  - $DOCKERHUB_REPO:$LATEST_TAG"
echo "  - $GHCR_REPO:$VERSION_TAG"
echo "  - $GHCR_REPO:$LATEST_TAG"
if [[ -n "$RELEASE" ]]; then
    echo "  (release build with minified app.js)"
fi
