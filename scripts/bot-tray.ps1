#Requires -Version 5.1
<#
  5K Bot — ícone na bandeja (system tray) p/ controlar o bot via PM2.
  O tray vive FORA do processo do bot: se morresse junto, não daria p/ religar.
  Ações executam `pm2 stop/start/restart 5k-bot` + `pm2 save` (o save persiste
  o estado p/ o `pm2 resurrect` do boot — bot parado continua parado após reboot).
  Uso: bot-tray.ps1 [-NoLoop]  (-NoLoop = só define funções, p/ teste)
#>
param([switch]$NoLoop)

$ErrorActionPreference = 'SilentlyContinue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BotName = '5k-bot'
$LogFile = Join-Path $RepoRoot 'logs\bot-tray.log'
$RepoLog = Join-Path $RepoRoot 'logs\bot.log'

function Write-TrayLog([string]$msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $LogFile -Value "[$ts] $msg"
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

# Estado: pid>0 = online. Pids são transitórios (restart/crash os recicla em
# segundos — um `pm2 pid` isolado pode pegar valor obsoleto no meio da
# transição). Por isso: checagem barata via Get-Process no dia a dia +
# revalidação contra o pm2 a cada ~60s (fonte da verdade).
$script:knownPid = 0
$script:pollCount = 0

function Get-BotPidFromPm2 {
  try {
    $out = Invoke-Pm2 @('pid', $BotName)
    $nums = @($out | Where-Object { "$_" -match '^\s*(\d+)\s*$' } | ForEach-Object { [int]$Matches[1] })
    # Exatamente 1 número = resposta íntegra. 0 ou >1 = erro/ambíguo.
    if ($nums.Count -eq 1) { return $nums[0] }
    return $null
  } catch {
    return $null
  }
}

function Get-BotState {
  if ($script:knownPid -gt 0) {
    if (Get-Process -Id $script:knownPid -ErrorAction SilentlyContinue) {
      $script:pollCount++
      if (($script:pollCount % 6) -eq 0) {
        $p = Get-BotPidFromPm2
        if ($p -ne $null) { $script:knownPid = $p }
      }
      if ($script:knownPid -gt 0) { return @{ online = $true; pid = $script:knownPid } }
      return @{ online = $false; pid = 0 }
    }
    $script:knownPid = 0
  }
  # Sem pid conhecido (ou morreu entre polls): consulta o pm2.
  $p = Get-BotPidFromPm2
  if ($p -eq $null) { return $null }
  $script:knownPid = $p
  if ($p -gt 0) { return @{ online = $true; pid = $p } }
  return @{ online = $false; pid = 0 }
}

function Save-Pm2State {
  Invoke-Pm2 @('save') | Out-Null
}

function Stop-Bot {
  Invoke-Pm2 @('stop', $BotName) | Out-Null
  $script:knownPid = 0
  Save-Pm2State
}

function Start-Bot {
  Invoke-Pm2 @('start', $BotName) | Out-Null
  $script:knownPid = 0
  Save-Pm2State
}

function Restart-Bot {
  Invoke-Pm2 @('restart', $BotName, '--update-env') | Out-Null
  $script:knownPid = 0
  Save-Pm2State
}

function New-DotIcon([string]$htmlColor) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($htmlColor))
  $g.FillEllipse($brush, 1, 1, 14, 14)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 60, 60, 60))
  $g.DrawEllipse($pen, 1, 1, 14, 14)
  $g.Dispose(); $brush.Dispose(); $pen.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

if ($NoLoop) { return }

# --- instância única via mutex nomeado (NÃO via scan de processos: o próprio
# comando que lança o tray contém 'bot-tray.ps1' e se auto-detectaria) ---
$script:trayMutex = $null
try {
  $m = New-Object System.Threading.Mutex($false, 'FiveKBotTraySingleton')
  if ($m.WaitOne(0)) {
    $script:trayMutex = $m
  } else {
    exit 0
  }
} catch [System.Threading.AbandonedMutexException] {
  # dono anterior morreu sem liberar: a posse veio junto com a exceção
  $script:trayMutex = $m
} catch {
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$iconOn = New-DotIcon '#2ecc71'
$iconOff = New-DotIcon '#95a5a6'
$iconErr = New-DotIcon '#e74c3c'

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconOff
$tray.Text = '5K Bot: verificando...'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = $menu.Items.Add('Status: verificando...'); $miStatus.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miStop = $menu.Items.Add('Parar bot'); $miStop.Add_Click({ On-StopClicked })
$miStart = $menu.Items.Add('Iniciar bot'); $miStart.Add_Click({ On-StartClicked })
$miRestart = $menu.Items.Add('Reiniciar bot'); $miRestart.Add_Click({ On-RestartClicked })
$miLog = $menu.Items.Add('Abrir log'); $miLog.Add_Click({ On-LogClicked })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miExit = $menu.Items.Add('Sair (fecha o tray)'); $miExit.Add_Click({ On-ExitClicked })
$tray.ContextMenuStrip = $menu

$script:lastOnline = $null
# Ações do usuário suprimem o toast de "morte inesperada" por 30s (cobre a
# transição do pm2 sem mascarar mortes reais posteriores).
$script:suppressToastUntil = [datetime]::MinValue

function Show-TrayBalloon([string]$title, [string]$text) {
  $tray.BalloonTipTitle = $title
  $tray.BalloonTipText = $text
  $tray.ShowBalloonTip(5000)
}

function Update-State {
  $state = $null
  $errMsg = $null
  try {
    $state = Get-BotState
  } catch {
    $errMsg = $_.Exception.Message
  }
  if ($errMsg) {
    $tray.Icon = $iconErr
    $tray.Text = '5K Bot: erro (pm2 indisponivel)'
    $miStatus.Text = 'Erro: pm2 indisponível'
    $miStop.Enabled = $false; $miStart.Enabled = $false; $miRestart.Enabled = $false
    return
  }
  if ($state -eq $null) {
    # pm2 não respondeu: mantém o último visual, tenta de novo no próximo ciclo.
    return
  }
  if ($state.online) {
    $tray.Icon = $iconOn
    $tray.Text = "5K Bot: ONLINE (pid $($state.pid))"
    $miStatus.Text = "Status: ONLINE (pid $($state.pid))"
    $miStop.Enabled = $true; $miStart.Enabled = $false; $miRestart.Enabled = $true
  } else {
    $tray.Icon = $iconOff
    $tray.Text = '5K Bot: PARADO'
    $miStatus.Text = 'Status: PARADO'
    $miStop.Enabled = $false; $miStart.Enabled = $true; $miRestart.Enabled = $false
  }
  if ($script:lastOnline -ne $null -and $script:lastOnline -and -not $state.online -and (Get-Date) -gt $script:suppressToastUntil) {
    Show-TrayBalloon '5K Bot' 'O bot parou inesperadamente. Clique com o botão direito para Iniciar.'
    Write-TrayLog 'bot parou inesperadamente (toast exibido)'
  }
  $script:lastOnline = $state.online
}

function Suppress-Toast {
  $script:suppressToastUntil = (Get-Date).AddSeconds(30)
}

function On-StopClicked {
  try {
    Stop-Bot
    Write-TrayLog 'Parar bot: ok (estado persistido p/ o boot)'
    Suppress-Toast
  } catch {
    Show-TrayBalloon '5K Bot: erro' $_.Exception.Message
    Write-TrayLog "Parar bot FALHOU: $($_.Exception.Message)"
  }
  Update-State
}

function On-StartClicked {
  try {
    Start-Bot
    Write-TrayLog 'Iniciar bot: ok (estado persistido p/ o boot)'
    Suppress-Toast
  } catch {
    Show-TrayBalloon '5K Bot: erro' $_.Exception.Message
    Write-TrayLog "Iniciar bot FALHOU: $($_.Exception.Message)"
  }
  Update-State
}

function On-RestartClicked {
  try {
    Restart-Bot
    Write-TrayLog 'Reiniciar bot: ok'
    Suppress-Toast
  } catch {
    Show-TrayBalloon '5K Bot: erro' $_.Exception.Message
    Write-TrayLog "Reiniciar bot FALHOU: $($_.Exception.Message)"
  }
  Update-State
}

function On-LogClicked {
  try {
    if (Test-Path -LiteralPath $RepoLog) { Start-Process notepad.exe -ArgumentList "`"$RepoLog`"" }
    else { Show-TrayBalloon '5K Bot' 'Arquivo de log ainda não existe.' }
  } catch {
    Show-TrayBalloon '5K Bot: erro' $_.Exception.Message
  }
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
    try { Stop-Bot; Write-TrayLog 'Parar bot (na saída): ok' }
    catch { Write-TrayLog "Parar bot (na saída) FALHOU: $($_.Exception.Message)" }
  }
  Write-TrayLog 'tray encerrado pelo usuário'
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
}

$tray.Add_DoubleClick({
  $s = Get-BotState
  if ($s -eq $null) { Show-TrayBalloon '5K Bot' 'Verificando... tente de novo em instantes.' }
  elseif ($s.online) { Show-TrayBalloon '5K Bot' "Rodando (pid $($s.pid)). Botão direito p/ opções." }
  else { Show-TrayBalloon '5K Bot' 'Parado. Botão direito > Iniciar bot.' }
})

Update-State
Write-TrayLog 'tray iniciado (5k-bot)'

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({ Update-State })
$timer.Start()

[System.Windows.Forms.Application]::Run()
