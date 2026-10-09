import { describe, expect, test, vi } from "vitest";
import { formatRetrieveResult, retrieveNotes, type RetrieveResult } from "./rag.js";

// 本物の ai-chat-app(http://localhost:3000)は呼ばず、fetch の「代役」を渡してテストする
// → サーバーや DB・Gemini API がなくても、誰の PC でも同じ結果になる(一時フォルダのテストと同じ考え方)
function fakeFetchJson(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const BASE_URL = "http://localhost:3000";

describe("retrieveNotes", () => {
  test("/api/rag/retrieve に query・from・to・limit を JSON で POST する", async () => {
    const fetchMock = fakeFetchJson(200, { query: "q", period: null, status: "found", hits: [] });

    await retrieveNotes(BASE_URL, { query: "RAG", from: "2026-10-01", to: "2026-10-08", limit: 3 }, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/rag/retrieve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ query: "RAG", from: "2026-10-01", to: "2026-10-08", limit: 3 });
  });

  test("サーバーがエラー(500)を返したら、サーバーの error メッセージつきで例外にする", async () => {
    const fetchMock = fakeFetchJson(500, { error: "検索中にエラーが発生しました。" });

    await expect(retrieveNotes(BASE_URL, { query: "RAG" }, fetchMock)).rejects.toThrow(
      "検索中にエラーが発生しました。",
    );
  });

  test("サーバーに接続できない(起動していない)ときは、起動を促すメッセージの例外にする", async () => {
    // Node.js の fetch は接続を拒否されると TypeError("fetch failed") を投げ、cause.code が ECONNREFUSED になる
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });

    await expect(retrieveNotes(BASE_URL, { query: "RAG" }, fetchMock)).rejects.toThrow(
      "ai-chat-app のサーバーに接続できません",
    );
  });
});

describe("formatRetrieveResult", () => {
  const hit = {
    id: "20261008_学習メモ.txt#12",
    source: "20261008_学習メモ.txt",
    heading: "本日の理解確認テスト(7問)",
    score: 0.61832,
    text: "パストラバーサル…",
  };

  test("found:スコア・出典・見出し・本文を並べる", () => {
    const result: RetrieveResult = { query: "q", period: null, status: "found", hits: [hit] };
    const text = formatRetrieveResult(result);
    expect(text).toContain("[0.618] 20261008_学習メモ.txt 【本日の理解確認テスト(7問)】");
    expect(text).toContain("パストラバーサル…");
  });

  test("low_score:本文は返しつつ、関連が薄い可能性があると先頭で伝える", () => {
    const result: RetrieveResult = { query: "q", period: null, status: "low_score", hits: [hit] };
    const text = formatRetrieveResult(result);
    expect(text.startsWith("注意:")).toBe(true);
    expect(text).toContain("search_memos");
    expect(text).toContain("パストラバーサル…");
  });

  test("no_notes_for_period:その期間のメモがないと伝える", () => {
    const result: RetrieveResult = {
      query: "q",
      period: { from: "2026-10-03", to: "2026-10-04" },
      status: "no_notes_for_period",
      hits: [],
    };
    expect(formatRetrieveResult(result)).toContain("2026-10-03〜2026-10-04 の学習メモはありません");
  });
});
