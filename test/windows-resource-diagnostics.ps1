# Read-only snapshot. Do not print environment variables, command lines, or remote addresses.
# The caller enforces a ten-second deadline and retains partial output if collection times out.
$ErrorActionPreference = 'Stop'
Write-Output "Captured at $([DateTime]::UtcNow.ToString('o'))"

try {
  Write-Output 'Memory (KiB):'
  Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 3 |
    Select-Object TotalVisibleMemorySize, FreePhysicalMemory, TotalVirtualMemorySize, FreeVirtualMemory |
    Format-List | Out-String | Write-Output
} catch {
  Write-Output "Memory snapshot unavailable: $_"
}

try {
  Write-Output 'Top processes by working set (bytes):'
  Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 |
    Select-Object Id, ProcessName, Handles, WorkingSet64, PrivateMemorySize64 |
    Format-Table -AutoSize | Out-String -Width 200 | Write-Output
} catch {
  Write-Output "Process snapshot unavailable: $_"
}

try {
  # Reports configuration only; never change the runner's TCP settings.
  Write-Output 'Dynamic TCP port ranges:'
  netsh int ipv4 show dynamicport tcp
  netsh int ipv6 show dynamicport tcp
} catch {
  Write-Output "Port range snapshot unavailable: $_"
}

try {
  $connections = @(Get-NetTCPConnection)
  Write-Output "TCP connections: $($connections.Count)"
  $connections | Group-Object State | Sort-Object Count -Descending |
    Select-Object Count, Name | Format-Table -AutoSize | Out-String | Write-Output
  Write-Output 'Top TCP owners (PID, state):'
  $connections | Group-Object OwningProcess, State | Sort-Object Count -Descending |
    Select-Object -First 15 Count, Name |
    Format-Table -AutoSize | Out-String | Write-Output
} catch {
  Write-Output "TCP snapshot unavailable: $_"
}
