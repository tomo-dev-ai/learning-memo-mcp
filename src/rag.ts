// 学習メモの意味検索(RAG)を、ai-chat-app の API(POST /api/rag/retrieve)経由で呼ぶ。
// DB の接続情報や Gemini の API キーはこの Server には持たせず、ai-chat-app 側にだけ置く。
// MCP の Tool の登録(index.ts)とは分けて、HTTP の呼び出しと結果の整形だけを担当する。

export type RetrieveHit = {
  id: string;
  source: string;
  heading: string | null;
  score: number;
  text: string;
};

export type RetrieveResult = {
  query: string;
  period: { from: string; to: string } | null;
  status: "found" | "no_notes_for_period" | "low_score";
  hits: RetrieveHit[];
};

export type RetrieveParams = {
  query: string;
  from?: string;
  to?: string;
  limit?: number;
};

// HTTP を呼ぶ関数の型。本番では本物の fetch、テストでは代役を渡す(依存性の注入)
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// 応答を待つ上限。Embedding(Gemini)の 429 などで返事が来ないまま待ち続けないようにする
const TIMEOUT_MS = 30_000;

/**
 * ai-chat-app の /api/rag/retrieve を呼び、意味検索の結果を返す。
 * 失敗したときは、LLM と人が原因を判断できるメッセージの Error を投げる。
 */
export async function retrieveNotes(
  baseUrl: string,
  params: RetrieveParams,
  fetchImpl: FetchLike = fetch,
): Promise<RetrieveResult> {
  const url = new URL("/api/rag/retrieve", baseUrl).toString();

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      throw new Error(
        `ai-chat-app のサーバーに接続できません(${baseUrl})。` +
          "ai-chat-app の server フォルダで node server.js を起動してください。",
      );
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`ai-chat-app から ${TIMEOUT_MS / 1000} 秒以内に応答がありませんでした。`);
    }
    throw err;
  }

  // エラー時も ai-chat-app は { error: "..." } の JSON を返す。JSON でなければ null
  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = isRecord(body) && typeof body.error === "string" ? body.error : "(詳細なし)";
    throw new Error(`ai-chat-app がエラーを返しました(HTTP ${res.status}): ${detail}`);
  }
  if (!isRecord(body) || typeof body.status !== "string" || !Array.isArray(body.hits)) {
    throw new Error("ai-chat-app から想定外の形式の応答が返りました。");
  }
  return body as RetrieveResult;
}

/** 意味検索の結果を、LLM が読みやすいテキストに整える */
export function formatRetrieveResult(result: RetrieveResult): string {
  if (result.status === "no_notes_for_period") {
    return `${result.period?.from}〜${result.period?.to} の学習メモはありません。`;
  }

  const body = result.hits
    .map((h) => `[${h.score.toFixed(3)}] ${h.source}${h.heading ? ` 【${h.heading}】` : ""}\n${h.text}`)
    .join("\n\n---\n\n");

  if (result.status === "low_score") {
    return (
      "注意: どの資料も類似度が基準より低く、質問と関係の薄い資料が含まれている可能性があります。" +
      "本文を読んで関係を確かめてから使ってください。" +
      "決まった単語(用語・ファイル名など)を探している場合は search_memos のほうが確実です。\n\n" +
      body
    );
  }
  return body;
}

// Node.js の fetch は、接続を拒否されると TypeError("fetch failed") を投げ、cause.code が ECONNREFUSED になる
function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const cause: unknown = err.cause;
  return isRecord(cause) && cause.code === "ECONNREFUSED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
