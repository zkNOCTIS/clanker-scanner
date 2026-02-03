#!/bin/bash
# FrontRunPro API Endpoint Finder
# Usage: ./find_api_endpoints.sh /path/to/extension/folder

if [ -z "$1" ]; then
  echo "Usage: $0 /path/to/frontrunpro/extension"
  exit 1
fi

echo "🔍 Searching for API endpoints in FrontRunPro extension..."
echo ""

# Search for common API patterns
grep -r "https://" "$1" --include="*.js" | grep -E "(api\.|backend\.|fetch|axios)" | head -20

echo ""
echo "🔍 Searching for 'api' keyword..."
grep -r "api" "$1" --include="*.js" | grep -E "(const|let|var).*api.*=" | head -20

echo ""
echo "🔍 Searching for fetch/axios calls..."
grep -r "fetch\|axios" "$1" --include="*.js" | grep -v "node_modules" | head -20
