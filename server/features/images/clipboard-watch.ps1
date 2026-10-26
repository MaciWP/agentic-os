# The clipboard watcher on Windows. Prints one JSON line per copied image, as PNG in base64,
# and ends when the server does. Untested on a real Windows machine.
param([int]$ServerId, [long]$Max)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$server = Get-Process -Id $ServerId
$sha = [System.Security.Cryptography.SHA256]::Create()
$last = $null
$primed = $false
[Console]::Out.WriteLine('{"ready":true}')
while (-not $server.HasExited) {
  try {
    $clip = [System.Windows.Forms.Clipboard]
    if ($clip::ContainsImage() -and -not $clip::ContainsFileDropList()) {
      $image = $clip::GetImage()
      $stream = New-Object System.IO.MemoryStream
      try {
        $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
      } finally {
        $image.Dispose()
        $stream.Dispose()
      }
      $hash = [Convert]::ToBase64String($sha.ComputeHash($bytes))
      # What is on the clipboard already is not news.
      if ($primed -and $hash -ne $last) {
        if ($bytes.Length -gt $Max) { [Console]::Out.WriteLine("{""tooLarge"":$($bytes.Length)}") }
        else { [Console]::Out.WriteLine('{"image":"' + [Convert]::ToBase64String($bytes) + '"}') }
      }
      $last = $hash
    }
  } catch [System.Runtime.InteropServices.ExternalException] {
    # Another program holds the clipboard; the next round reads it.
  }
  $primed = $true
  # ponytail: re-encodes the image every second to compare it, use the clipboard sequence
  # number if large images make it costly.
  Start-Sleep -Seconds 1
}
