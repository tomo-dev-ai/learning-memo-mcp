import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchMemos } from "./search.js";

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

const server = new McpServer({ name: "learning-memo-mcp", version: "0.1.0" });

server.registerTool(
  "search_memos",
  {
    title: "学習メモ検索",
    description:
      "智博さんの日次の学習メモ(2026年9月〜)から、キーワードを含む行を新しい日付順に検索する。" +
      "「〇〇を学んだのはいつか」「〇〇についてどう書いたか」を調べるときに使う。" +
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

const transport = new StdioServerTransport();
await server.connect(transport);
log(`起動しました MEMO_DIR=${MEMO_DIR}`);
