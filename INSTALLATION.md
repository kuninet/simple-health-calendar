# インストールガイド

Simple Health Calendar の詳細なインストール手順です。
基本セットアップに加えて、PC起動時に自動で立ち上げる「サービス化」の手順
（Windows / macOS / Linux）を載せています。

## 📋 システム要件

- **Node.js**: 20.17.0 以上
- **npm**: Node.js に同梱
- **OS**: Windows 10/11, macOS 12+, Linux（systemd採用ディストリビューション）
- **ブラウザ**: Chrome, Edge, Safari, Firefox の最新版

## 🚀 基本セットアップ

### 1. Node.js のインストール

#### Windows
1. [Node.js 公式サイト](https://nodejs.org/) から LTS版インストーラー（.msi）をダウンロード
2. インストーラーを実行（基本は「次へ」でOK）
3. PowerShell で確認：

```powershell
node --version
```

#### macOS

```bash
# Homebrew を使用する場合
brew install node

# または公式サイトからインストーラーをダウンロード
```

### 2. プロジェクトの取得

```bash
git clone https://github.com/kuninet/simple-health-calendar.git
cd simple-health-calendar
```

Git がない場合は、GitHub リポジトリページの「Code」→「Download ZIP」で
ZIPを展開し、そのフォルダで作業してください。

### 3. 依存関係のインストールと起動

```bash
npm install
npm start
```

`体調記録カレンダー: http://localhost:3100` と表示されたら、
ブラウザで http://localhost:3100 を開いてください。
データベース（`health-app.db`）は初回起動時に自動で作成されます。

⚠️ `node install` ではなく `npm install` です（間違えやすいので注意）。

### ポートの変更

デフォルトは **3100** です（エクササイズカレンダーと同居できるように
3000 を避けています）。変更する場合：

```bash
# macOS / Linux
PORT=8080 npm start
```

```powershell
# Windows (PowerShell)
$env:PORT=8080; npm start
```

### スマホなど家庭内LANからのアクセス

1. サーバーPCのIPアドレスを調べる（Windows: `ipconfig` / macOS: `ipconfig getifaddr en0`）
2. スマホのブラウザで `http://<PCのIP>:3100` を開く
3. 「ホーム画面に追加」でPWAアプリとしてインストールできます

Windows は初回起動時にファイアウォールの許可ダイアログが出るので、
**「プライベートネットワーク」にチェックして許可**してください。

> ⚠️ 本アプリに認証はありません。家庭内LANの外には公開しないでください
> （詳しくは README の「セキュリティについて」参照）。

## 🖥️ サービス化（PC起動時に自動起動）

### Windows: NSSM を使う

[NSSM](https://nssm.cc/) を使ってWindowsサービスとして登録します。
**管理者として開いた PowerShell** で実行してください。

```powershell
# 1. NSSM のインストール（終わったらPowerShellを開き直す）
winget install nssm

# 2. サービス登録（パスは環境に合わせて読み替え）
nssm install HealthCalendar "C:\Program Files\nodejs\node.exe" "C:\Users\<ユーザー名>\git\simple-health-calendar\server.js"
nssm set HealthCalendar AppDirectory "C:\Users\<ユーザー名>\git\simple-health-calendar"
nssm set HealthCalendar DisplayName "体調記録カレンダー"
nssm set HealthCalendar Description "体調記録カレンダー (http://localhost:3100)"

# 3. ログ出力とポート指定（任意）
nssm set HealthCalendar AppStdout "C:\Users\<ユーザー名>\git\simple-health-calendar\service.log"
nssm set HealthCalendar AppStderr "C:\Users\<ユーザー名>\git\simple-health-calendar\service-error.log"
nssm set HealthCalendar AppEnvironmentExtra PORT=3100

# 4. 起動
nssm start HealthCalendar
```

`node.exe` の場所が違う場合は `(Get-Command node).Source` で確認してください。
スタートアップ種別は既定で「自動」になるので、以後はPC起動時に立ち上がります。

管理コマンド：

```powershell
nssm stop HealthCalendar       # 停止
nssm restart HealthCalendar    # 再起動（git pull で更新した後など）
nssm edit HealthCalendar       # 設定GUIを開く
nssm remove HealthCalendar confirm  # サービス削除
```

### macOS: launchd を使う

macOS には launchd という標準の仕組みがあります。
`~/Library/LaunchAgents/com.kuninet.health-calendar.plist` を作成します
（パスとユーザー名は環境に合わせて読み替え）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kuninet.health-calendar</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/<ユーザー名>/git/simple-health-calendar/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/<ユーザー名>/git/simple-health-calendar</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/<ユーザー名>/git/simple-health-calendar/service.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/<ユーザー名>/git/simple-health-calendar/service-error.log</string>
</dict>
</plist>
```

`node` の場所は `which node` で確認してください
（Homebrew の場合、Apple Silicon は `/opt/homebrew/bin/node`、
Intel Mac は `/usr/local/bin/node`）。

登録と起動：

```bash
launchctl load ~/Library/LaunchAgents/com.kuninet.health-calendar.plist
```

管理コマンド：

```bash
# 停止（登録解除）
launchctl unload ~/Library/LaunchAgents/com.kuninet.health-calendar.plist

# 再起動（git pull で更新した後など）
launchctl unload ~/Library/LaunchAgents/com.kuninet.health-calendar.plist
launchctl load ~/Library/LaunchAgents/com.kuninet.health-calendar.plist

# 状態確認
launchctl list | grep health-calendar
```

※ LaunchAgent はログイン中のみ動作します。ログインしていなくても
動かしたい場合は `/Library/LaunchDaemons/` に置いて
`sudo launchctl load` してください（ファイルの所有者を root にする必要があります）。

### Linux: systemd を使う

`/etc/systemd/system/health-calendar.service` を作成：

```ini
[Unit]
Description=体調記録カレンダー
After=network.target

[Service]
Type=simple
User=<ユーザー名>
WorkingDirectory=/home/<ユーザー名>/git/simple-health-calendar
ExecStart=/usr/bin/node /home/<ユーザー名>/git/simple-health-calendar/server.js
Restart=on-failure
Environment=PORT=3100

[Install]
WantedBy=multi-user.target
```

登録と起動：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now health-calendar

# 状態確認 / 再起動
systemctl status health-calendar
sudo systemctl restart health-calendar
```

## 🔧 トラブルシューティング

### `Cannot find module '...\install'` と出る

`node install` と入力しています。正しくは `npm install` です。

### ポート 3100 が使用中

別のアプリが使っている場合は、上記「ポートの変更」の手順で
別のポートを指定してください。

### サービス化後にアプリを更新したい

```bash
git pull
npm install
```

のあと、サービスを再起動してください
（Windows: `nssm restart HealthCalendar` / macOS: launchctl unload → load /
Linux: `sudo systemctl restart health-calendar`）。

### データのバックアップ

記録はすべてアプリフォルダ内の `health-app.db` に入っています。
このファイルをコピーすればバックアップ完了です。
`http://localhost:3100/api/export` からJSON形式でも取得できます。
