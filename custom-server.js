const http = require("http");
const zlib = require("zlib");

const origCreate = http.createServer.bind(http);

// Graceful shutdown coordinator: on SIGTERM/SIGINT, stop accepting new
// connections and let in-flight requests finish before exiting. The
// process.exit deferral below keeps the process alive during the drain
// window so other modules’ immediate-exit signal handlers (DB flush,
// tunnel cleanup) do not abort in-flight requests prematurely.
let drainServer = null;
let draining = false;
const DRAIN_TIMEOUT_MS = 25000;
const origExit = process.exit.bind(process);

function coordinatedShutdown(signal) {
  if (draining) return;
  draining = true;
  console.log(`[custom-server] ${signal} received, draining in-flight requests...`);
  if (drainServer) {
    // Close idle keep-alive connections so the drain is not blocked by them.
    if (typeof drainServer.closeIdleConnections === "function") {
      drainServer.closeIdleConnections();
    }
    drainServer.close(() => {
      console.log("[custom-server] drain complete, exiting.");
      origExit(0);
    });
  }
  // Force exit after the drain timeout (must stay under stop_grace_period).
  setTimeout(() => {
    console.log("[custom-server] drain timeout, forcing exit.");
    origExit(0);
  }, DRAIN_TIMEOUT_MS).unref();
}

// Defer process.exit while draining so the HTTP drain is not aborted by
// other signal handlers that call process.exit() immediately.
process.exit = function (code) {
  if (draining) return;
  return origExit(code);
};

// --- HTTP compression (gzip/brotli) ---
// Next standalone server ships JS/CSS uncompressed (~1.4MB on dashboard).
// Adding Content-Encoding here shrinks transfer ~3-5x with zero dependency
// cost (Node zlib). SSE (text/event-stream) is excluded so streaming chat
// stays untouched.
const COMPRESSIBLE_TYPES = new Set([
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/xml",
  "text/xml",
  "text/plain",
  "image/svg+xml",
  "application/manifest+json",
]);
const MIN_COMPRESS_SIZE = 1024;

function isCompressible(contentType) {
  if (!contentType) return false;
  const base = String(contentType).split(";")[0].trim().toLowerCase();
  return COMPRESSIBLE_TYPES.has(base);
}

function pickEncoding(req) {
  const accept = req.headers["accept-encoding"];
  if (!accept) return null;
  const enc = String(accept).toLowerCase();
  if (enc.includes("br")) return "br";
  if (enc.includes("gzip")) return "gzip";
  return null;
}

function applyCompression(req, res) {
  if (req.method === "HEAD") return;
  let decided = false;
  let active = false;
  let compressor = null;
  let ended = false;

  const origWriteHead = res.writeHead.bind(res);
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origFlushHeaders = res.flushHeaders ? res.flushHeaders.bind(res) : null;

  function startCompressor(encoding) {
    if (compressor) return;
    compressor = encoding === "br"
      ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
      : zlib.createGzip({ level: 6 });
    compressor.on("data", (chunk) => { if (!ended) origWrite(chunk); });
    compressor.on("end", () => { if (!ended) { ended = true; origEnd(); } });
    compressor.on("error", () => { if (!ended) { ended = true; origEnd(); } });
  }

  // Inspect response headers and decide whether to compress. Sets
  // Content-Encoding + Vary and starts the compressor when active.
  function decide() {
    if (decided) return active ? pickEncoding(req) : null;
    decided = true;
    const encoding = pickEncoding(req);
    if (!encoding) { active = false; return null; }
    const type = res.getHeader("content-type");
    if (!isCompressible(type)) { active = false; return null; }
    if (res.getHeader("content-encoding")) { active = false; return null; }
    const len = res.getHeader("content-length");
    if (len !== undefined && len !== null && Number(len) < MIN_COMPRESS_SIZE) { active = false; return null; }
    active = true;
    res.setHeader("content-encoding", encoding);
    const vary = res.getHeader("vary");
    res.setHeader("vary", vary ? String(vary) + ", accept-encoding" : "accept-encoding");
    res.removeHeader("content-length");
    startCompressor(encoding);
    return encoding;
  }

  // writeHead(statusCode[, statusMessage][, headers])
  res.writeHead = function (statusCode, ...rest) {
    if (!decided) {
      if (statusCode === 204 || statusCode === 304) {
        decided = true; active = false;
        return origWriteHead(statusCode, ...rest);
      }
      // Sync headers from the writeHead argument onto res so decide() can
      // read content-type/content-encoding, then (if compressing) send only
      // the statusCode (headers already applied via setHeader).
      const headersArg = rest.find((a) => a && typeof a === "object");
      if (headersArg) {
        for (const [k, v] of Object.entries(headersArg)) res.setHeader(k, v);
      }
      if (decide()) return origWriteHead(statusCode);
    }
    return origWriteHead(statusCode, ...rest);
  };

  res.write = function (chunk, ...rest) {
    if (!decided && !res.headersSent) decide();
    if (active && compressor && !ended) {
      compressor.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }
    return origWrite(chunk, ...rest);
  };

  res.end = function (chunk, ...rest) {
    if (!decided && !res.headersSent) decide();
    if (active && compressor && !ended) {
      if (chunk) compressor.end(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      else compressor.end();
      return res;
    }
    if (ended) return res;
    ended = true;
    return origEnd(chunk, ...rest);
  };

  if (origFlushHeaders) {
    res.flushHeaders = function () {
      if (!decided) decide();
      return origFlushHeaders();
    };
  }
}
// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) {
    const s = origCreate(...args);
    if (!drainServer) drainServer = s;
    return s;
  }
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    req.headers["x-9r-real-ip"] = ip;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    applyCompression(req, res);
    return handler(req, res);
  };
  const s = origCreate(...rest, wrapped);
  if (!drainServer) drainServer = s;
  return s;
};

process.on("SIGTERM", () => coordinatedShutdown("SIGTERM"));
process.on("SIGINT", () => coordinatedShutdown("SIGINT"));

require("./server.js");
