param(
  [Parameter(Mandatory = $true)][string]$StatePath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$RunId
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$state = [ordered]@{ clicksA = 0; clicksB = 0; textA = ''; textB = ''; pid = $PID }
function Save-State {
  $json = $state | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($StatePath, $json, [System.Text.UTF8Encoding]::new($false))
}

function New-FixtureForm([string]$suffix, [int]$left) {
  $form = [System.Windows.Forms.Form]::new()
  $form.Text = "Atria S3 Fixture $suffix $RunId"
  $form.Name = "AtriaS3Fixture$suffix"
  $form.StartPosition = 'Manual'
  $form.Location = [System.Drawing.Point]::new($left, 120)
  $form.Size = [System.Drawing.Size]::new(480, 320)

  $text = [System.Windows.Forms.TextBox]::new()
  $text.Name = "UnicodeInput$suffix"
  $text.AccessibleName = "Unicode Input $suffix"
  $text.Multiline = $true
  $text.Location = [System.Drawing.Point]::new(24, 24)
  $text.Size = [System.Drawing.Size]::new(410, 120)
  $form.Controls.Add($text)

  $button = [System.Windows.Forms.Button]::new()
  $button.Name = "Increment$suffix"
  $button.AccessibleName = "Increment $suffix"
  $button.Text = "Increment $suffix"
  $button.Location = [System.Drawing.Point]::new(24, 170)
  $button.Size = [System.Drawing.Size]::new(130, 42)
  $form.Controls.Add($button)

  foreach ($index in 1..2) {
    $duplicate = [System.Windows.Forms.Button]::new()
    $duplicate.Name = "Duplicate${suffix}${index}"
    $duplicate.AccessibleName = 'Duplicate Action'
    $duplicate.Text = 'Duplicate Action'
    $duplicate.Location = [System.Drawing.Point]::new(170 + (($index - 1) * 135), 170)
    $duplicate.Size = [System.Drawing.Size]::new(125, 42)
    $form.Controls.Add($duplicate)
  }

  return [pscustomobject]@{ Form = $form; Text = $text; Button = $button }
}

$a = New-FixtureForm -suffix 'A' -left 80
$b = New-FixtureForm -suffix 'B' -left 620
$a.Text.add_TextChanged({ $state.textA = $a.Text.Text; Save-State })
$b.Text.add_TextChanged({ $state.textB = $b.Text.Text; Save-State })
$a.Button.add_Click({ $state.clicksA += 1; Save-State })
$b.Button.add_Click({ $state.clicksB += 1; Save-State })

$context = [System.Windows.Forms.ApplicationContext]::new()
$remaining = 2
$onClosed = {
  $script:remaining -= 1
  if ($script:remaining -le 0) { $context.ExitThread() }
}
$a.Form.add_FormClosed($onClosed)
$b.Form.add_FormClosed($onClosed)
$a.Form.Show()
$b.Form.Show()
$a.Form.Activate()
Save-State
[System.IO.File]::WriteAllText($ReadyPath, ([ordered]@{ pid = $PID; titleA = $a.Form.Text; titleB = $b.Form.Text } | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
[System.Windows.Forms.Application]::Run($context)

