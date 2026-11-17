@echo off
rem Double-clic : installe tout la premiere fois, puis ouvre ChessPrac.
cd /d "%~dp0"
set "PYDIR=%LOCALAPPDATA%\Programs\Python\Python312"

if exist ".venv\Scripts\python.exe" goto deps

call :find_python
if not defined PYEXE goto no_python

echo Premiere installation : creation de l'environnement Python...
"%PYEXE%" %PYARGS% -m venv .venv
if not exist ".venv\Scripts\python.exe" goto no_python

:deps
if exist ".venv\Lib\site-packages\webview" if exist ".venv\Lib\site-packages\chess" goto run
echo Installation des dependances, 1 a 2 minutes...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto deps_failed

:run
rem Stockfish (~100 Mo) n'est pas dans le depot GitHub : on telecharge la version officielle une seule fois.
if not exist "engine\stockfish.exe" ".venv\Scripts\python.exe" tools\get_stockfish.py
if not exist "engine\stockfish.exe" (
    echo Stockfish n'a pas pu etre telecharge. Telecharge-le sur https://stockfishchess.org/download/
    echo puis place le fichier .exe dans le dossier engine sous le nom stockfish.exe, et relance.
    pause
    exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" tools\fenetre.pyw
exit /b

:find_python
set "PYEXE="
set "PYARGS="
py -3 --version >nul 2>nul && (set "PYEXE=py" & set "PYARGS=-3" & exit /b)
python --version >nul 2>nul && (set "PYEXE=python" & exit /b)
if exist "%PYDIR%\python.exe" set "PYEXE=%PYDIR%\python.exe"
exit /b

:no_python
echo.
echo Python est introuvable. Installe Python 3.12 depuis la page qui vient de s'ouvrir,
echo en cochant "Add python.exe to PATH" en bas de la premiere fenetre, puis relance ce fichier.
start "" https://www.python.org/downloads/
pause
exit /b 1

:deps_failed
echo L'installation des dependances a echoue (connexion internet ?).
pause
exit /b 1
