# FrontRunPro API Endpoint Finder for Windows
# Usage: .\find_api_endpoints.ps1 "C:\Path\To\Extension\Folder"

param(
    [string]$ExtensionPath
)

if (-not $ExtensionPath) {
    Write-Host "Usage: .\find_api_endpoints.ps1 'C:\Path\To\Extension'"
    Write-Host ""
    Write-Host "Extension path is usually at:"
    Write-Host "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Extensions\[EXTENSION_ID]"
    exit 1
}

Write-Host "🔍 Searching for API endpoints in FrontRunPro extension..." -ForegroundColor Cyan
Write-Host ""

# Search for HTTPS URLs
Write-Host "🔍 Looking for API URLs..." -ForegroundColor Yellow
Get-ChildItem -Path $ExtensionPath -Recurse -Include *.js |
    Select-String -Pattern 'https://.*api|api\.[a-z]|backend\.' |
    Select-Object -First 20

Write-Host ""
Write-Host "🔍 Looking for fetch/axios calls..." -ForegroundColor Yellow
Get-ChildItem -Path $ExtensionPath -Recurse -Include *.js |
    Select-String -Pattern 'fetch\(|axios\.|\.get\(|\.post\(' |
    Select-Object -First 20

Write-Host ""
Write-Host "🔍 Looking for API key patterns..." -ForegroundColor Yellow
Get-ChildItem -Path $ExtensionPath -Recurse -Include *.js |
    Select-String -Pattern 'api[_-]?key|authorization|bearer' -CaseSensitive:$false |
    Select-Object -First 20
