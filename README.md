# learning-memo-mcp

日次の学習メモ(テキストファイル)をキーワード検索・日付指定・意味検索(RAG)で調べる、自作の **MCP Server(stdio)** です。
Claude Code などの MCP 対応アプリ(Host)に登録すると、「〇〇を学んだのはいつ?」と質問するだけで、
AI が自分で適切な Tool(`search_memos` / `get_memo_by_date` / `semantic_search_memos`)を選んで学習メモを調べ、その結果をもとに回答します。

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

例:「学習メモで、10月3日に何を学んだか教えて」
→ `get_memo_by_date({ date: "2026-10-03" })` が「メモはありません」を返すと、LLM が自分で前後の日付(10/2・10/4)を
追加で呼び出し、「10/3 は学習していない日。直前の 10/2 は…」と回答される(Agent loop)。

例:「学習メモで、ローカルで動かしているサーバーに新しいコードが反映されなくて困ったことはあった?」
→ メモと同じ単語を使わない質問。LLM が次の3つを**同時に**呼び(意味検索+キーワード検索=ハイブリッド検索)、
見つかった日のメモを全文で読んで回答する。
1. `semantic_search_memos({ query: "ローカルで動かしているサーバーに新しいコードが反映されない、再起動が必要だった", limit: 8 })`
2. `search_memos({ query: "再起動" })` / `search_memos({ query: "反映" })`
3. `get_memo_by_date({ date: "2026-09-09" })`
→「9/9:古い node server.js のプロセスがポート3000を使ったまま残っていた。似たケースとして 9/4 …」

例:ai-chat-app のサーバーを止めた状態で意味検索を頼むと、`semantic_search_memos` が
「ai-chat-app のサーバーに接続できません…node server.js を起動してください」(`isError: true`)を返し、
LLM がキーワード検索に切り替えて回答する(MCP Server 自体は落ちない)。

## 提供する Tool

| Tool | 種類 | 引数 | 戻り値 |
|---|---|---|---|
| `search_memos` | read-only | `query`: 検索キーワード(1〜100文字)<br>`limit`: 最大件数(1〜50、既定20) | `[日付] ファイル名:行番号` と、キーワードを含む行(新しい日付順) |
| `get_memo_by_date` | read-only | `date`: 日付(`YYYY-MM-DD` 形式) | `[日付] ファイル名` と、その日のメモの全文。メモがない日は「メモはありません」と直前・直後のメモの日付(エラー扱いにしない。LLM が1日ずつ探し回らずに済む) |
| `semantic_search_memos` | read-only | `query`: 探したい内容(自然文、1〜500文字)<br>`from` / `to`: 期間(`YYYY-MM-DD`、両方指定)<br>`limit`: 最大件数(1〜20、既定5) | 意味の近いチャンクを `[類似度] ファイル名 【見出し】` と本文で返す。類似度が基準未満のときは先頭に「注意:関係の薄い資料の可能性。決まった単語なら search_memos」を付けて返す |

- `semantic_search_memos` は [ai-chat-app](https://github.com/tomo-dev-ai/ai-chat-app) の `POST /api/rag/retrieve`(pgvector による意味検索。回答文は生成せず、チャンクだけを返す)を呼ぶ。ai-chat-app のサーバーと DB(Docker)が起動している必要がある

- 対象ファイル: `MEMO_DIR` 以下(サブフォルダを含む)の `YYYYMMDD_学習メモ.txt`
- 大文字・小文字は区別しない

## 設計上のポイント

| 観点 | 対応 |
|---|---|
| 再利用可能な構造 | 検索・取得処理(`src/search.ts`)、RAG API の呼び出しと結果の整形(`src/rag.ts`)、MCP の入り口(`src/index.ts`)を分離。処理本体は MCP 以外(API・テスト)からも使える |
| RAG の呼び方 | ai-chat-app に「検索だけ」の API を追加し、HTTP で呼ぶ。回答文は呼び出し側の LLM(Claude)が作るため、Gemini で回答を生成させない(LLM が2回動く無駄・費用・429 を避け、元の文章を LLM に見せる)。DB の接続情報と Gemini の API キーは ai-chat-app にだけ置き、この Server には持たせない |
| 低スコアの扱い | 画面版の RAG は類似度が基準未満だと資料を切り捨てる(Gemini のハルシネーション対策)が、この Tool では本文を類似度つきで返し、関係の有無は本文を読める呼び出し側の LLM に判断させる。決まった単語の検索は description と結果の注意書きで `search_memos` に誘導する |
| セキュリティ | 読むフォルダは環境変数 `MEMO_DIR` で Server 側に固定し、AI からパスを指定できないようにした。`get_memo_by_date` も入力は日付だけで、入力からパスを組み立てず `MEMO_DIR` 内のファイル一覧と照合する(パストラバーサル対策。単体テストで確認)。書き込み系の Tool は持たない |
| 入力チェック | zod で引数の型・範囲を定義し、範囲外は SDK が自動で拒否する(`limit` の上限で、LLM が大量件数を要求しても返す量を抑える) |
| エラー処理 | 例外は Server を落とさず `isError: true` で返し、LLM が失敗を認識できるようにした。「その日のメモがない」は正常な結果として返す(isError を付けない)。`MEMO_DIR` 未設定時は起動時にエラーログを出して終了する(fail fast)。ai-chat-app は起動時に確認せず、止まっていても他の2つの Tool は使える。意味検索で接続できない・タイムアウト(30秒)・HTTP エラーのときは、原因と対処(「node server.js を起動してください」など)を `isError: true` で返す |
| テスト | Vitest で単体テスト(16件)。本物の学習メモではなく一時フォルダにテスト用のメモを作るため、メモが増えても結果が変わらない。RAG API の呼び出しは `fetch` を引数で受け取る形(依存性の注入)にし、テストでは代役を渡すため、サーバー停止時の動きもサーバーなしで確認できる |
| ログ | stdio では標準出力が Host との通信(MCP メッセージ)専用のため、ログはすべて `console.error`(標準エラー出力)に出す |

## 必要なもの

- Node.js 20 以上
- MCP に対応した Host(Claude Code など)
- (意味検索を使う場合)[ai-chat-app](https://github.com/tomo-dev-ai/ai-chat-app) のサーバーと DB(Docker の PostgreSQL + pgvector)

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
- ai-chat-app の URL が既定値(`http://localhost:3000`)と違う場合は `--env RAG_API_URL=...` も指定する(Windows で `localhost` に接続できないときは `http://127.0.0.1:3000`)
- `/mcp` で `learning-memo · connected · 3 tools` と表示されれば成功

## テスト

```
npm test
```

- `src/search.test.ts`:`listMemoFiles` / `searchMemos` / `getMemoByDate` / `findNeighborDates` の単体テスト(10件)
- `src/rag.test.ts`:`retrieveNotes`(送る JSON・HTTP 500・接続拒否)/ `formatRetrieveResult`(found・low_score・期間内にメモなし)の単体テスト(6件)
- テストファイルは `tsconfig.build.json` でビルド対象から除外(`dist` には含まれない)。エディタの型チェックは `tsconfig.json` で対象に含める

## 動作確認

```
# MEMO_DIR 未設定で直接起動すると、エラーログを出して終了する
node dist/index.js
# → [learning-memo-mcp] ... 環境変数 MEMO_DIR が設定されていません。…

# 存在しないフォルダを指定した場合も、起動時にエラーログを出して終了する
# → [learning-memo-mcp] ... MEMO_DIR のフォルダが見つかりません: C:\work\存在しない
```

## 既知の制約・今後の改善

- `search_memos` は単純な部分一致検索のため、言い換えは見つけられない → `semantic_search_memos` で補う(LLM が両方を使い分ける)
- 意味検索は、チャンク(400文字前後)に複数の話題が混ざるため、1つの専門用語だけの短い質問では類似度が伸びにくい
  (例:「パストラバーサル対策はどうした?」で該当チャンクが2位・0.618 と基準 0.65 未満)→ 結果に注意書きを付けて `search_memos` に誘導している
- 意味検索は ai-chat-app のサーバーに依存する(止まっていると使えない)

## 技術スタック

TypeScript / Node.js / MCP TypeScript SDK(`@modelcontextprotocol/sdk`)/ zod / Vitest
