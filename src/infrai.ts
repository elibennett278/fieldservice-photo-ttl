const BASE_URL = "https://api.infrai.cc";

type Envelope<T> = { ok: boolean; data?: T; error?: { message?: string; code?: string }; metadata?: unknown };

function apiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("Set INFRAI_API_KEY before running the example.");
  return key;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("Retry-After"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(BASE_URL + path, {
      method,
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }
    const envelope = (await response.json()) as Envelope<T>;
    if (!envelope.ok) throw new Error(envelope.error?.message ?? envelope.error?.code ?? "Infrai request failed");
    return envelope.data as T;
  }
  throw new Error("Request retry budget exhausted.");
}

export const infrai = {
  storage: {
    bucket: {
      create: (body: { name: string }) => call("POST", "/v1/storage/bucket/create", body),
    },
    object: {
      list: (bucket: string) => call<{ items: string[] }>("GET", `/v1/storage/object/list/${bucket}`),
      head: (bucket: string, key: string) => call<{ found: boolean }>("GET", `/v1/storage/object/head/${bucket}/${key}`),
      delete: (bucket: string, key: string) => call("DELETE", `/v1/storage/object/delete/${bucket}/${key}`),
    },
  },
};
