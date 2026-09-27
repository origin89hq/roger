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

export type Body =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

/** Reads a body of at most `limit` bytes, whatever Content-Length claims. */
async function boundedBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > limit) return null;
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
        return null;
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
  return bytes;
}

function hasType(request: Request, type: string): boolean {
  return (
    request.headers.get("content-type")?.toLowerCase().startsWith(type) ?? false
  );
}

/** Reads a JSON body of at most `limit` bytes, whatever Content-Length claims. */
export async function jsonBody(request: Request, limit: number): Promise<Body> {
  if (!hasType(request, "application/json")) {
    return {
      ok: false,
      response: failure(
        415,
        "invalid_request",
        "Send the body as application/json.",
      ),
    };
  }
  const bytes = await boundedBytes(request, limit);
  if (!bytes)
    return {
      ok: false,
      response: failure(
        413,
        "too_large",
        `The request body is larger than ${limit} bytes.`,
      ),
    };
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

/**
 * Reads an `application/x-www-form-urlencoded` body of at most `limit` bytes,
 * as OAuth endpoints take. `null` when it is missing, too large, or not UTF-8.
 */
export async function formBody(
  request: Request,
  limit: number,
): Promise<URLSearchParams | null> {
  if (!hasType(request, "application/x-www-form-urlencoded")) return null;
  const bytes = await boundedBytes(request, limit);
  if (!bytes) return null;
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return null;
  }
}
