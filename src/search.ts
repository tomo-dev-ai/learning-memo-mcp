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

/** 日付指定で取得した学習メモ1件分 */
export type MemoDocument = {
  date: string; // 例: 2026-10-06
  file: string; // MEMO_DIRからの相対パス
  content: string; // ファイルの全文
};

/**
 * 指定した日付(YYYY-MM-DD)の学習メモを返す。見つからなければ null。
 * 入力からパスを組み立てず、listMemoFiles() の一覧の中から探す(MEMO_DIR の外は読めない)
 */
export async function getMemoByDate(
  memoDir: string,
  date: string,
): Promise<MemoDocument | null> {
  const fileName = `${date.replaceAll("-", "")}_学習メモ.txt`; // 2026-10-06 → 20261006_学習メモ.txt
  const files = await listMemoFiles(memoDir);
  const rel = files.find((f) => path.basename(f) === fileName);
  if (!rel) return null;

  const content = await readFile(path.join(memoDir, rel), "utf-8");
  return { date, file: rel, content };
}

/** 直前・直後のメモの日付(なければ null) */
export type NeighborDates = {
  prev: string | null;
  next: string | null;
};

/**
 * 指定した日付より前で一番新しいメモの日付(prev)と、後で一番古いメモの日付(next)を返す。
 * get_memo_by_date でメモがなかったときに、LLM が1日ずつ探し回らなくて済むようにするため
 */
export async function findNeighborDates(memoDir: string, date: string): Promise<NeighborDates> {
  // listMemoFiles は新しい順なので、dates も新しい順(例: 2026-10-07, 2026-10-06, 2026-09-25)
  const dates = (await listMemoFiles(memoDir))
    .map((rel) => MEMO_FILE_PATTERN.exec(path.basename(rel)))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]}-${m[2]}-${m[3]}`);

  // YYYY-MM-DD 形式の文字列は、文字列の大小比較がそのまま日付の前後になる
  const prev = dates.find((d) => d < date) ?? null; // 新しい順で最初に見つかる「前の日付」= 直前
  const next = dates.filter((d) => d > date).at(-1) ?? null; // 「後の日付」のうち最後(一番古い)= 直後
  return { prev, next };
}
