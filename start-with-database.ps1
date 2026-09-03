[CmdletBinding()]
param(
  [string]$ApiConfigPath
)

$ErrorActionPreference = "Stop"
$scriptRootPath = Split-Path -Parent $PSCommandPath
if ([string]::IsNullOrWhiteSpace($ApiConfigPath)) {
  $configRoot = Split-Path $scriptRootPath -Parent
  $ApiConfigPath = Get-ChildItem -LiteralPath $configRoot -File -Filter "*-apiKey-6016377.csv" |
    Select-Object -First 1 -ExpandProperty FullName
}

if ([string]::IsNullOrWhiteSpace($ApiConfigPath) -or -not (Test-Path -LiteralPath $ApiConfigPath)) {
  throw "API configuration file was not found: $ApiConfigPath"
}

$rows = Import-Csv -LiteralPath $ApiConfigPath
$config = @{}
foreach ($row in $rows) {
  $valueColumn = $row.PSObject.Properties |
    Where-Object Name -ne "id" |
    Select-Object -First 1
  $config[[string]$row.id] = [string]$valueColumn.Value
}

foreach ($required in @("apiKey", "openAiCompatible")) {
  if ([string]::IsNullOrWhiteSpace($config[$required])) {
    throw "API configuration is missing field: $required"
  }
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop is not running. Start Docker Desktop, wait until it is ready, then run this script again."
}

$env:MODEL_PROVIDER = "aliyun-bailian"
$env:MODEL_API_KEY = $config.apiKey
$env:MODEL_BASE_URL = $config.openAiCompatible
$env:MODEL_DIALOGUE_NAME = "qwen-flash-character"
$env:MODEL_BACKGROUND_NAME = "qwen3.8-flash"
$env:MODEL_EMBEDDING_NAME = "qwen3.7-text-embedding"
$env:DATABASE_URL = "postgres://zhiwei:zhiwei@127.0.0.1:54329/zhiwei"
$env:MEMORY_MCP_URL = "http://127.0.0.1:4100/mcp"
$env:SCIENCE_MCP_URL = "http://127.0.0.1:4200/mcp"
$env:ANON_COOKIE_SECRET = "local-development-cookie-secret-change-before-deploy"
$env:INTERNAL_MCP_TOKEN = "local-development-mcp-token"
$env:NEXT_PUBLIC_ACTIVITY_STREAM = "true"
$env:DEV_MODE = "true"
Remove-Item Env:NO_DB_MODE -ErrorAction SilentlyContinue

$runtimePath = Join-Path (Split-Path $scriptRootPath -Parent) ".zhiwei-runtime"
New-Item -ItemType Directory -Force -Path $runtimePath > $null
$pidPath = Join-Path $runtimePath "processes.json"
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source

if (Test-Path -LiteralPath $pidPath) {
  Get-Content -LiteralPath $pidPath |
    ConvertFrom-Json |
    ForEach-Object {
      $processId = [int]$_.pid
      try {
        taskkill.exe /PID $processId /T /F *> $null
      } catch {
        # A stale PID is already stopped and needs no further cleanup.
      }
    }
}

function Start-ZhiweiProcess {
  param(
    [string]$Name,
    [string[]]$Arguments
  )

  $stdoutPath = Join-Path $runtimePath "$Name.out.log"
  $stderrPath = Join-Path $runtimePath "$Name.err.log"
  return Start-Process `
    -FilePath $npmCommand `
    -ArgumentList $Arguments `
    -WorkingDirectory $scriptRootPath `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru
}

function Wait-ZhiweiHealth {
  param(
    [string]$Name,
    [string]$Url
  )

  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "$Name did not become healthy. Check logs in $runtimePath."
}

Push-Location $scriptRootPath
try {
  docker compose up -d postgres
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose failed to start PostgreSQL."
  }

  npm run db:migrate
  if ($LASTEXITCODE -ne 0) {
    throw "Database migration failed."
  }

  $processes = @(
    [pscustomobject]@{ name = "memory-mcp"; process = Start-ZhiweiProcess "memory-mcp" @("run", "start", "--workspace", "@zhiwei/memory-mcp") }
    [pscustomobject]@{ name = "science-mcp"; process = Start-ZhiweiProcess "science-mcp" @("run", "start", "--workspace", "@zhiwei/science-mcp") }
  )
  Wait-ZhiweiHealth "Memory MCP" "http://127.0.0.1:4100/health"
  Wait-ZhiweiHealth "Science MCP" "http://127.0.0.1:4200/health"

  $processes += [pscustomobject]@{ name = "worker"; process = Start-ZhiweiProcess "worker" @("run", "start", "--workspace", "@zhiwei/worker") }
  $processes += [pscustomobject]@{ name = "web"; process = Start-ZhiweiProcess "web" @("run", "dev", "--workspace", "@zhiwei/web") }

  $processes |
    ForEach-Object { [pscustomobject]@{ name = $_.name; pid = $_.process.Id } } |
    ConvertTo-Json |
    Set-Content -LiteralPath $pidPath

  Wait-ZhiweiHealth "Zhiwei Web" "http://127.0.0.1:3000/api/health"

  docker compose ps postgres
  Write-Host ""
  Write-Host "Zhiwei database mode is available at http://localhost:3000"
  Write-Host "Runtime logs: $runtimePath"
} finally {
  Pop-Location
}
