param(
  [int]$Port = 3000,
  [int]$TimeoutSec = 120
)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $Port)
    $c.Close()
    exit 0
  }
  catch { }
  Start-Sleep -Milliseconds 400
}
exit 1
