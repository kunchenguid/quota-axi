// Test-only transport boundary. Loopback/IPC fixtures remain available; a
// provider host is rejected before Node's native connect can resolve or send.
const net = process.getBuiltinModule("node:net");
const { syncBuiltinESMExports } = process.getBuiltinModule("node:module");
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const host =
    typeof options === "object"
      ? (options?.host ?? options?.hostname)
      : typeof args[1] === "string"
        ? args[1]
        : undefined;
  if (host && !["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error("Offline tests blocked an outbound socket");
  return connect.apply(this, args);
};

syncBuiltinESMExports();
