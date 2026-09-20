# Regenerates the fixtures vision-nag-probe.mjs streams: a dark camera frame
# and a set of spoken questions that do NOT require vision to answer.
#
# Both use Windows' own built-in components, so there is no dependency to
# install. The audio is written at 16000 Hz mono PCM16 — the phone's exact
# capture format — so the probe can chunk it without resampling.
#
#   powershell -File scripts/fixtures/make-fixtures.ps1
$dir = $PSScriptRoot

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(640, 480)
$g = [System.Drawing.Graphics]::FromImage($bmp)
# Not pure black: a covered lens still reports sensor noise, and a
# perfectly uniform #000000 is a degenerate input a real camera never sends.
$g.Clear([System.Drawing.Color]::FromArgb(2, 2, 3))
$g.Dispose()
$bmp.Save("$dir\dark-frame.jpg", [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()

Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$questions = @(
  @{ n = "q1"; t = "What is the weather like today?" },
  @{ n = "q2"; t = "Can you remind me what a good bedtime routine looks like?" },
  @{ n = "q3"; t = "How many tablespoons are in a cup?" },
  @{ n = "q4"; t = "Set a timer for ten minutes please." },
  @{ n = "q5"; t = "What should I wear outside this evening?" }
)
foreach ($q in $questions) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.Rate = -1
  $s.SetOutputToWaveFile("$dir\$($q.n).wav", $fmt)
  $s.Speak($q.t)
  $s.Dispose()
}
Write-Output "fixtures written to $dir"
