param(
    [ValidateSet('dry-run','live')][string]$Mode = 'dry-run',
    [int]$MaxRuns = 1,
    [string[]]$Formats = @('PNG','JPG','WEBP','PDF'),
    [int[]]$Sizes = @(2000,3000,4000,5000,6000,7000,8000,9000),
    [switch]$ApproveLiveBatch,
    [int]$DelaySeconds = 2
)
$ErrorActionPreference = 'Stop'
if ($MaxRuns -lt 1 -or $MaxRuns -gt 32) { throw 'MaxRuns must be between 1 and 32.' }
if ($DelaySeconds -lt 0 -or $DelaySeconds -gt 300) { throw 'DelaySeconds must be 0..300.' }
if ($Mode -eq 'live' -and $MaxRuns -gt 1 -and -not $ApproveLiveBatch) {
    throw 'Multiple real submissions require -ApproveLiveBatch.'
}
if ($env:GXS_BASE_URL -and $env:GXS_BASE_URL -ne 'https://dev.beta.graphxserver.io') { throw 'DEV ONLY' }
$Formats = @($Formats | ForEach-Object { $_.ToUpperInvariant() })
foreach ($fmt in $Formats) { if ($fmt -notin @('PNG','JPG','JPEG','WEBP','PDF')) {throw "Unsupported format: $fmt"} }
foreach ($size in $Sizes) { if ($size -lt 2000 -or $size -gt 9000) { throw "Unsupported test size: $size" } }
$env:GXS_BASE_URL='https://dev.beta.graphxserver.io'
$old = @{}
$names=@('GXS_EXECUTION_MODE','ALLOW_SUBMIT','APPROVE_SUBMISSIONS','SELECTORS_VERIFIED','GXS_MAX_ORDERS','GXS_TEST_FORMAT','GXS_TEST_SIZE')
foreach ($name in $names) { $old[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$report = Join-Path (Get-Location) 'reports/minimal-results.csv'
$results = @()
try {
    $count=0
    :formatsLoop foreach ($fmt in $Formats) {
        foreach ($size in $Sizes) {
            if ($count -ge $MaxRuns) { break formatsLoop }
            $count++
            # Record the existing attempt IDs so we never misinterpret an earlier result.
            $before = @{}
            if (Test-Path $report) {
                foreach ($r in @(Import-Csv $report)) { $before[$r.testId] = $true }
            }
            $env:GXS_EXECUTION_MODE=$Mode
            $env:GXS_TEST_FORMAT=$fmt
            $env:GXS_TEST_SIZE="$size"
            $env:GXS_MAX_ORDERS='1'
            $env:ALLOW_SUBMIT=if ($Mode -eq 'live') {'true'} else {'false'}
            $env:APPROVE_SUBMISSIONS=if ($Mode -eq 'live') {'true'} else {'false'}
            $env:SELECTORS_VERIFIED=if ($Mode -eq 'live') {'true'} else {'false'}
            Write-Host "[$count/$MaxRuns] $fmt ${size}x${size} ($Mode)"
            pnpm exec playwright test tests/mockup-minimal.spec.ts --headed --workers=1 --retries=0
            $exitCode = $LASTEXITCODE
            $newRows = @()
            if (Test-Path $report) {
                $newRows = @(Import-Csv $report | Where-Object { -not $before.ContainsKey($_.testId) })
            }
            if ($newRows.Count -ne 1) { throw "UNSAFE_RESULT: expected one new CSV row for $fmt ${size}; found $($newRows.Count). STOP without retry." }
            $r = $newRows[0]
            if ($r.format -ne $fmt -or [int]$r.width -ne $size -or [int]$r.height -ne $size) {
                throw 'UNSAFE_RESULT: configuration mismatch in CSV. STOP without retry.'
            }
            if ($exitCode -ne 0) { throw "AUTOMATION_FAILURE: runner exit $exitCode for $fmt ${size}. STOP without retry; Order ID: $($r.orderId)" }
            $verdict = ''
            if ($Mode -eq 'dry-run') {
                if ($r.generationStatus -ne 'Not Submitted' -or $r.orderId) { throw 'UNSAFE_DRY_RUN: unexpected submission data' }
                $verdict = 'DRY_RUN'
            } else {
                $http = @($r.httpStatuses -split ';' | Where-Object { $_ -match '^\d+$' })
                if (-not $r.orderId -or $http.Count -eq 0 -or @($http | Where-Object { [int]$_ -lt 200 -or [int]$_ -ge 300 }).Count -gt 0) {
                    throw "UNSAFE_SUBMISSION: missing ID or accepted HTTP status for $fmt ${size}. STOP without retry."
                }
                if ($r.generationStatus -eq 'Failed' -and $r.phase -eq 'Generation failed (confirmed)' -and $r.error -like 'GENERATION_FAILED:*') {
                    $verdict = 'QA_FAIL_GENERATION'
                } elseif ($r.generationStatus -eq 'Completed' -and $r.phase -eq 'Output validation failed' -and $r.error -like 'OUTPUT_VALIDATION_FAILED:*') {
                    $verdict = 'QA_FAIL_OUTPUT'
                } elseif ($r.generationStatus -eq 'Completed' -and $r.phase -eq 'Output verified' -and $r.outputPath -and (Test-Path $r.outputPath) -and -not $r.error) {
                    $verdict = 'QA_PASS'
                } else {
                    throw "UNSAFE_RESULT: nonterminal or unrecognized outcome $($r.generationStatus)/$($r.phase). STOP without retry."
                }
            }
            $results += [pscustomobject]@{ Format=$fmt; Size=$size; OrderId=$r.orderId; GenerationStatus=$r.generationStatus; QAVerdict=$verdict; Error=$r.error }
            Write-Host "[$count/$MaxRuns] $verdict | Order: $($r.orderId) | $fmt ${size}x${size}"
            if ($count -lt $MaxRuns -and $DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
        }
    }
    if ($results.Count -gt 0) {
        New-Item -ItemType Directory -Path (Split-Path $report) -Force | Out-Null
        $results | Export-Csv (Join-Path (Split-Path $report) 'matrix-last-run.csv') -NoTypeInformation -Encoding UTF8
    }
    Write-Host "Matrix finished: $($results.Count) recognized outcomes. See reports/matrix-last-run.csv"
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$old[$name],'Process') }
}
