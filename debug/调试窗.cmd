@echo off
setlocal
title sense-now ���Դ�
cd /d "%~dp0.."

rem ---- �� node���ȿ� PATH�����Ա����̶���װλ�� ----
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto :nodeOk
if exist "D:\Nodejs\node.exe" (
  set "NODE=D:\Nodejs\node.exe"
  goto :nodeOk
)
echo.
echo   û�ҵ� node������װ Node.js�����߰����ӵ� PATH �
echo.
pause
exit /b 1

:nodeOk
rem ---- ֱ�Ӱ��ļ��ϵ����ͼ���� = ���Ǹ���Ƶ ----
if not "%~1"=="" goto :fromArg

echo.
echo   ==================================================
echo     sense-now ���Դ���������ץ����Щ֡����ô�Ž�ͼ
echo   ==================================================
echo.
echo      [1] ����ǰ��Ļ         ֱ�ӻس�����
echo      [2] ��һ����Ƶ�ļ�     ���ļ��Ͻ������ٻس�
echo.
set "PICK="
set /p PICK=     ���ѡ��:

if not defined PICK goto :useScreen
if "%PICK%"=="1" goto :useScreen
if "%PICK%"=="2" goto :askFile
set "PICK=%PICK:"=%"
goto :useFile

:askFile
echo.
echo      ����Ƶ�ļ��ϵ����棬Ȼ��س���
set "PICK="
set /p PICK=
if not defined PICK goto :useScreen
set "PICK=%PICK:"=%"
goto :useFile

:fromArg
set "PICK=%~1"
set "PICK=%PICK:"=%"

:useFile
if not exist "%PICK%" (
  echo.
  echo      �Ҳ�������ļ���%PICK%
  echo.
  pause
  exit /b 1
)
echo.
echo      ���ڴ򿪣�%PICK%
echo      ����ڴ��ڱ�أ��ص��͵���ֹͣ�ɼ���
echo.
"%NODE%" debug\live.mjs --source=file --file="%PICK%" --realtime=1 %2 %3 %4 %5 %6 %7
goto :done

:useScreen
echo.
echo      ���ڿ���Ļ������ڴ��ڱ�أ��ص��͵���ֹͣ�ɼ���
echo.
"%NODE%" debug\live.mjs --source=screen %2 %3 %4 %5 %6 %7

:done
echo.
echo      �ɼ��Ѿ�ͣ�ˡ���������ص�����ڴ��ڡ�
pause >nul
endlocal
