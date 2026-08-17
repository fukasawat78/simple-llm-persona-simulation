# Persona Churn Lab

モバイル契約者のペルソナCSVを読み込み、1人ずつLLMで解約判定するHuman-in-the-loopシミュレーションアプリです。

## エージェント設計

ワークフローを5つの専門責務に分けています。

1. **Data Curator** — CSVの必須11カラムを検証し、判定用ペルソナへ整形
2. **Prompt Architect** — 分析目的、期間、注意点、ドメイン知識から共通プロンプトを生成し、作業者の自然言語フィードバックで改善
3. **Sequential Judge** — ペルソナを混ぜず、1件につき1回のAPIリクエストで逐次判定
4. **Review Curator** — 全結果からランダムに10件を抽出して、ペルソナ・判定・理由・確信度を提示
5. **Insight Analyst** — 全体の解約率と主要ドライバーを集計し、CSVを出力

実行時は1つのオーケストレーターが各責務を順番に進めます。判定エージェントを並列化しないことで、API負荷を制御しつつ「1人ずつ逐次判定」という要件を保っています。

## 起動

Node.js 20以上だけで動作し、依存パッケージのインストールは不要です。

```bash
npm start
```

ブラウザで [http://localhost:4173](http://localhost:4173) を開きます。初期画面の「`sample_data/test_dummy.csv` を使う」で同梱の1,200件を読み込めます。任意のCSVをドラッグ＆ドロップすることもできます。

## ログイン認証

利用者は、管理者がホワイトリストへ登録したユーザー名とパスワードでログインします。初期ユーザーは`config/auth-users.json`に登録されていますが、平文パスワードは保存せず、ランダムsalt付きの`scrypt`ハッシュだけを保持します。

- セッションは8時間有効の署名付き`HttpOnly` Cookie
- `SameSite=Strict`、本番HTTPS環境では`Secure`を付与
- 1つのIPから15分間に5回失敗すると一時的にログインを制限
- 判定API、プロンプト改善API、同梱サンプルCSVはログイン必須
- `SESSION_SECRET`はRender Blueprintがデプロイ環境ごとに生成

ユーザーを変更・追加する場合は、同じ形式の`scrypt`ハッシュを作って`config/auth-users.json`を更新します。デプロイ環境では、ファイルを変更せず`AUTH_USERS_JSON`環境変数でホワイトリスト全体を上書きすることもできます。平文パスワードはGit、環境変数、ログへ保存しないでください。

## OpenAI APIを使う（BYOK）

セットアップ画面で利用者自身のOpenAI APIキーを入力します。キーはこのタブのメモリ内だけに保持され、次の場所には保存されません。

- localStorage / sessionStorage / Cookie
- サーバーのDB・ファイル・セッション・キャッシュ
- アプリケーションログ

キーは判定またはプロンプト改善リクエストのたびにHTTPSでバックエンドへ渡され、そのリクエスト内でOpenAIへ即時転送されます。ページを再読み込みすると破棄されます。公開環境ではAPIキーなしのデモ判定を無効化しています。

サーバー側の設定例：

```dotenv
OPENAI_MODEL=gpt-5.6-luna
PORT=4173
ALLOW_DEMO_MODE=true
SESSION_SECRET=replace-with-at-least-32-random-bytes
```

ローカルでは`ALLOW_DEMO_MODE=true`により、キーなしで決定的なデモ判定も利用できます。実キー利用時はResponses APIのJSON Schema構造化出力を使用し、API側のレスポンス保存を`store: false`にしています。

## ワークフロー

1. CSVと分析条件を入力
2. 生成された判定プロンプトを確認・編集
3. 全ペルソナを1人ずつ逐次判定
4. ランダム10件をレビュー
5. OKなら全体集計、修正する場合は自然言語フィードバックを入力
6. Prompt Architectがプロンプトを改良し、再判定
7. 全体サマリーでも同じ改善ループを実行可能

施策シミュレーションはUI上で「準備中」とし、現時点では選択できません。

## 確認コマンド

```bash
npm run check
npm test
docker build -t persona-churn-lab .
```

テストはローカルのモックOpenAIサーバーを使うため、実際のAPIキーや利用料金は不要です。

## CI/CD

GitHub ActionsはpushとPull Requestで次を実行します。

1. JavaScript構文チェック
2. BYOK API経路の自動テスト
3. 本番Dockerイメージのビルド

Render Blueprintはルートの`render.yaml`にあります。RenderでこのリポジトリからBlueprintを作成すると、SingaporeリージョンのDocker Web Serviceとして構成されます。`main`のCIチェックが通過したコミットだけを自動デプロイし、`/api/health`をヘルスチェックに使用します。署名用`SESSION_SECRET`はRenderが自動生成します。OpenAI APIキーをRenderの環境変数へ登録する必要はありません。

### 初回Renderデプロイ

1. 変更をGitHubへpush
2. Render Dashboardで **New → Blueprint** を選択
3. このGitHubリポジトリを接続
4. `render.yaml`を確認して適用
5. 発行されたHTTPS URLでAPIキー接続と1件の判定を確認

アップロードされたCSVはブラウザ内で解析されます。ただし判定時には、対象となる1人分のペルソナ情報がバックエンドを経由してOpenAI APIへ送信されます。
