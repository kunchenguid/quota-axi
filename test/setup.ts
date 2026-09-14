for (const name of [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
]) {
  delete process.env[name];
}
