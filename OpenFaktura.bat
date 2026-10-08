@echo off
title Fakturator
cd /d "%~dp0"
:start
echo Spoustim Fakturator...
"%~dp0runtime\win\node.exe" "%~dp0server.js"
rem navratovy kod 75 = server se po aktualizaci chce restartovat
if %errorlevel%==75 goto start
echo.
echo Fakturator byl ukoncen. Toto okno muzete zavrit.
pause >nul
