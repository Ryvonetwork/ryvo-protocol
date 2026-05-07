@echo off
setlocal

set "WSL_REPO=/home/heis/ryvo/ryvo-protocol"
set "WINDOW_TITLE=Ryvo Network Demo"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath cmd.exe -WorkingDirectory '\\wsl$\Ubuntu\home\heis\ryvo\ryvo-protocol' -ArgumentList '/k','title %WINDOW_TITLE% && wsl.exe -d Ubuntu -- bash -lc ""cd %WSL_REPO% && ./scripts/ryvo-protocol-demo.sh""'"
