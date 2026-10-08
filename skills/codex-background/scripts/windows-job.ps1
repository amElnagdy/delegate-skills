$SpecPath = $env:CODEX_BACKGROUND_OWNER_SPEC
$ErrorActionPreference = 'Stop'
# The C# helper uses only inbox kernel APIs. No external package or executable discovery.
Add-Type -LiteralPath $env:CODEX_BACKGROUND_OWNER_HELPER
$spec = Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json
$relayArgs = @([string]$spec.relayPath) + @($spec.argv | ForEach-Object { [string]$_ })
$code = [DelegateJobOwner]::Run([string]$spec.node, [string[]]$relayArgs, [string]$spec.workspace, (Join-Path $spec.runDirectory 'relay-exit.json'))
exit $code
