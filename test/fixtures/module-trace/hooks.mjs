import { appendFileSync } from "node:fs";

const traceFile = process.env.QUOTA_AXI_MODULE_TRACE_FILE;

export async function load(url, context, nextLoad) {
  if (traceFile && !url.startsWith("node:"))
    appendFileSync(traceFile, `${url}\n`);
  return nextLoad(url, context);
}
