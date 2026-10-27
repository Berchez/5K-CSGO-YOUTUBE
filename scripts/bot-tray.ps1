#Requires -Version 5.1
<#
  5K Bot — bandeja do Windows (system tray) + painel local.
  Vive FORA do processo do bot: se morresse junto, não daria p/ religar.
  Ações PM2 persistem o estado com `pm2 save` (bot parado continua parado no boot).
  Uso: bot-tray.ps1 [-NoLoop] [-PreviewIcon]
#>
param(
  [switch]$NoLoop,
  [switch]$PreviewIcon
)

$ErrorActionPreference = 'SilentlyContinue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BotName = '5k-bot'
$LogFile = Join-Path $RepoRoot 'logs\bot-tray.log'
$RepoLog = Join-Path $RepoRoot 'logs\bot.log'
$StatusFile = Join-Path $RepoRoot 'data\tray-status.json'
$PanelInfoFile = Join-Path $RepoRoot 'data\tray-panel.json'
$IntentFile = Join-Path $RepoRoot 'data\tray-intent.json'
$PanelJs = Join-Path $RepoRoot 'dist\scripts\tray-panel.js'
$EnvFile = Join-Path $RepoRoot '.env'

function Write-TrayLog([string]$msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  try {
    $dir = Split-Path -Parent $LogFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($LogFile, "[$ts] $msg`r`n", $utf8)
  } catch { }
}

function Get-Pm2Command {
  $c = Get-Command pm2.cmd -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:ProgramFiles 'nodejs\pm2.cmd'
  if (Test-Path -LiteralPath $p) { return $p }
  return $null
}

function Invoke-Pm2([string[]]$pm2Args) {
  $pm2 = Get-Pm2Command
  if (-not $pm2) { throw 'pm2 não encontrado (nem no PATH nem em C:\Program Files\nodejs)' }
  $out = & $pm2 @pm2Args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "pm2 $($pm2Args -join ' ') falhou (exit $LASTEXITCODE): $($out | Select-Object -First 3)" }
  return $out
}

# ---------------------------------------------------------------------------
# PM2 / estado do bot
# ---------------------------------------------------------------------------
$script:botState = $null
$script:lastPm2Probe = [datetime]::MinValue
$script:lastBotStatus = $null
$script:lastBotStatusAt = [datetime]::MinValue
$script:lastQuickConfigKey = ''
$script:lastQuickConfigAt = [datetime]::MinValue

function Get-BotPm2Probe {
  try {
    $out = Invoke-Pm2 @('pid', $BotName)
    $nums = @($out | Where-Object { "$_" -match '^\s*(\d+)\s*$' } | ForEach-Object { [int]$Matches[1] })
    if ($nums.Count -eq 1) { return @{ ok = $true; pid = $nums[0] } }
    return @{ ok = $true; pid = $null }
  } catch {
    return @{ ok = $false; pid = $null }
  }
}

# Bot iniciado FORA do PM2 (npm start): heartbeat fresco + processo vivo.
function Get-StatusFileLivePid {
  $status = Read-BotStatus
  if ($status -eq $null -or $status.pid -eq $null) { return $null }
  $botPid = [int]$status.pid
  if ($botPid -le 0) { return $null }
  if ((Get-AgeSeconds ([string]$status.heartbeatAt)) -ge 30) { return $null }
  if (-not (Get-Process -Id $botPid -ErrorAction SilentlyContinue)) { return $null }
  return $botPid
}

function Get-BotState {
  $now = Get-Date
  if ($script:botState -ne $null -and $script:botState.online -and $script:botState.pid -gt 0) {
    if (Get-Process -Id $script:botState.pid -ErrorAction SilentlyContinue) {
      if (($now - $script:lastPm2Probe).TotalSeconds -lt 30) { return $script:botState }
    } else {
      $script:botState = $null
    }
  }
  if ($script:botState -ne $null -and ($now - $script:lastPm2Probe).TotalSeconds -lt 10) {
    return $script:botState
  }
  $probe = Get-BotPm2Probe
  $script:lastPm2Probe = $now
  if ($probe.pid -ne $null -and [int]$probe.pid -gt 0) {
    $script:botState = @{ online = $true; pid = [int]$probe.pid }
    return $script:botState
  }
  # PM2 sem pid: bot pode estar rodando fora do PM2 — evita dupla instância.
  $livePid = Get-StatusFileLivePid
  if ($livePid -ne $null) {
    $script:botState = @{ online = $true; pid = [int]$livePid; source = 'status' }
    return $script:botState
  }
  if ($probe.ok) {
    # PM2 respondeu e não há processo: parado de verdade (não "sem resposta").
    $script:botState = @{ online = $false; pid = 0; source = 'pm2' }
    return $script:botState
  }
  return $null
}

function Save-Pm2State {
  Invoke-Pm2 @('save') | Out-Null
}

function Stop-Bot {
  Invoke-Pm2 @('stop', $BotName) | Out-Null
  $script:botState = $null
  $script:lastPm2Probe = [datetime]::MinValue
  Save-Pm2State
}

function Start-Bot {
  Invoke-Pm2 @('start', $BotName) | Out-Null
  $script:botState = $null
  $script:lastPm2Probe = [datetime]::MinValue
  Save-Pm2State
}

function Restart-Bot {
  Invoke-Pm2 @('restart', $BotName, '--update-env') | Out-Null
  $script:botState = $null
  $script:lastPm2Probe = [datetime]::MinValue
  Save-Pm2State
}

# ---------------------------------------------------------------------------
# .env / ajustes rápidos
# ---------------------------------------------------------------------------
function Get-EnvMap {
  $map = @{}
  if (-not (Test-Path -LiteralPath $EnvFile)) { return $map }
  try {
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
      if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $key = $Matches[1]
        $value = $Matches[2].Trim()
        $quoted = $false
        if ($value.Length -ge 2) {
          $first = $value.Substring(0, 1)
          $last = $value.Substring($value.Length - 1, 1)
          if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
            $quoted = $true
          }
        }
        if (-not $quoted) {
          $hash = $value.IndexOf(' #')
          if ($hash -ge 0) { $value = $value.Substring(0, $hash).Trim() }
        }
        $map[$key] = $value
      }
    }
  } catch { }
  return $map
}

function Get-EnvValue([hashtable]$map, [string]$key, [string]$default) {
  if ($map.ContainsKey($key)) { return [string]$map[$key] }
  return $default
}

function Format-EnvValue([string]$value) {
  if ($value -eq '') { return '' }
  if (($value -match '^[A-Za-z0-9_.,:/+\-@%*= ]+$') -and ($value -notmatch '#')) { return $value }
  $escaped = $value.Replace('\', '\\').Replace('"', '\"').Replace("`r`n", '\n').Replace("`n", '\n')
  return '"' + $escaped + '"'
}

function Set-EnvValue([string]$key, [string]$value) {
  if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Chave .env inválida: $key" }
  if ($value -match "[\r\n]") { throw "Valor inválido para $key" }
  $lines = New-Object 'System.Collections.Generic.List[string]'
  if (Test-Path -LiteralPath $EnvFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) { $lines.Add($line) }
    Copy-Item -LiteralPath $EnvFile -Destination "$EnvFile.bak" -Force
  }
  $escaped = [regex]::Escape($key)
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*(?:export\s+)?$escaped\s*=") {
      $lines[$i] = "$key=$(Format-EnvValue $value)"
      $found = $true
    }
  }
  if (-not $found) { $lines.Add("$key=$(Format-EnvValue $value)") }
  $dir = Split-Path -Parent $EnvFile
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $tmp = "$EnvFile.$PID.tmp"
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($tmp, $lines, $encoding)
  Move-Item -LiteralPath $tmp -Destination $EnvFile -Force
}

function Test-BotBusy {
  $status = Read-BotStatus
  if ($status -eq $null) { return $null }
  $recording = 0
  $pending = 0
  if ($status.totals -ne $null) { $recording = [int]$status.totals.recording }
  if ($status.pendingClips -ne $null) { $pending = [int]$status.pendingClips }
  if ($recording -le 0 -and $pending -le 0) { return $null }
  $parts = @()
  if ($recording -gt 0) { $parts += "$recording gravação(ões) em andamento" }
  if ($pending -gt 0) { $parts += "$pending clipe(s) em andamento" }
  return ($parts -join ' e ')
}

function Confirm-BusyRestart([string]$what) {
  $busy = Test-BotBusy
  if ($busy -eq $null) { return $true }
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "$what`n`nO bot está com $busy. Reiniciar agora pode perder esse trabalho.`n`nContinuar?",
    '5K Bot',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  return ($answer -eq [System.Windows.Forms.DialogResult]::Yes)
}

function Set-QuickConfig([string]$key, [string]$value, [string]$label) {
  try {
    $stamp = "$key=$value"
    if ($script:lastQuickConfigKey -eq $stamp -and ((Get-Date) - $script:lastQuickConfigAt).TotalSeconds -lt 10) {
      Write-TrayLog "ajuste rápido ignorado (repetido em menos de 10s): $stamp"
      return
    }
    if ($key -eq 'YT_PRIVACY' -and $value -eq 'public') {
      $answer = [System.Windows.Forms.MessageBox]::Show(
        "Salvar como PÚBLICO deixa o vídeo visível para qualquer pessoa no YouTube. A política do bot é private + revisão manual.`n`nContinuar?",
        '5K Bot',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      )
      if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    }
    $state = Get-BotState
    $online = ($state -ne $null -and $state.online)
    if ($online -and -not (Confirm-BusyRestart "Aplicar $label agora reinicia o bot.")) { return }
    Set-EnvValue $key $value
    $script:lastQuickConfigKey = $stamp
    $script:lastQuickConfigAt = Get-Date
    if ($online) {
      Suppress-Toast
      Restart-Bot
      Write-TrayLog "ajuste rápido: $stamp (bot reiniciado)"
      Show-TrayBalloon '5K Bot' "$label salvo. Reiniciando para aplicar."
    } else {
      Write-TrayLog "ajuste rápido: $stamp (bot parado)"
      Show-TrayBalloon '5K Bot' "$label salvo. Inicie o bot para aplicar."
    }
  } catch {
    Write-TrayLog "ajuste rápido FALHOU ($key=$value): $($_.Exception.Message)"
    Show-TrayBalloon '5K Bot: erro' $_.Exception.Message
  }
  Update-State
}

# ---------------------------------------------------------------------------
# Painel local (servidor Node separado)
# ---------------------------------------------------------------------------
function Get-PanelInfo {
  if (-not (Test-Path -LiteralPath $PanelInfoFile)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($PanelInfoFile, [System.Text.Encoding]::UTF8)
    if (-not $raw) { return $null }
    $info = $raw | ConvertFrom-Json
    if (-not $info.port -or -not $info.token) { return $null }
    return $info
  } catch {
    return $null
  }
}

function Test-Panel($info) {
  if ($info -eq $null) { return $false }
  try {
    $headers = @{ 'x-tray-token' = [string]$info.token }
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($info.port)/api/health" -Headers $headers -TimeoutSec 2
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Start-Panel {
  if (-not (Test-Path -LiteralPath $PanelJs)) {
    throw 'Painel não compilado. Rode "npm run build" na pasta do projeto.'
  }
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $candidate) { $node = $candidate }
  }
  if (-not $node) { throw 'node.exe não encontrado.' }
  Start-Process -FilePath $node -ArgumentList @("`"$PanelJs`"") -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 150
    $info = Get-PanelInfo
    if ($info -ne $null -and (Test-Panel $info)) { return $info }
  }
  throw 'O painel não respondeu. Veja logs\tray-panel.log.'
}

function Open-Panel([string]$hash) {
  try {
    $info = Get-PanelInfo
    if (-not (Test-Panel $info)) { $info = Start-Panel }
    if ($info -eq $null) { throw 'Painel indisponível.' }
    $url = "http://127.0.0.1:$($info.port)/?token=$($info.token)$hash"
    Start-Process $url
    Write-TrayLog "painel aberto (porta $($info.port))"
  } catch {
    Show-TrayBalloon '5K Bot: painel' $_.Exception.Message
    Write-TrayLog "abrir painel FALHOU: $($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------------------
# Ícones
# ---------------------------------------------------------------------------
function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $path.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $path.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-BotIcon([string]$dotColor) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0b1220'))
  $path = New-RoundedPath 1 1 30 30 8
  $g.FillPath($bg, $path)
  $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 148, 163, 184), 1)
  $g.DrawPath($border, $path)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(248, 250, 252))
  $font5 = [System.Drawing.Font]::new('Segoe UI', 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fontK = [System.Drawing.Font]::new('Segoe UI', 7, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $g.DrawString('5', $font5, $white, 3, 2)
  $g.DrawString('K', $fontK, $white, 18, 4)
  $dot = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($dotColor))
  $g.FillEllipse($dot, 21, 21, 9, 9)
  $ring = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(240, 11, 18, 32), 2)
  $g.DrawEllipse($ring, 21, 21, 9, 9)
  $g.Dispose()
  $bg.Dispose(); $border.Dispose(); $white.Dispose(); $dot.Dispose(); $ring.Dispose()
  $font5.Dispose(); $fontK.Dispose(); $path.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

function New-GlyphIcon([int]$code, [string]$htmlColor) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $font = [System.Drawing.Font]::new('Segoe MDL2 Assets', 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($htmlColor))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF 0, 0, 16, 16
  $g.DrawString([string][char]$code, $font, $brush, $rect, $fmt)
  $g.Dispose(); $font.Dispose(); $brush.Dispose(); $fmt.Dispose()
  return $bmp
}

function New-StatusDotImage([string]$htmlColor) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($htmlColor))
  $g.FillEllipse($brush, 3, 3, 10, 10)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 11, 18, 32), 2)
  $g.DrawEllipse($pen, 3, 3, 10, 10)
  $g.Dispose(); $brush.Dispose(); $pen.Dispose()
  return $bmp
}

if ($NoLoop) { return }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($PreviewIcon) {
  $previewDir = Join-Path $RepoRoot 'data'
  if (-not (Test-Path -LiteralPath $previewDir)) { New-Item -ItemType Directory -Path $previewDir -Force | Out-Null }
  $preview = New-Object System.Drawing.Bitmap 164, 52
  $g = [System.Drawing.Graphics]::FromImage($preview)
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0b1220'))
  $colors = @('#94a3b8', '#22c55e', '#38bdf8', '#f59e0b', '#f43f5e')
  $x = 10
  foreach ($color in $colors) {
    $icon = New-BotIcon $color
    $g.DrawIcon($icon, $x, 10)
    $x += 32
  }
  $g.Dispose()
  $preview.Save((Join-Path $previewDir 'tray-icon-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $preview.Dispose()
  Write-Output (Join-Path $previewDir 'tray-icon-preview.png')
  return
}

# --- instância única via mutex nomeado ---
$script:trayMutex = $null
try {
  $m = New-Object System.Threading.Mutex($false, 'FiveKBotTraySingleton')
  if ($m.WaitOne(0)) {
    $script:trayMutex = $m
  } else {
    exit 0
  }
} catch [System.Threading.AbandonedMutexException] {
  $script:trayMutex = $m
} catch {
  exit 0
}

$script:icons = @{
  offline   = New-BotIcon '#94a3b8'
  online    = New-BotIcon '#22c55e'
  recording = New-BotIcon '#38bdf8'
  warn      = New-BotIcon '#f59e0b'
  error     = New-BotIcon '#f43f5e'
}
$script:stateColors = @{
  offline   = '#94a3b8'
  online    = '#22c55e'
  recording = '#38bdf8'
  warn      = '#f59e0b'
  error     = '#f43f5e'
}
$script:dotImages = @{
  offline   = New-StatusDotImage '#94a3b8'
  online    = New-StatusDotImage '#22c55e'
  recording = New-StatusDotImage '#38bdf8'
  warn      = New-StatusDotImage '#f59e0b'
  error     = New-StatusDotImage '#f43f5e'
}

$iconPlay = New-GlyphIcon 0xE768 '#86efac'
$iconStop = New-GlyphIcon 0xE71A '#fda4af'
$iconRestart = New-GlyphIcon 0xE72C '#7dd3fc'
$iconPanel = New-GlyphIcon 0xE713 '#c4b5fd'
$iconFolder = New-GlyphIcon 0xE8B7 '#fcd34d'
$iconLog = New-GlyphIcon 0xE8A5 '#94a3b8'
$iconUpload = New-GlyphIcon 0xE898 '#7dd3fc'
$iconPower = New-GlyphIcon 0xE7E8 '#fda4af'
$iconQuick = New-GlyphIcon 0xE9E9 '#c4b5fd'
$iconSettings = New-GlyphIcon 0xE713 '#c4b5fd'
$iconStar = New-GlyphIcon 0xE735 '#fcd34d'
$iconStream = New-GlyphIcon 0xE774 '#7dd3fc'
$iconPrivacy = New-GlyphIcon 0xE72E '#c4b5fd'
$iconRecordings = New-GlyphIcon 0xE7C8 '#86efac'

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $script:icons.offline
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $true
$menu.Font = [System.Drawing.Font]::new('Segoe UI', 9)

$miHeader = New-Object System.Windows.Forms.ToolStripMenuItem '5K Bot · Verificando...'
$miHeader.Enabled = $false
$miHeader.Font = [System.Drawing.Font]::new('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add($miHeader)

$miSummary = New-Object System.Windows.Forms.ToolStripMenuItem 'Aguardando status...'
$miSummary.Enabled = $false
[void]$menu.Items.Add($miSummary)

$miMatch1 = New-Object System.Windows.Forms.ToolStripMenuItem ''
$miMatch1.Enabled = $false
$miMatch1.Visible = $false
[void]$menu.Items.Add($miMatch1)

$miMatch2 = New-Object System.Windows.Forms.ToolStripMenuItem ''
$miMatch2.Enabled = $false
$miMatch2.Visible = $false
[void]$menu.Items.Add($miMatch2)

$miLastClip = New-Object System.Windows.Forms.ToolStripMenuItem ''
$miLastClip.Enabled = $false
$miLastClip.Visible = $false
[void]$menu.Items.Add($miLastClip)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miPanel = New-Object System.Windows.Forms.ToolStripMenuItem 'Abrir painel'
$miPanel.Image = $iconPanel
$miPanel.Add_Click({ Open-Panel '' })
[void]$menu.Items.Add($miPanel)

$miSettings = New-Object System.Windows.Forms.ToolStripMenuItem 'Configurações...'
$miSettings.Image = $iconSettings
$miSettings.Add_Click({ Open-Panel '#settings' })
[void]$menu.Items.Add($miSettings)

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem 'Abrir'
$miOpen.Image = $iconFolder
$miOpenClips = New-Object System.Windows.Forms.ToolStripMenuItem 'Pasta de clipes'
$miOpenClips.Image = $iconFolder
$miOpenClips.Add_Click({ Start-Process explorer.exe (Join-Path $RepoRoot 'data\clips') })
[void]$miOpen.DropDownItems.Add($miOpenClips)
$miOpenLogs = New-Object System.Windows.Forms.ToolStripMenuItem 'Pasta de logs'
$miOpenLogs.Image = $iconLog
$miOpenLogs.Add_Click({ Start-Process explorer.exe (Join-Path $RepoRoot 'logs') })
[void]$miOpen.DropDownItems.Add($miOpenLogs)
$miOpenLog = New-Object System.Windows.Forms.ToolStripMenuItem 'Abrir bot.log'
$miOpenLog.Image = $iconLog
$miOpenLog.Add_Click({
  if (Test-Path -LiteralPath $RepoLog) { Start-Process notepad.exe -ArgumentList "`"$RepoLog`"" }
  else { Show-TrayBalloon '5K Bot' 'Arquivo de log ainda não existe.' }
})
[void]$miOpen.DropDownItems.Add($miOpenLog)
[void]$menu.Items.Add($miOpen)

$miQuick = New-Object System.Windows.Forms.ToolStripMenuItem 'Ajustes rápidos'
$miQuick.Image = $iconQuick

$miQuickUpload = New-Object System.Windows.Forms.ToolStripMenuItem 'Upload para YouTube'
$miQuickUpload.Image = $iconUpload
$miQuickUpload.CheckOnClick = $false
$miQuickUpload.Add_Click({
  $map = Get-EnvMap
  $current = Get-EnvValue $map 'YT_UPLOAD' 'true'
  $next = 'false'
  if ($current -ne 'true') { $next = 'true' }
  $label = 'Upload desligado'
  if ($next -eq 'true') { $label = 'Upload ligado' }
  Set-QuickConfig 'YT_UPLOAD' $next $label
})
[void]$miQuick.DropDownItems.Add($miQuickUpload)

$miQuickPrivacy = New-Object System.Windows.Forms.ToolStripMenuItem 'Privacidade do vídeo'
$miQuickPrivacy.Image = $iconPrivacy
function Add-ChoiceItem($parent, [string]$label, [string]$key, [string]$value, [string]$imageCode) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem $label
  if ($imageCode) { $item.Image = New-GlyphIcon ([Convert]::ToInt32($imageCode, 16)) '#94a3b8' }
  $item.Tag = @{ key = $key; value = $value; label = $label }
  $item.Add_Click({
    param($sender, $eventArgs)
    Set-QuickConfig $sender.Tag.key $sender.Tag.value $sender.Tag.label
  })
  [void]$parent.DropDownItems.Add($item)
  return $item
}
$privacyPrivate = Add-ChoiceItem $miQuickPrivacy 'Privado' 'YT_PRIVACY' 'private' ''
$privacyUnlisted = Add-ChoiceItem $miQuickPrivacy 'Não listado' 'YT_PRIVACY' 'unlisted' ''
$privacyPublic = Add-ChoiceItem $miQuickPrivacy 'Público' 'YT_PRIVACY' 'public' ''
[void]$miQuick.DropDownItems.Add($miQuickPrivacy)

$miQuickStream = New-Object System.Windows.Forms.ToolStripMenuItem 'Stream preferida'
$miQuickStream.Image = $iconStream
$miQuickCountry = New-Object System.Windows.Forms.ToolStripMenuItem 'País'
$countryItems = @()
$countryItems += Add-ChoiceItem $miQuickCountry 'Sem preferência' 'STREAM_PREFERRED_COUNTRY' '' 'E774'
$countryItems += Add-ChoiceItem $miQuickCountry 'Brasil (BR)' 'STREAM_PREFERRED_COUNTRY' 'BR' 'E774'
$countryItems += Add-ChoiceItem $miQuickCountry 'Estados Unidos (US)' 'STREAM_PREFERRED_COUNTRY' 'US' 'E774'
$countryItems += Add-ChoiceItem $miQuickCountry 'Portugal (PT)' 'STREAM_PREFERRED_COUNTRY' 'PT' 'E774'
$countryItems += Add-ChoiceItem $miQuickCountry 'Argentina (AR)' 'STREAM_PREFERRED_COUNTRY' 'AR' 'E774'
$countryItems += Add-ChoiceItem $miQuickCountry 'Rússia (RU)' 'STREAM_PREFERRED_COUNTRY' 'RU' 'E774'
[void]$miQuickStream.DropDownItems.Add($miQuickCountry)
$miQuickViewers = New-Object System.Windows.Forms.ToolStripMenuItem 'Audiência mínima'
$viewerItems = @()
$viewerItems += Add-ChoiceItem $miQuickViewers 'Sem mínimo' 'STREAM_PREFERRED_MIN_VIEWERS' '0' 'E774'
$viewerItems += Add-ChoiceItem $miQuickViewers '1.000 viewers' 'STREAM_PREFERRED_MIN_VIEWERS' '1000' 'E774'
$viewerItems += Add-ChoiceItem $miQuickViewers '2.000 viewers' 'STREAM_PREFERRED_MIN_VIEWERS' '2000' 'E774'
$viewerItems += Add-ChoiceItem $miQuickViewers '5.000 viewers' 'STREAM_PREFERRED_MIN_VIEWERS' '5000' 'E774'
[void]$miQuickStream.DropDownItems.Add($miQuickViewers)
[void]$miQuick.DropDownItems.Add($miQuickStream)

[void]$miQuick.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miQuickStars = New-Object System.Windows.Forms.ToolStripMenuItem 'Estrelas mínimas'
$miQuickStars.Image = $iconStar
$starItems = @()
$starItems += Add-ChoiceItem $miQuickStars 'Qualquer (0★)' 'MIN_STARS' '0' 'E735'
$starItems += Add-ChoiceItem $miQuickStars '1★+' 'MIN_STARS' '1' 'E735'
$starItems += Add-ChoiceItem $miQuickStars '2★+' 'MIN_STARS' '2' 'E735'
$starItems += Add-ChoiceItem $miQuickStars '3★+' 'MIN_STARS' '3' 'E735'
[void]$miQuick.DropDownItems.Add($miQuickStars)

$miQuickRecordings = New-Object System.Windows.Forms.ToolStripMenuItem 'Gravações simultâneas'
$miQuickRecordings.Image = $iconRecordings
$recordingItems = @()
$recordingItems += Add-ChoiceItem $miQuickRecordings '1 partida' 'MAX_RECORDINGS' '1' 'E7C8'
$recordingItems += Add-ChoiceItem $miQuickRecordings '2 partidas' 'MAX_RECORDINGS' '2' 'E7C8'
$recordingItems += Add-ChoiceItem $miQuickRecordings '3 partidas' 'MAX_RECORDINGS' '3' 'E7C8'
$recordingItems += Add-ChoiceItem $miQuickRecordings '4 partidas' 'MAX_RECORDINGS' '4' 'E7C8'
[void]$miQuick.DropDownItems.Add($miQuickRecordings)
[void]$menu.Items.Add($miQuick)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miStop = New-Object System.Windows.Forms.ToolStripMenuItem 'Parar bot'
$miStop.Image = $iconStop
$miStop.Add_Click({ On-StopClicked })
[void]$menu.Items.Add($miStop)

$miStart = New-Object System.Windows.Forms.ToolStripMenuItem 'Iniciar bot'
$miStart.Image = $iconPlay
$miStart.Add_Click({ On-StartClicked })
[void]$menu.Items.Add($miStart)

$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem 'Reiniciar bot'
$miRestart.Image = $iconRestart
$miRestart.Add_Click({ On-RestartClicked })
[void]$menu.Items.Add($miRestart)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miExit = New-Object System.Windows.Forms.ToolStripMenuItem 'Sair (fecha o tray)'
$miExit.Image = $iconPower
$miExit.Add_Click({ On-ExitClicked })
[void]$menu.Items.Add($miExit)

$tray.ContextMenuStrip = $menu

$script:lastOnline = $null
$script:lastVisual = $null
$script:suppressToastUntil = [datetime]::MinValue

function Show-TrayBalloon([string]$title, [string]$text) {
  $tray.BalloonTipTitle = $title
  $tray.BalloonTipText = $text
  $tray.ShowBalloonTip(5000)
}

function Suppress-Toast {
  $script:suppressToastUntil = (Get-Date).AddSeconds(30)
}

function Set-TrayText([string]$text) {
  if ($text.Length -gt 63) { $text = $text.Substring(0, 60) + '...' }
  $tray.Text = $text
}

function Read-BotStatus {
  if (-not (Test-Path -LiteralPath $StatusFile)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($StatusFile, [System.Text.Encoding]::UTF8)
    if (-not $raw) { return $null }
    $parsed = $raw | ConvertFrom-Json
    $script:lastBotStatus = $parsed
    $script:lastBotStatusAt = Get-Date
    return $parsed
  } catch {
    if ($script:lastBotStatus -ne $null -and ((Get-Date) - $script:lastBotStatusAt).TotalSeconds -lt 10) {
      return $script:lastBotStatus
    }
    return $null
  }
}

function Read-Intent {
  if (-not (Test-Path -LiteralPath $IntentFile)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($IntentFile, [System.Text.Encoding]::UTF8)
    if (-not $raw) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Apply-IntentSuppression {
  $intent = Read-Intent
  if ($intent -eq $null -or -not $intent.suppressUntil) { return }
  try {
    $until = [datetimeoffset]::Parse([string]$intent.suppressUntil, [System.Globalization.CultureInfo]::InvariantCulture).LocalDateTime
    if ($until -gt (Get-Date)) { $script:suppressToastUntil = $until }
  } catch { }
}

function Get-AgeSeconds([string]$iso) {
  if (-not $iso) { return [double]::PositiveInfinity }
  try {
    $time = [datetimeoffset]::Parse($iso, [System.Globalization.CultureInfo]::InvariantCulture)
    return ((Get-Date) - $time.LocalDateTime).TotalSeconds
  } catch {
    return [double]::PositiveInfinity
  }
}

function Update-QuickChecks {
  $map = Get-EnvMap
  $upload = Get-EnvValue $map 'YT_UPLOAD' 'true'
  $miQuickUpload.Checked = ($upload.ToLower() -eq 'true')

  $privacy = Get-EnvValue $map 'YT_PRIVACY' 'private'
  $privacyPrivate.Checked = ($privacy -eq 'private')
  $privacyUnlisted.Checked = ($privacy -eq 'unlisted')
  $privacyPublic.Checked = ($privacy -eq 'public')

  $country = (Get-EnvValue $map 'STREAM_PREFERRED_COUNTRY' '').ToUpper()
  foreach ($item in $countryItems) {
    $item.Checked = ([string]$item.Tag.value -eq $country)
  }
  $viewers = Get-EnvValue $map 'STREAM_PREFERRED_MIN_VIEWERS' '0'
  foreach ($item in $viewerItems) {
    $item.Checked = ([string]$item.Tag.value -eq $viewers)
  }

  $stars = Get-EnvValue $map 'MIN_STARS' '0'
  foreach ($item in $starItems) {
    $item.Checked = ([string]$item.Tag.value -eq $stars)
  }
  $recordings = Get-EnvValue $map 'MAX_RECORDINGS' '2'
  foreach ($item in $recordingItems) {
    $item.Checked = ([string]$item.Tag.value -eq $recordings)
  }
}

function Update-State {
  $state = $null
  try {
    $state = Get-BotState
  } catch {
    $state = $null
  }

  $status = Read-BotStatus
  $running = ($state -ne $null -and $state.online)
  $onlineKnown = ($state -ne $null)
  $stale = $true
  $heartbeatAge = [double]::PositiveInfinity
  $pidMismatch = $false
  if ($running -and $status -ne $null) {
    $heartbeatAge = Get-AgeSeconds ([string]$status.heartbeatAt)
    $stale = ($heartbeatAge -gt 90)
    if ($status.pid -ne $null -and $state.pid -gt 0 -and [int]$status.pid -ne [int]$state.pid) {
      $pidMismatch = $true
    }
  }
  $errorRecent = $false
  if ($status -ne $null -and $status.lastError -ne $null) {
    $errorAge = Get-AgeSeconds ([string]$status.lastError.at)
    $errorRecent = ($errorAge -lt 120)
  }

  $visual = 'offline'
  $label = 'Parado'
  if (-not $onlineKnown) {
    $visual = 'warn'
    $label = 'PM2 sem resposta'
  } elseif ($running) {
    if ($status -eq $null -or $stale) {
      $visual = 'warn'
      if ($status -eq $null -or $pidMismatch) { $label = 'Iniciando...' } else { $label = 'Sem resposta' }
    } elseif ($errorRecent) {
      $visual = 'warn'
      $label = 'Atenção'
    } elseif ($status.phase -eq 'recording' -or ($status.totals -ne $null -and $status.totals.recording -gt 0)) {
      $visual = 'recording'
      $label = 'Gravando'
    } else {
      $visual = 'online'
      $label = 'Monitorando'
    }
  } else {
    $visual = 'offline'
    $label = 'Parado'
  }

  $tray.Icon = $script:icons[$visual]
  $miHeader.Text = "5K Bot · $label"
  $miHeader.Image = $script:dotImages[$visual]

  $summary = 'Inicie o bot para monitorar partidas.'
  if ($running -and $status -ne $null) {
    $lives = 0; $recording = 0; $trackers = 0; $disk = '—'
    if ($status.totals -ne $null) {
      $lives = [int]$status.totals.live
      $recording = [int]$status.totals.recording
      $trackers = [int]$status.totals.trackers
    }
    if ($status.diskFreeGb -ne $null) { $disk = "$($status.diskFreeGb) GB" }
    $summary = "$lives lives · $recording gravando · $trackers trackers · $disk livres"
    if ($stale) { $summary = "Sem resposta há $([math]::Round($heartbeatAge))s · último estado: $lives lives" }
    elseif ($errorRecent) { $summary = "Atenção: $($status.lastError.message)" }
  } elseif (-not $onlineKnown) {
    $summary = 'Não foi possível consultar o PM2.'
  } elseif (-not $running) {
    $summary = 'Bot parado · use Iniciar para retomar.'
  }
  $miSummary.Text = $summary

  $liveMatches = @()
  if ($running -and $status -ne $null -and $status.matches -ne $null) {
    $liveMatches = @($status.matches | Select-Object -First 2)
  }
  $matchItems = @($miMatch1, $miMatch2)
  for ($i = 0; $i -lt $matchItems.Count; $i++) {
    if ($i -lt $liveMatches.Count) {
      $m = $liveMatches[$i]
      $stateText = @{ recording = 'REC'; tracking = 'tracker'; waiting = 'aguardando'; 'no-stream' = 'sem stream' }[[string]$m.state]
      if (-not $stateText) { $stateText = [string]$m.state }
      $streamText = ''
      if ($m.stream -ne $null -and $m.stream.name) { $streamText = " · $($m.stream.name)" }
      $text = "$($m.team1) vs $($m.team2) · $([string][char]0x2605)$($m.stars) · $stateText$streamText"
      if ($text.Length -gt 72) { $text = $text.Substring(0, 69) + '...' }
      $matchItems[$i].Text = $text
      $matchItems[$i].Visible = $true
    } else {
      $matchItems[$i].Visible = $false
    }
  }

  if ($running -and $status -ne $null -and $status.lastClip -ne $null) {
    $clip = $status.lastClip
    $clipState = 'local'
    if ($clip.uploaded) { $clipState = 'enviado' }
    $miLastClip.Text = "Último: $($clip.player) · $($clip.map) r$($clip.round) · $clipState"
    $miLastClip.Visible = $true
  } else {
    $miLastClip.Visible = $false
  }

  if ($running) {
    $miStop.Enabled = $true; $miStart.Enabled = $false; $miRestart.Enabled = $true
  } elseif ($onlineKnown) {
    $miStop.Enabled = $false; $miStart.Enabled = $true; $miRestart.Enabled = $false
  } else {
    $miStop.Enabled = $false; $miStart.Enabled = $false; $miRestart.Enabled = $false
  }

  $pidText = ''
  if ($running -and $state.pid -gt 0) { $pidText = " · pid $($state.pid)" }
  if ($visual -eq 'recording') {
    $count = 0
    if ($status -ne $null -and $status.totals -ne $null) { $count = [int]$status.totals.recording }
    Set-TrayText "5K Bot: gravando $count$pidText"
  } elseif ($visual -eq 'online') {
    $lives = 0
    if ($status -ne $null -and $status.totals -ne $null) { $lives = [int]$status.totals.live }
    Set-TrayText "5K Bot: monitorando · $lives lives$pidText"
  } elseif ($visual -eq 'warn') {
    Set-TrayText "5K Bot: $label$pidText"
  } elseif ($visual -eq 'error') {
    Set-TrayText "5K Bot: erro$pidText"
  } else {
    Set-TrayText '5K Bot: parado'
  }

  if ($script:lastVisual -ne $visual) {
    Write-TrayLog "estado visual: $visual ($label)"
    $script:lastVisual = $visual
  }

  $intentionalStop = ($status -ne $null -and $status.phase -eq 'stopping')
  Apply-IntentSuppression
  if ($script:lastOnline -ne $null -and $script:lastOnline -and -not $running -and $onlineKnown -and -not $intentionalStop -and (Get-Date) -gt $script:suppressToastUntil) {
    Show-TrayBalloon '5K Bot' 'O bot parou inesperadamente. Clique com o botão direito para Iniciar.'
    Write-TrayLog 'bot parou inesperadamente (toast exibido)'
  }
  if ($onlineKnown) { $script:lastOnline = $running }
}

function On-StopClicked {
  try {
    Suppress-Toast
    Stop-Bot
    Write-TrayLog 'Parar bot: ok (estado persistido p/ o boot)'
  } catch {
    Show-TrayBalloon '5K Bot: erro' $_.Exception.Message
    Write-TrayLog "Parar bot FALHOU: $($_.Exception.Message)"
  }
  Update-State
}

function On-StartClicked {
  try {
    Suppress-Toast
    Start-Bot
    Write-TrayLog 'Iniciar bot: ok (estado persistido p/ o boot)'
  } catch {
    Show-TrayBalloon '5K Bot: erro' $_.Exception.Message
    Write-TrayLog "Iniciar bot FALHOU: $($_.Exception.Message)"
  }
  Update-State
}

function On-RestartClicked {
  try {
    if (-not (Confirm-BusyRestart 'Reiniciar o bot agora?')) { return }
    Suppress-Toast
    Restart-Bot
    Write-TrayLog 'Reiniciar bot: ok'
  } catch {
    Show-TrayBalloon '5K Bot: erro' $_.Exception.Message
    Write-TrayLog "Reiniciar bot FALHOU: $($_.Exception.Message)"
  }
  Update-State
}

function On-ExitClicked {
  $r = [System.Windows.Forms.MessageBox]::Show(
    'Parar o bot também antes de sair?',
    '5K Bot',
    [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($r -eq [System.Windows.Forms.DialogResult]::Cancel) { return }
  if ($r -eq [System.Windows.Forms.DialogResult]::Yes) {
    try { Suppress-Toast; Stop-Bot; Write-TrayLog 'Parar bot (na saída): ok' }
    catch { Write-TrayLog "Parar bot (na saída) FALHOU: $($_.Exception.Message)" }
  }
  Write-TrayLog 'tray encerrado pelo usuário'
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
}

$tray.Add_DoubleClick({ Open-Panel '' })
$menu.Add_Opening({
  Update-State
  Update-QuickChecks
})

Update-State
Write-TrayLog 'tray iniciado (5k-bot, painel local)'

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2500
$timer.Add_Tick({ Update-State })
$timer.Start()

[System.Windows.Forms.Application]::Run()
