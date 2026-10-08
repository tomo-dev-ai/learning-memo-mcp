import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findNeighborDates, getMemoByDate, listMemoFiles, searchMemos } from "./search.js";

// 本物の学習メモ(C:\work\学習)は使わず、テストのたびに一時フォルダへテスト用のメモを作る
// → 学習メモが増えても結果が変わらない・誰のPCでも同じ結果になる
let memoDir: string;

beforeAll(async () => {
  memoDir = await mkdtemp(path.join(tmpdir(), "learning-memo-test-"));
  await mkdir(path.join(memoDir, "202609"));
  await mkdir(path.join(memoDir, "202610"));

  await writeFile(
    path.join(memoDir, "202609", "20260925_学習メモ.txt"),
    "pgvector を Docker で起動した\nRAG の chunking\n",
  );
  // Windows で作ったファイルを想定して改行は CRLF
  await writeFile(
    path.join(memoDir, "202610", "20261006_学習メモ.txt"),
    "Agent loop を整理\r\nPGVECTOR の復習\r\n",
  );
  await writeFile(path.join(memoDir, "202610", "20261007_学習メモ.txt"), "MCP Server を作成\n");
  // 学習メモではないファイル(検索・取得の対象外になるはず)
  await writeFile(path.join(memoDir, "202610", "202610_学習サマリー.txt"), "pgvector のまとめ\n");
});

afterAll(async () => {
  await rm(memoDir, { recursive: true, force: true });
});

describe("listMemoFiles", () => {
  test("サブフォルダを含む学習メモだけを、新しい日付順に返す", async () => {
    const files = await listMemoFiles(memoDir);
    expect(files).toEqual([
      path.join("202610", "20261007_学習メモ.txt"),
      path.join("202610", "20261006_学習メモ.txt"),
      path.join("202609", "20260925_学習メモ.txt"),
    ]);
  });
});

describe("searchMemos", () => {
  test("大文字・小文字を区別せず、新しいメモから順に返す", async () => {
    const hits = await searchMemos(memoDir, "pgvector", 20);
    expect(hits).toEqual([
      { date: "2026-10-06", file: path.join("202610", "20261006_学習メモ.txt"), line: 2, text: "PGVECTOR の復習" },
      { date: "2026-09-25", file: path.join("202609", "20260925_学習メモ.txt"), line: 1, text: "pgvector を Docker で起動した" },
    ]);
  });

  test("limit 件に達したら打ち切る", async () => {
    const hits = await searchMemos(memoDir, "pgvector", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].date).toBe("2026-10-06");
  });

  test("見つからなければ空配列を返す", async () => {
    expect(await searchMemos(memoDir, "存在しないキーワード", 20)).toEqual([]);
  });
});

describe("getMemoByDate", () => {
  test("指定した日付のメモを全文返す", async () => {
    const memo = await getMemoByDate(memoDir, "2026-10-07");
    expect(memo).toEqual({
      date: "2026-10-07",
      file: path.join("202610", "20261007_学習メモ.txt"),
      content: "MCP Server を作成\n",
    });
  });

  test("メモがない日付は null を返す", async () => {
    expect(await getMemoByDate(memoDir, "2026-10-03")).toBeNull();
  });

  test("パスのような値を渡しても MEMO_DIR の外は読まない(null を返す)", async () => {
    expect(await getMemoByDate(memoDir, "../../secret")).toBeNull();
  });
});

describe("findNeighborDates", () => {
  test("メモがない日付の、直前と直後のメモの日付を返す", async () => {
    expect(await findNeighborDates(memoDir, "2026-10-03")).toEqual({
      prev: "2026-09-25",
      next: "2026-10-06",
    });
  });

  test("最新のメモより後の日付なら、next は null", async () => {
    expect(await findNeighborDates(memoDir, "2026-12-01")).toEqual({
      prev: "2026-10-07",
      next: null,
    });
  });

  test("最初のメモより前の日付なら、prev は null", async () => {
    expect(await findNeighborDates(memoDir, "2026-01-01")).toEqual({
      prev: null,
      next: "2026-09-25",
    });
  });
});
