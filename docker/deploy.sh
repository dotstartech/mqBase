#!/bin/bash
# Deploy mqtt-sql-admin to Docker Swarm
# Reads version from msa.properties and deploys with that tag

set -e

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

export MSA_VERSION="$VERSION"

echo "Deploying mqtt-sql-admin version $MSA_VERSION..."

cd "$PROJECT_DIR"
docker stack deploy -c compose.yml msa

echo ""
echo "Deployed mqtt-sql-admin:$MSA_VERSION"
