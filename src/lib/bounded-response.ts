export async function readBoundedResponseText(
  response: Response,
  limitBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isInteger(declaredLength) && declaredLength > limitBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limitBytes) {
        void reader.cancel().catch(() => {});
        throw new Error("response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
