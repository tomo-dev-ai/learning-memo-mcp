# learning-memo-mcp

日次の学習メモ(テキストファイル)をキーワード検索する、自作の **MCP Server(stdio)** です。
Claude Code などの MCP 対応アプリ(Host)に登録すると、「〇〇を学んだのはいつ?」と質問するだけで、
AI が自分で `search_memos` Tool を選んで学習メモを検索し、その結果をもとに回答します。

## 動作イメージ

```
あなた ─質問→ Claude Code(Host)
                 │ ① LLM が Tool の description を読み、search_memos を選ぶ
                 │ ② 承認画面(ユーザーが許可)
                 ▼
           Client ──stdio──→ learning-memo-mcp(このServer / 子プロセス)
                                 │ MEMO_DIR 以下の学習メモを検索
           Client ←─────────────┘ 一致した行を返す
                 │ ③ LLM が結果を読んで回答を作る
あなた ←回答─ Claude Code
```

例:「学習メモで、pgvectorについて書いたのはいつ?」
→ `search_memos({ query: "pgvector", limit: 50 })` が呼ばれ、
「9/15 に予定として初めて書き、9/25 に実際に環境を作った」と回答される。

## 提供する Tool

| Tool | 種類 | 引数 | 戻り値 |
|---|---|---|---|
| `search_memos` | read-only | `query`: 検索キーワード(1〜100文字)<br>`limit`: 最大件数(1〜50、既定20) | `[日付] ファイル名:行番号` と、キーワードを含む行(新しい日付順) |

- 対象ファイル: `MEMO_DIR` 以下(サブフォルダを含む)の `YYYYMMDD_学習メモ.txt`
- 大文字・小文字は区別しない

## 設計上のポイント

| 観点 | 対応 |
|---|---|
| 再利用可能な構造 | 検索処理(`src/search.ts`)と MCP の入り口(`src/index.ts`)を分離。検索処理は MCP 以外(API・テスト)からも使える |
| セキュリティ | 読むフォルダは環境変数 `MEMO_DIR` で Server 側に固定し、AI からパスを指定できないようにした。書き込み系の Tool は持たない |
| 入力チェック | zod で引数の型・範囲を定義し、範囲外は SDK が自動で拒否する(`limit` の上限で、LLM が大量件数を要求しても返す量を抑える) |
| エラー処理 | 検索中の例外は Server を落とさず `isError: true` で返し、LLM が失敗を認識できるようにした。`MEMO_DIR` 未設定時は起動時にエラーログを出して終了する |
| ログ | stdio では標準出力が Host との通信(MCP メッセージ)専用のため、ログはすべて `console.error`(標準エラー出力)に出す |

## 必要なもの

- Node.js 20 以上
- MCP に対応した Host(Claude Code など)

## セットアップ

```
git clone https://github.com/tomo-dev-ai/learning-memo-mcp.git
cd learning-memo-mcp
npm install
npm run build
```

## Claude Code への登録

```
claude mcp add learning-memo --transport stdio --scope user --env MEMO_DIR=C:\work\学習 -- node C:\work\learning-memo-mcp\dist\index.js
```

- `--env MEMO_DIR=...` は `--` の直前に置く(`--env` は複数の値を受け取るため、後ろに Server 名を書くと環境変数として読まれてしまう)
- MCP の設定はセッション開始時に読み込まれるため、登録後は Claude Code を起動し直す
- `/mcp` で `learning-memo · connected · 1 tool` と表示されれば成功

## 動作確認

```
# MEMO_DIR 未設定で直接起動すると、エラーログを出して終了する
node dist/index.js
# → [learning-memo-mcp] ... 環境変数 MEMO_DIR が設定されていません。…
```

## 既知の制約・今後の改善

- `MEMO_DIR` が存在しないフォルダでも起動してしまう(検索時にエラーとして返る)→ 起動時にフォルダの存在を確認する
- 単純な部分一致検索のため、言い換え(例:「ベクトルDB」と「pgvector」)は見つけられない
  → 既存の RAG(ai-chat-app、pgvector による意味検索)を呼び出す Tool の追加を検討
- 指定した日付のメモを全文返す Tool の追加
- 検索処理の単体テスト(Vitest)

## 技術スタック

TypeScript / Node.js / MCP TypeScript SDK(`@modelcontextprotocol/sdk`)/ zod
