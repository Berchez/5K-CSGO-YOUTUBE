@echo off
rem Se lancado com janela visivel (tarefa agendada), relanca minimizado e sai.
if not "%1"=="min" (start /min "" "%~f0" min & exit /b)
rem Raiz do repo = pasta pai de scripts\ (nao depende da letra do drive).
cd /d "%~dp0.."
rem Restaura o bot 5k (pm2 resurrect) no logon — ver dump em %USERPROFILE%\.pm2\dump.pm2
rem pm2 global do npm fica em %APPDATA%\npm; fallback para a instalacao em Program Files.
set "PM2=%APPDATA%\npm\pm2.cmd"
if not exist "%PM2%" set "PM2=%ProgramFiles%\nodejs\pm2.cmd"
if exist "%PM2%" (
  call "%PM2%" resurrect >> logs\pm2-autostart.log 2>&1
) else (
  echo [%date% %time%] pm2 nao encontrado >> logs\pm2-autostart.log
)
rem Icone na bandeja (tray) p/ parar/iniciar o bot — processo separado, instancia unica
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bot-tray.ps1" >> logs\pm2-autostart.log 2>&1
