import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** 検索結果1件分 */
export type MemoHit = {
  date: string; // 例: 2026-10-06
  file: string; // MEMO_DIRからの相対パス 例: 202610\20261006_学習メモ.txt
  line: number; // 行番号(1始まり)
  text: string; // キーワードを含む行
};

// 学習メモのファイル名のルール(例: 20261006_学習メモ.txt)
const MEMO_FILE_PATTERN = /^(\d{4})(\d{2})(\d{2})_学習メモ\.txt$/;

/** memoDir以下(サブフォルダを含む)の学習メモを、日付の新しい順に返す */
export async function listMemoFiles(memoDir: string): Promise<string[]> {
  const entries = await readdir(memoDir, { recursive: true });
  return entries
    .filter((rel) => MEMO_FILE_PATTERN.test(path.basename(rel)))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

/** キーワードを含む行を、新しいメモから順に最大limit件返す(大文字・小文字は区別しない) */
export async function searchMemos(
  memoDir: string,
  query: string,
  limit: number,
): Promise<MemoHit[]> {
  const keyword = query.toLowerCase();
  const hits: MemoHit[] = [];

  for (const rel of await listMemoFiles(memoDir)) {
    const match = MEMO_FILE_PATTERN.exec(path.basename(rel));
    if (!match) continue;
    const date = `${match[1]}-${match[2]}-${match[3]}`;

    const content = await readFile(path.join(memoDir, rel), "utf-8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(keyword)) {
        hits.push({ date, file: rel, line: i + 1, text: lines[i].trim() });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}
