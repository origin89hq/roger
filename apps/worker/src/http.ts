import type { AskState, ErrorBody, ErrorCode } from "./protocol.gen.ts";

export function json(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export function failure(
  status: number,
  code: ErrorCode,
  message: string,
  state: AskState | null = null,
): Response {
  const body: ErrorBody = { error: { code, message, state } };
  return json(body, status);
}

/** Whether the request says its body is JSON. */
export function isJson(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json") ?? false
  );
}

export type Body =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

/**
 * Reads a JSON body of at most `limit` bytes, whatever Content-Length claims.
 * With `anyType`, a body without the JSON content type is read too.
 */
export async function jsonBody(
  request: Request,
  limit: number,
  anyType = false,
): Promise<Body> {
  const tooLarge = {
    ok: false,
    response: failure(
      413,
      "too_large",
      `The request body is larger than ${limit} bytes.`,
    ),
  } as const;
  if (!anyType && !isJson(request)) {
    return {
      ok: false,
      response: failure(
        415,
        "invalid_request",
        "Send the body as application/json.",
      ),
    };
  }
  if (Number(request.headers.get("content-length")) > limit) return tooLarge;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    };
  } catch {
    return {
      ok: false,
      response: failure(400, "invalid_request", "The body is not valid JSON."),
    };
  }
}
