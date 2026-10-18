param([string]$Archive)
$ErrorActionPreference = 'Stop'
$handle = [System.IO.File]::Open($Archive, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
    [Console]::WriteLine('READY')
    [void][Console]::ReadLine()
} finally {
    $handle.Dispose()
    [Console]::WriteLine('RELEASED')
}
