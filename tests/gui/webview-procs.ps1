param(
  [Parameter(Mandatory = $true)][string]$Folder
)
# Lists the WebView2 processes started with a given user data folder, one process id per line.
# The folder name is unique to one launch of the test, so these processes belong to that launch.
$filter = "Name = 'msedgewebview2.exe'"
foreach ($item in Get-CimInstance Win32_Process -Filter $filter) {
  if ($null -ne $item.CommandLine -and $item.CommandLine.Contains($Folder)) {
    Write-Output $item.ProcessId
  }
}
