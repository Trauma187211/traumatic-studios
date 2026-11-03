@echo off
rem Makes the studio's research division start quietly when you sign in to Windows (no admin needed).
rem Run again to refresh. Use "remove-background-research.bat" to undo.
setlocal
set "HERE=%~dp0"
set "NODE=%HERE%runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\TraumaticStudiosResearch.vbs"
> "%VBS%" echo Set sh = CreateObject("WScript.Shell")
>> "%VBS%" echo sh.CurrentDirectory = "%HERE%"
>> "%VBS%" echo sh.Run """%NODE%"" research-daemon.js", 0, False
wscript "%VBS%"
echo Background research is installed and running. It will start at every sign-in.
pause
