#!/bin/bash
# Build Docker image for mqbase
# Tags the image with both the version from mqbase.properties and 'latest'
# Usage: ./build.sh [options]
#   --no-cache     Build without using Docker cache
#   --release      Minify app.js for production build
#   --distroless   Build using distroless base image (tagged as X.X.X-distroless)
#   --arm64        Build for ARM64 architecture (for Raspberry Pi, etc.)
#   --multi-arch   Build for both AMD64 and ARM64 (requires buildx, pushes to registry)
#   --push         Push to registry (used with --multi-arch)

set -e

# Parse arguments
NO_CACHE=""
RELEASE=""
DISTROLESS=""
ARM64=""
MULTI_ARCH=""
PUSH=""
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
        --arm64)
            ARM64="1"
            ;;
        --multi-arch)
            MULTI_ARCH="1"
            ;;
        --push)
            PUSH="1"
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

# Add ARM64 suffix if building for ARM64 only
if [[ -n "$ARM64" ]] && [[ -z "$MULTI_ARCH" ]]; then
    VERSION_TAG="${VERSION_TAG}-arm64"
    LATEST_TAG="${LATEST_TAG}-arm64"
    echo "  (ARM64 build)"
fi

# Determine platform(s)
PLATFORM=""
if [[ -n "$MULTI_ARCH" ]]; then
    PLATFORM="linux/amd64,linux/arm64"
    echo "  (multi-arch build: amd64 + arm64)"
elif [[ -n "$ARM64" ]]; then
    PLATFORM="linux/arm64"
fi

# Build and tag with version, passing host user UID/GID
if [[ -n "$MULTI_ARCH" ]]; then
    # Multi-arch build requires buildx and pushing to a registry
    if [[ -z "$PUSH" ]]; then
        echo "Error: --multi-arch requires --push (images must be pushed to registry)"
        echo "       Use: ./build.sh --multi-arch --push"
        exit 1
    fi
    
    # Ensure buildx builder exists
    if ! docker buildx inspect mqbase-builder &>/dev/null; then
        echo "Creating buildx builder 'mqbase-builder'..."
        docker buildx create --name mqbase-builder --driver docker-container --use
    else
        docker buildx use mqbase-builder
    fi
    
    docker buildx build $NO_CACHE \
        --platform "$PLATFORM" \
        --build-arg UID=$(id -u) \
        --build-arg GID=$(id -g) \
        -t "$IMAGE_NAME:$VERSION_TAG" \
        -t "$IMAGE_NAME:$LATEST_TAG" \
        -f "$DOCKERFILE" \
        --push \
        "$PROJECT_DIR"
elif [[ -n "$PLATFORM" ]]; then
    # Single architecture cross-compile (e.g., ARM64 on AMD64 host)
    docker buildx build $NO_CACHE \
        --platform "$PLATFORM" \
        --build-arg UID=$(id -u) \
        --build-arg GID=$(id -g) \
        -t "$IMAGE_NAME:$VERSION_TAG" \
        -t "$IMAGE_NAME:$LATEST_TAG" \
        -f "$DOCKERFILE" \
        --load \
        "$PROJECT_DIR"
else
    # Native build
    docker build $NO_CACHE \
        --build-arg UID=$(id -u) \
        --build-arg GID=$(id -g) \
        -t "$IMAGE_NAME:$VERSION_TAG" \
        -t "$IMAGE_NAME:$LATEST_TAG" \
        -f "$DOCKERFILE" \
        "$PROJECT_DIR"
fi

# Restore original app.js if we minified it
if [[ -n "$CLEANUP_MINIFIED" ]]; then
    mv "$APP_JS_BACKUP" "$APP_JS"
fi

echo ""
echo "Successfully built:"
echo "  - $IMAGE_NAME:$VERSION_TAG"
echo "  - $IMAGE_NAME:$LATEST_TAG"
if [[ -n "$RELEASE" ]]; then
    echo "  (release build with minified app.js)"
fi
