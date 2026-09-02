@echo off
chcp 932 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  体調記録カレンダー 更新スクリプト（Windows / NSSM 用）
rem
rem  使い方: このファイルを右クリック →「管理者として実行」
rem
rem  サービスを止めて、データベースをバックアップし、最新版を
rem  取得して依存関係を入れ直し、サービスを起動し直します。
rem
rem  サービス名やポートを変えている場合は、このファイルではなく
rem  update.local.bat を同じフォルダに作って、そこに
rem      set "SERVICE=別のサービス名"
rem      set "PORT=8080"
rem  と書いてください。このファイルを書き換えると git pull が
rem  できなくなります。
rem ============================================================

set "SERVICE=HealthCalendar"
set "PORT=3100"

cd /d "%~dp0"

if exist "update.local.bat" call "update.local.bat"

echo ============================================
echo  体調記録カレンダー 更新
echo  フォルダ: %CD%
echo  サービス: %SERVICE%
echo ============================================
echo.

rem ---- 事前チェック: 管理者権限 ----
net session >nul 2>&1
if errorlevel 1 (
    echo [エラー] 管理者権限がありません。
    echo         update.bat を右クリックして
    echo         「管理者として実行」を選んでください。
    goto :fail
)

rem ---- 事前チェック: nssm ----
where nssm >nul 2>&1
if errorlevel 1 (
    echo [エラー] nssm が見つかりません。
    echo         winget install nssm でインストールしてください。
    goto :fail
)

rem ---- 事前チェック: サービスの存在 ----
sc query "%SERVICE%" >nul 2>&1
if errorlevel 1 (
    echo [エラー] サービス "%SERVICE%" が見つかりません。
    echo         サービス名が違う場合は update.local.bat に
    echo         set "SERVICE=..." と書いてください。
    goto :fail
)

rem ---- 事前チェック: git ----
where git >nul 2>&1
if errorlevel 1 (
    echo [エラー] git が見つかりません。
    echo         ZIPで導入した場合は、この方法では更新できません。
    echo         新しいZIPを展開し、health-app.db を引き継いでください。
    goto :fail
)

rem ---- 事前チェック: 作業ツリーが綺麗か ----
set "DIRTY="
for /f "delims=" %%i in ('git status --porcelain 2^>nul') do set "DIRTY=1"
if defined DIRTY (
    echo [エラー] このフォルダに未コミットの変更があります。
    echo         git status で内容を確認してください。
    echo         package-lock.json だけが変更されている場合は
    echo         git checkout -- package-lock.json で戻せます。
    goto :fail
)

echo [1/5] サービスを停止します...
nssm stop "%SERVICE%" >nul 2>&1

set "STOPPED="
for /l %%i in (1,1,15) do (
    if not defined STOPPED (
        sc query "%SERVICE%" | find "STOPPED" >nul && set "STOPPED=1"
        if not defined STOPPED ping -n 2 127.0.0.1 >nul
    )
)
if not defined STOPPED (
    echo [エラー] サービスを停止できませんでした。
    echo         サービス画面から手動で停止してから
    echo         再実行してください。
    goto :fail
)
echo       停止しました。
echo.

echo [2/5] データベースをバックアップします...
if not exist "health-app.db" (
    echo [警告] health-app.db が見つかりません。
    echo        NSSM で DB_PATH を設定している場合は、その場所の
    echo        ファイルを手動でバックアップしてください。
    echo.
    choice /c YN /n /m "バックアップなしで続行しますか？ [Y/N] "
    if errorlevel 2 goto :restart_and_fail
    echo.
    goto :pull
)

if not exist "backups" mkdir "backups"
set "TS="
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
if not defined TS (
    echo [エラー] 日時の取得に失敗しました。
    goto :restart_and_fail
)

rem ジャーナルが残っている場合もあるので health-app.db* をまとめて退避する
set "BKERR="
for %%f in ("health-app.db*") do (
    copy /y "%%~f" "backups\%%~nf-!TS!%%~xf" >nul || set "BKERR=1"
)
if defined BKERR (
    echo [エラー] バックアップに失敗しました。更新を中止します。
    goto :restart_and_fail
)
echo       backups\health-app-!TS!.db に保存しました。

rem 古いバックアップは最新20件だけ残す
for /f "skip=20 delims=" %%f in ('dir /b /o-d "backups\health-app-*.db" 2^>nul') do del "backups\%%f" >nul 2>&1
for /f "skip=20 delims=" %%f in ('dir /b /o-d "backups\health-app-*.db-journal" 2^>nul') do del "backups\%%f" >nul 2>&1
echo.

:pull
echo [3/5] 最新版を取得します...
set "OLDREV="
for /f %%i in ('git rev-parse HEAD') do set "OLDREV=%%i"
git pull --ff-only
if errorlevel 1 (
    echo [エラー] git pull に失敗しました。
    echo         ネットワークとブランチの状態を確認してください。
    goto :restart_and_fail
)
echo.

echo [4/5] 依存関係を更新します...
call npm install
if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    goto :rollback_and_fail
)
rem npm のバージョン差で package-lock.json が書き換わると
rem 次回の実行が「未コミットの変更あり」で止まるため元に戻す
git checkout -- package-lock.json >nul 2>&1
echo.

echo [5/5] サービスを起動します...
nssm start "%SERVICE%" >nul 2>&1

set "RUNNING="
for /l %%i in (1,1,15) do (
    if not defined RUNNING (
        sc query "%SERVICE%" | find "RUNNING" >nul && set "RUNNING=1"
        if not defined RUNNING ping -n 2 127.0.0.1 >nul
    )
)
if not defined RUNNING (
    echo [エラー] サービスが起動しませんでした。
    echo         service-error.log を確認してください。
    goto :backup_hint
)

rem 画面が出るところまで確認する
set "ALIVE="
for /l %%i in (1,1,10) do (
    if not defined ALIVE (
        powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:%PORT%/' -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" && set "ALIVE=1"
        if not defined ALIVE ping -n 2 127.0.0.1 >nul
    )
)
if not defined ALIVE (
    echo [警告] サービスは起動しましたが、
    echo        http://localhost:%PORT%/ から応答がありません。
    echo        service-error.log を確認してください。
    goto :backup_hint
)

echo.
echo ============================================
echo  更新が完了しました。
echo  http://localhost:%PORT%/ を開いて確認してください。
echo ============================================
echo.
pause
exit /b 0

rem ---- 依存関係の更新に失敗: コードごと元に戻してから起動する ----
:rollback_and_fail
echo.
echo 更新前の状態に戻します...
if not defined OLDREV goto :norollback
git reset --hard "!OLDREV!"
if errorlevel 1 goto :norollback
call npm install
if errorlevel 1 goto :norollback
nssm start "%SERVICE%" >nul 2>&1
echo 元のバージョンで起動し直しました。
goto :backup_hint

:norollback
echo [重要] 元に戻せませんでした。サービスは停止したままです。
echo        壊れたまま起動するとデータに影響するため、
echo        意図的に起動していません。
echo        ネットワークを確認してから update.bat を
echo        もう一度実行してください。
goto :backup_hint

rem ---- 更新前の失敗: サービスだけ元に戻す ----
:restart_and_fail
echo.
echo 更新を中止し、サービスを起動し直します...
nssm start "%SERVICE%" >nul 2>&1

:backup_hint
echo.
echo 記録を戻したい場合は、backups フォルダの
echo いちばん新しいファイルを使ってください。
echo   nssm stop %SERVICE%
echo   copy backups\health-app-^<日時^>.db health-app.db
echo   nssm start %SERVICE%

:fail
echo.
echo 更新は完了していません。
echo.
pause
exit /b 1
