$ErrorActionPreference = "Stop"

$apiConfigPath = "D:\A\默认业务空间-apiKey-6016377.csv"
$rows = Import-Csv -LiteralPath $apiConfigPath
$config = @{}
foreach ($row in $rows) {
  $config[[string]$row.id] = [string]$row.'6016377'
}

foreach ($required in @("apiKey", "openAiCompatible")) {
  if ([string]::IsNullOrWhiteSpace($config[$required])) {
    throw "API configuration is missing field: $required"
  }
}

$env:MODEL_PROVIDER = "aliyun-bailian"
$env:MODEL_API_KEY = $config.apiKey
$env:MODEL_BASE_URL = $config.openAiCompatible
$env:MODEL_DIALOGUE_NAME = "qwen-flash-character"
$env:MODEL_BACKGROUND_NAME = "qwen3.8-flash"
$env:MODEL_EMBEDDING_NAME = "qwen3.7-text-embedding"
$env:NO_DB_MODE = "true"
$env:NEXT_PUBLIC_ACTIVITY_STREAM = "false"
$env:DEV_MODE = "true"

npm run dev
