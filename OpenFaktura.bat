@echo off
title OpenFaktura
cd /d "%~dp0"
echo Spoustim OpenFaktura...
"%~dp0runtime\win\node.exe" "%~dp0server.js"
echo.
echo OpenFaktura byla ukoncena. Toto okno muzete zavrit.
pause >nul
