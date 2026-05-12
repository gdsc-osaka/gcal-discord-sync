# gcal-discord-sync-relay (Cloudflare Worker)

`UrlFetchApp` から Discord API を直接叩くと、GAS 側で `User-Agent` が
`Mozilla/5.0 (compatible; Google-Apps-Script; ...)` に固定され、Discord 側の
Cloudflare WAF に **HTTP 403 / code 40333** で弾かれます。

この Worker は GAS からの全リクエストを受け取り、`DiscordBot (<URL>, <ver>)`
形式の User-Agent に書き換えてから `https://discord.com` に転送する薄いリレー
です。

## デプロイ

```powershell
cd worker
npm install
npx wrangler login            # 初回のみ
npx wrangler deploy           # *.workers.dev に公開
```

デプロイ完了時に `https://gcal-discord-sync-relay.<your-subdomain>.workers.dev`
の URL が表示されます。これを GAS の Script Properties `PROXY_URL` に設定し
ます。

## (任意) 共有シークレットの設定

Worker URL が漏れたときに第三者が好き勝手リクエストを通せないよう、共有秘密で
保護できます:

```powershell
npx wrangler secret put PROXY_SECRET
# 適当なランダム文字列を入力 (例: openssl rand -hex 32 の出力など)
```

設定すると Worker は `X-Proxy-Secret` ヘッダの一致チェックを行うようになり、
不一致は 401 を返します。GAS 側にも同じ値を Script Properties `PROXY_SECRET`
に入れてください。

## ローカル動作確認

```powershell
npx wrangler dev
# 別ターミナルから
curl -i http://127.0.0.1:8787/api/v10/users/@me -H "Authorization: Bot <YOUR_BOT_TOKEN>"
```

`200` で Bot の自己情報 JSON が返れば疎通 OK です。

## 監視

```powershell
npx wrangler tail
```

リアルタイムでアクセスログを流せます。WAF にまた弾かれていないか確認するのに
便利です。
