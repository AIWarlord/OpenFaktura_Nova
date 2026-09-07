@echo off
title OpenFaktura
cd /d "%~dp0"
:start
echo Spoustim OpenFaktura...
"%~dp0runtime\win\node.exe" "%~dp0server.js"
rem navratovy kod 75 = server se po aktualizaci chce restartovat
if %errorlevel%==75 goto start
echo.
echo OpenFaktura byla ukoncena. Toto okno muzete zavrit.
pause >nul
