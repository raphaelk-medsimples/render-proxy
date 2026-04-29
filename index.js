const http = require("http");
const https = require("https");
const { URL } = require("url");
const uaPool = require("./ua-pool.json");

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 30_000;

const PROXY_HEADERS_TO_STRIP = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "via",
  "forwarded",
];

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const ACCEPT_LANGUAGE = "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7";

function pickUA() {
  const totalWeight = uaPool.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of uaPool) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return uaPool[0];
}

function buildSecCHUA(entry) {
  if (entry.browser === "chrome") {
    const match = entry.ua.match(/Chrome\/([\d]+)/);
    const ver = match ? match[1] : "124";
    return {
      "sec-ch-ua": `"Chromium";v="${ver}", "Google Chrome";v="${ver}", "Not-A.Brand";v="99"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": `"${entry.platform}"`,
    };
  }
  if (entry.browser === "edge") {
    const match = entry.ua.match(/Edg\/([\d]+)/);
    const ver = match ? match[1] : "124";
    return {
      "sec-ch-ua": `"Chromium";v="${ver}", "Microsoft Edge";v="${ver}", "Not-A.Brand";v="99"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": `"${entry.platform}"`,
    };
  }
  return {};
}

function buildBrowserHeaders(entry) {
  return {
    "user-agent": entry.ua,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": ACCEPT_LANGUAGE,
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    ...buildSecCHUA(entry),
    "x-forwarded-geo": "BR",
    "cf-ipcountry": "BR",
  };
}

function stripHeaders(headers) {
  const cleaned = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (PROXY_HEADERS_TO_STRIP.includes(lower)) continue;
    if (lower === "host") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function extractTargetURL(requestUrl) {
  const raw = requestUrl.slice(1);
  if (!raw || raw === "favicon.ico") return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function sendJSON(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function forwardRequest(targetUrl, method, headers, body) {
  const transport = targetUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      targetUrl.href,
      { method, headers, timeout: REQUEST_TIMEOUT },
      resolve
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    req.on("error", reject);

    if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "") {
    return sendJSON(res, 200, { status: "ok" });
  }

  const targetUrl = extractTargetURL(req.url);
  if (!targetUrl) {
    return sendJSON(res, 400, { error: "invalid target URL" });
  }

  const uaEntry = pickUA();
  const browserHeaders = buildBrowserHeaders(uaEntry);
  const incomingHeaders = stripHeaders(req.headers);
  const outgoingHeaders = { ...incomingHeaders, ...browserHeaders };

  let body = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  try {
    const proxyRes = await forwardRequest(
      targetUrl,
      req.method,
      outgoingHeaders,
      body
    );

    const responseHeaders = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  } catch {
    sendJSON(res, 502, { error: "target unreachable" });
  }
});

server.listen(PORT, () => {
  console.log(`render-proxy listening on port ${PORT}`);
});
