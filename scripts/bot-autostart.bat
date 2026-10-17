@echo off
rem Se lançado com janela visível (tarefa agendada), relança minimizado e sai.
if not "%1"=="min" (start /min "" "%~f0" min & exit /b)
rem Restaura o bot 5k (pm2 resurrect) no logon — ver dump em %USERPROFILE%\.pm2\dump.pm2
cd /d D:\GitHub\5K-CSGO-YOUTUBE
call "C:\Program Files\nodejs\pm2.cmd" resurrect >> logs\pm2-autostart.log 2>&1
rem Ícone na bandeja (tray) p/ parar/iniciar o bot — processo separado, instância única
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bot-tray.ps1" >> logs\pm2-autostart.log 2>&1
