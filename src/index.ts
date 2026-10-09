import { existsSync, statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatRetrieveResult, retrieveNotes } from "./rag.js";
import { findNeighborDates, getMemoByDate, searchMemos } from "./search.js";

// stdio の Server では、標準出力(stdout)は Host との通信専用。
// console.log を使うと通信が壊れるので、ログは必ず console.error(標準エラー出力)に書く。
function log(message: string): void {
  console.error(`[learning-memo-mcp] ${new Date().toISOString()} ${message}`);
}

// 読むフォルダは環境変数で固定する(Claude からフォルダを指定させない)
const MEMO_DIR = process.env.MEMO_DIR;
if (!MEMO_DIR) {
  log("環境変数 MEMO_DIR が設定されていません。学習メモのフォルダを指定してください。");
  process.exit(1);
}
if (!existsSync(MEMO_DIR) || !statSync(MEMO_DIR).isDirectory()) {
  log(`MEMO_DIR のフォルダが見つかりません: ${MEMO_DIR}`);
  process.exit(1);
}

// 意味検索で呼ぶ ai-chat-app の URL(未設定なら手元の既定値)。起動時には確認しない
// (ai-chat-app が止まっていても、ほかの2つの Tool は使えるようにするため)
const RAG_API_URL = process.env.RAG_API_URL ?? "http://localhost:3000";

const server = new McpServer({ name: "learning-memo-mcp", version: "0.2.0" });

server.registerTool(
  "search_memos",
  {
    title: "学習メモ検索",
    description:
      "智博さんの日次の学習メモ(2026年9月〜)から、キーワードを含む行を新しい日付順に検索する。" +
      "「〇〇を学んだのはいつか」「〇〇についてどう書いたか」を調べるときに使う。" +
      "用語・ファイル名・エラー名など、決まった単語を探すときに向いている(言い換えや似た話題は semantic_search_memos)。" +
      "結果は [日付] ファイル名:行番号 と、その行の本文。",
    inputSchema: {
      query: z.string().trim().min(1).max(100).describe("検索キーワード(例: pgvector, Agent loop)"),
      limit: z.number().int().min(1).max(50).default(20).describe("最大件数(1〜50、既定20)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    try {
      const hits = await searchMemos(MEMO_DIR, query, limit);
      log(`search_memos query="${query}" limit=${limit} hits=${hits.length}`);

      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `「${query}」を含む学習メモは見つかりませんでした。` }],
        };
      }
      const text = hits
        .map((h) => `[${h.date}] ${h.file}:${h.line}\n${h.text}`)
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`search_memos でエラー: ${message}`);
      // isError: true で返すと、LLM は「Tool が失敗した」と分かり、別の手を考えられる
      return {
        content: [{ type: "text", text: `学習メモの検索中にエラーが発生しました: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_memo_by_date",
  {
    title: "学習メモ取得(日付指定)",
    description:
      "智博さんの日次の学習メモ(2026年9月〜)のうち、指定した1日分の全文を返す。" +
      "「10/6に何をしたか」「その日の理解確認テストの結果」など、特定の日の内容をまとめて知りたいときに使う。" +
      "キーワードを含む日を探すときは search_memos を使う。学習をしなかった日はメモが存在しない。",
    inputSchema: {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "日付は YYYY-MM-DD 形式で指定してください")
        .describe("取得する日付(例: 2026-10-06)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ date }) => {
    try {
      const memo = await getMemoByDate(MEMO_DIR, date);
      log(`get_memo_by_date date=${date} found=${memo !== null}`);

      // 「その日のメモがない」は Tool の失敗ではなく正常な結果なので isError を付けない
      if (!memo) {
        // 前後のメモの日付を添えて、LLM が1日ずつ探し回る呼び出しを減らす
        const { prev, next } = await findNeighborDates(MEMO_DIR, date);
        const hint = `直前のメモ: ${prev ?? "なし"} / 直後のメモ: ${next ?? "なし"}`;
        return {
          content: [{ type: "text", text: `${date} の学習メモはありません。${hint}` }],
        };
      }
      return {
        content: [{ type: "text", text: `[${memo.date}] ${memo.file}\n\n${memo.content}` }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`get_memo_by_date でエラー: ${message}`);
      return {
        content: [{ type: "text", text: `学習メモの取得中にエラーが発生しました: ${message}` }],
        isError: true,
      };
    }
  },
);

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付は YYYY-MM-DD 形式で指定してください");

server.registerTool(
  "semantic_search_memos",
  {
    title: "学習メモ意味検索(RAG)",
    description:
      "智博さんの日次の学習メモ(2026年9月〜)を、文の意味の近さで検索し、関連するチャンク(本文)を類似度つきで返す。" +
      "「〇〇でつまずいたときどう解決した?」「〇〇に似た話はあった?」のように、メモと同じ単語を使わない質問や、" +
      "言い換え・話題で探すときに使う。決まった単語(用語・ファイル名など)を探すなら search_memos のほうが確実。" +
      "期間で絞るときは from と to を両方 YYYY-MM-DD で指定する(「先週」なども日付に直して渡す)。" +
      "ai-chat-app のサーバーが起動している必要がある。",
    inputSchema: {
      query: z.string().trim().min(1).max(500).describe("探したい内容(自然文でよい)"),
      from: DATE.optional().describe("期間の開始日(例: 2026-10-01)。to とセットで指定"),
      to: DATE.optional().describe("期間の終了日(例: 2026-10-08)。from とセットで指定"),
      limit: z.number().int().min(1).max(20).default(5).describe("最大件数(1〜20、既定5)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, from, to, limit }) => {
    // from と to は片方だけでは使えない(ai-chat-app 側でも 400 になるが、ここで先に分かりやすく返す)
    if ((from === undefined) !== (to === undefined)) {
      return {
        content: [{ type: "text", text: "期間で絞る場合は from と to を両方指定してください。" }],
        isError: true,
      };
    }
    try {
      const result = await retrieveNotes(RAG_API_URL, { query, from, to, limit });
      log(`semantic_search_memos query="${query}" from=${from ?? "-"} to=${to ?? "-"} status=${result.status} hits=${result.hits.length}`);
      return { content: [{ type: "text", text: formatRetrieveResult(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`semantic_search_memos でエラー: ${message}`);
      return {
        content: [{ type: "text", text: `学習メモの意味検索中にエラーが発生しました: ${message}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`起動しました MEMO_DIR=${MEMO_DIR}`);
