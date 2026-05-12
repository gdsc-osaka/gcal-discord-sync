# gcal-discord-sync

[![CI / CD](https://github.com/gdsc-osaka/gcal-discord-sync/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/gdsc-osaka/gcal-discord-sync/actions/workflows/ci-cd.yml)

Google カレンダーの予定を Discord の Guild Scheduled Event (External) として自動的にミラーリングし、
イベント開始/終了時刻ぴったりに **ACTIVE / COMPLETED** へ遷移させて、Discord サーバ上に「開催中」を表示するための Google Apps Script ツールです。

GDG on Campus Osaka コミュニティのイベント告知運用を想定して作られています。

## アーキテクチャ概要

3 種類のトリガーで動きます。

| トリガー | 役割 | 頻度 |
|---|---|---|
| `incrementalSync` | GCal の `nextSyncToken` を使って変更分だけ取り込む。直近 5 分以内に start/end を迎える分のワンショットトリガーを再配置 | 5 分ごと |
| `transitionOne` | start / end 時刻ぴったりに発火し、SCHEDULED → ACTIVE → COMPLETED を反映 | ワンショット（自動設置） |
| `fullReconcile` | 全件突合で取りこぼし・sync token 失効を補正 | 1 日 1 回（03:00 JST） |

詳しい設計は `C:\Users\itako\.claude\plans\google-discord-partitioned-avalanche.md` を参照。

## セットアップ

> [!IMPORTANT]
> GAS の `UrlFetchApp` は `User-Agent` を上書きできない仕様で
> ([Issue Tracker #36758197](https://issuetracker.google.com/issues/36758197))、
> GAS のデフォルト UA は Discord の Cloudflare WAF に **HTTP 403 / code 40333
> "internal network error"** で弾かれます
> ([discord-api-docs #6473](https://github.com/discord/discord-api-docs/issues/6473))。
> 本リポジトリは `worker/` 配下に **Cloudflare Worker のリレー** を同梱し、
> 適切な User-Agent (`DiscordBot (<URL>, <ver>)`) に書き換えた上で
> `discord.com` に転送します。Worker を先にデプロイしてから、GAS の
> Script Properties `PROXY_URL` (任意で `PROXY_SECRET`) を設定してください。

### 1. Discord 側の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** → 名前を入力
2. 左サイドの **Bot** タブ → **Reset Token** で Bot Token を取得（あとで `DISCORD_BOT_TOKEN` に設定）
3. **OAuth2 → URL Generator** で次を選択し、生成された URL を踏んで対象 Guild に Bot を招待:
   - Scopes: `bot`
   - Bot Permissions: `Create Events`
4. 対象 Discord サーバの ID を控える（あとで `DISCORD_GUILD_ID` に設定）。サーバ設定で **開発者モード** を有効化するとサーバ名右クリックから ID をコピーできます。

### 2. Cloudflare Worker リレーをデプロイ

詳細は [`worker/README.md`](worker/README.md)。手早くは:

```powershell
cd worker
npm install
npx wrangler login              # 初回のみ
npx wrangler deploy             # *.workers.dev に公開
# (任意) 共有秘密を設定
npx wrangler secret put PROXY_SECRET
cd ..
```

デプロイ完了時の URL（例: `https://gcal-discord-sync-relay.<sub>.workers.dev`）
を控えておきます。

### 3. ローカル開発環境

```powershell
npm install
npm run typecheck   # 型チェック
npm test            # ロジック単体テスト
npm run build       # webpack で dist/Code.js と dist/appsscript.json を生成
```

### 4. Apps Script プロジェクトと接続

```powershell
npx clasp login
npx clasp create --type standalone --title "gcal-discord-sync" --rootDir dist
# .clasp.json が生成されます（gitignore 済み）。.clasp.json.example を参考に手動配置でも OK
npm run push        # build → clasp push
```

`clasp create` のかわりに既存スクリプトに接続したい場合は `npx clasp clone <scriptId> --rootDir dist`。

### 5. Script Properties を設定

Apps Script エディタを開き、左サイド **プロジェクトの設定 → スクリプト プロパティ** で以下を追加:

| キー | 必須 | 値 |
|---|---|---|
| `CALENDAR_ID` | ◯ | 同期元カレンダー ID（例: `xxxxx@group.calendar.google.com`） |
| `DISCORD_GUILD_ID` | ◯ | Discord サーバ ID |
| `DISCORD_BOT_TOKEN` | ◯ | Bot Token |
| `PROXY_URL` | ◯ | Cloudflare Worker URL（手順 2 で表示された `https://...workers.dev`） |
| `PROXY_SECRET` | △ | Worker に共有秘密を入れた場合のみ。Worker と GAS の両方で同一値 |
| `DEFAULT_LOCATION` | | GCal `location` 空欄時の埋め草（デフォルト `Online`） |
| `HORIZON_DAYS` | | 同期する未来日数（デフォルト 30） |

> `SYNC_TOKEN` と `MAPPINGS` はスクリプトが自動管理します。手で触らないでください。

### 6. トリガー登録 & 初期同期

Apps Script エディタの関数選択で `installTriggers` を選び、▶ 実行。初回は OAuth 同意ダイアログが出るので承認してください。
内部で `fullReconcile` が一度走り、sync token と Discord 側イベントの初期状態が揃います。

以降は 5 分ごとの `incrementalSync` と日次 `fullReconcile` が自動で走ります。

## 自動デプロイ（GitHub Actions）

`main` ブランチに push されたタイミングで自動的に `clasp push` する CI/CD が `.github/workflows/ci-cd.yml` に設定されています。PR ではビルド・型チェック・テストだけが走ります。

### 必要な GitHub Secrets

| Secret | 内容 |
|---|---|
| `CLASPRC_JSON` | ローカルで `clasp login` 後に作られる `~/.clasprc.json` の中身（OAuth refresh token を含む） |
| `CLASP_JSON` | このリポジトリ直下に作られる `.clasp.json` の中身（`scriptId` と `rootDir`） |

### 取得・登録手順

1. ローカルで一度デプロイまで動かす（`npx clasp login` → `npx clasp create ...` → `npm run push`）と、両ファイルが手元に揃います。
2. それぞれの **JSON 全文** を GitHub の **Settings → Secrets and variables → Actions → New repository secret** で登録します。

   PowerShell:
   ```powershell
   gh secret set CLASPRC_JSON --body (Get-Content $HOME/.clasprc.json -Raw)
   gh secret set CLASP_JSON   --body (Get-Content .clasp.json -Raw)
   ```

   bash / zsh:
   ```bash
   gh secret set CLASPRC_JSON < ~/.clasprc.json
   gh secret set CLASP_JSON   < .clasp.json
   ```

3. 以降は `main` への push で自動デプロイされます。GitHub Actions タブでログを確認してください。

### Secrets の運用上の注意

- `~/.clasprc.json` は **長期有効な refresh token** を含みます。漏洩した場合は [Google アカウント → セキュリティ → サードパーティのアクセス](https://myaccount.google.com/permissions) から **Apps Script CLI** を取り消し、`clasp login` で再発行してください。Secret も忘れず更新します。
- リポジトリを Public にしても Secrets はリポジトリの管理者しか読めません。ただし fork した PR からは `secrets` が参照できないため、外部コントリビュータの PR では自動デプロイは走りません（CI 検証のみ）。
- 二人以上で運用する場合は GitHub Environment **production** に承認ルールを付けると、main マージ後にレビュアーが承認するまでデプロイを止められます。

## 動作確認

1. 同期元カレンダーに **10 分後開始 / 5 分間** のテストイベントを作成
2. Apps Script エディタで `incrementalSync` を手動実行 → Discord に「予定」として出現することを確認
3. **トリガー** 画面で `transitionOne` のワンショットが 1 件予約されていることを確認
4. 10 分後の開始時刻に `transitionOne` が発火 → Discord 側で「ライブ」バナーが表示される
5. 15 分後の終了時刻に `transitionOne` が再発火 → バナーが消える
6. カレンダーでイベントを削除 → 次回の `incrementalSync` で Discord 側が CANCELED に

## 仕組みの細かい話

- **ハッシュベースの差分検出**: `name + start + end + location + description` の SHA-1 で内容変更を検知。実質的に変わっていない `updated` 通知では PATCH を発射しません。
- **トリガー上限の保護**: GAS の上限 20 個に達しないよう、ワンショットは最大 15 個まで。超過分は次の `incrementalSync` で受け持ちます（最悪 5 分遅延）。
- **取りこぼし耐性**: `incrementalSync` の中で「過ぎている `nextTransitionAt`」も改めてスキャンするので、ワンショットが失敗しても次回の 5 分実行で必ず追いつきます。
- **sync token 失効**: `Calendar.Events.list` が 410 を返したら自動で `fullReconcile` に切り替え、新しいトークンを再取得します。
- **繰り返しイベント**: `singleEvents: true` で各インスタンスに展開され、`id` が一意に振られるためそのままキーになります。

## 開発

```powershell
npm test            # Jest
npm run lint        # ESLint
npm run format      # Prettier
npm run typecheck   # tsc --noEmit
```

`src/sync.ts` は GAS の API に依存しない純粋関数で書いているため、Jest のみで網羅的にテストできます。GAS 固有の I/O (`Calendar`, `UrlFetchApp`, `PropertiesService`, `ScriptApp`) は `calendar.ts` / `discord.ts` / `storage.ts` / `main.ts` に閉じ込めています。

## ライセンス

未定（コミュニティ運用ツールなのでこのリポジトリ内での利用を想定）。
