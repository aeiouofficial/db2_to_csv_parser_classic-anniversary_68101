@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   DB2 -^> CSV Parser  ^|  Classic Anniversary build 68101
echo ============================================================
echo.

REM --- Node vorhanden? ---
where node >nul 2>nul
if errorlevel 1 (
  echo [FEHLER] Node.js nicht gefunden. Bitte Node 18+ installieren:
  echo          https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo Node: !NODEVER!
echo.

REM --- Abhaengigkeiten + Patch ---
if not exist "node_modules\" (
  echo node_modules fehlt - installiere Abhaengigkeiten ^(wendet Patch via postinstall an^)...
  call npm install
  if errorlevel 1 (
    echo [FEHLER] npm install fehlgeschlagen.
    pause
    exit /b 1
  )
) else (
  echo node_modules vorhanden - ueberspringe Installation.
)
echo.

:menu
echo ------------------------------------------------------------
echo   Was moechtest du tun?
echo ------------------------------------------------------------
echo   [1] Voll-Export : alle Tabellen    -^> assets\db\68101\
echo   [2] Smoke-Test  : nur liquidtype   ^(schnell^)
echo   [3] Verify      : Inventory + Budgets pruefen
echo   [4] Inventory   : Tabellen-Inventory neu vom CDN bauen
echo   [0] Beenden
echo.
set "choice="
set /p "choice=Auswahl: "

if "!choice!"=="1" goto run_export
if "!choice!"=="2" goto run_smoke
if "!choice!"=="3" goto run_verify
if "!choice!"=="4" goto run_inventory
if "!choice!"=="0" goto end
echo Ungueltige Auswahl.
echo.
goto menu

:run_export
call npm run export:verbose
goto done

:run_smoke
call npm run export:liquidtype
goto done

:run_verify
call npm run verify
goto done

:run_inventory
call npm run inventory
goto done

:done
echo.
echo Fertig.
echo.
pause
goto menu

:end
endlocal
