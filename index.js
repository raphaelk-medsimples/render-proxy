const http = require("http");
const https = require("https");
const { URL } = require("url");
const uaPool = require("./ua-pool.json");
const { isBlocked } = require("./block-detect");
const { fetchViaContent } = require("./browserless-client");

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 30_000;
const DELAY_MIN_MS = 50;
const DELAY_MAX_MS = 300;

const BROWSERLESS_SELF_URL = process.env.BROWSERLESS_SELF_URL || "https://browserless-v3.onrender.com";
const BROWSERLESS_SELF_TOKEN = process.env.BROWSERLESS_SELF_TOKEN || "";
const BROWSERLESS_API_URL = process.env.BROWSERLESS_API_URL || "";
const BROWSERLESS_API_TOKEN = process.env.BROWSERLESS_API_TOKEN || "";

const HEADERS_TO_STRIP = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "via",
  "forwarded",
  "x-request-id",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "render-proxy-ttl",
  "rndr-id",
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

const HEADER_ORDER = [
  "host",
  "connection",
  "cache-control",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "upgrade-insecure-requests",
  "user-agent",
  "accept",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest",
  "accept-encoding",
  "accept-language",
  "cookie",
  "referer",
  "x-forwarded-geo",
  "cf-ipcountry",
];

const cookieJar = new Map();

function pickUA() {
  const totalWeight = uaPool.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of uaPool) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return uaPool[0];
}

function randomDelay() {
  const ms = DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildBrowserHeaders(entry, hostname) {
  const headers = {
    "host": hostname,
    "sec-ch-ua": "",
    "sec-ch-ua-mobile": "",
    "sec-ch-ua-platform": "",
    "upgrade-insecure-requests": "1",
    "user-agent": entry.ua,
    "accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "sec-fetch-site": "none",
    "sec-fetch-mode": "navigate",
    "sec-fetch-user": "?1",
    "sec-fetch-dest": "document",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": ACCEPT_LANGUAGE,
    "x-forwarded-geo": "BR",
    "cf-ipcountry": "BR",
    ...buildSecCHUA(entry),
  };

  const cookies = cookieJar.get(hostname);
  if (cookies) {
    headers["cookie"] = cookies;
  }

  return headers;
}

function orderHeaders(headers) {
  const ordered = [];
  for (const key of HEADER_ORDER) {
    if (headers[key] !== undefined && headers[key] !== "") {
      ordered.push([key, headers[key]]);
    }
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADER_ORDER.includes(key.toLowerCase())) {
      ordered.push([key, value]);
    }
  }
  return ordered;
}

function stripHeaders(headers) {
  const cleaned = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HEADERS_TO_STRIP.includes(lower)) continue;
    if (lower === "host") continue;
    cleaned[lower] = value;
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

function storeCookies(hostname, proxyRes) {
  const setCookies = proxyRes.headers["set-cookie"];
  if (!setCookies) return;

  const existing = cookieJar.get(hostname) || "";
  const existingPairs = new Map(
    existing
      .split("; ")
      .filter(Boolean)
      .map((p) => {
        const eq = p.indexOf("=");
        return eq > 0 ? [p.slice(0, eq), p.slice(eq + 1)] : [p, ""];
      })
  );

  for (const raw of setCookies) {
    const cookiePart = raw.split(";")[0].trim();
    const eq = cookiePart.indexOf("=");
    if (eq > 0) {
      existingPairs.set(cookiePart.slice(0, eq), cookiePart.slice(eq + 1));
    }
  }

  const merged = [...existingPairs.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  cookieJar.set(hostname, merged);
}

function sendJSON(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function forwardRequest(targetUrl, method, orderedHeaders, body) {
  const transport = targetUrl.protocol === "https:" ? https : http;

  const headerObj = {};
  for (const [k, v] of orderedHeaders) {
    headerObj[k] = v;
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      targetUrl.href,
      { method, headers: headerObj, timeout: REQUEST_TIMEOUT },
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

// --- Strategy functions ---

async function nativeStrategy(targetUrl, method, incomingHeaders, reqBody) {
  await randomDelay();

  const uaEntry = pickUA();
  const browserHeaders = buildBrowserHeaders(uaEntry, targetUrl.hostname);
  const merged = { ...incomingHeaders, ...browserHeaders };
  const orderedHeaders = orderHeaders(merged);

  const proxyRes = await forwardRequest(targetUrl, method, orderedHeaders, reqBody);

  storeCookies(targetUrl.hostname, proxyRes);

  const responseHeaders = {};
  for (const [key, value] of Object.entries(proxyRes.headers)) {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  }

  const chunks = [];
  for await (const chunk of proxyRes) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  return { statusCode: proxyRes.statusCode, headers: responseHeaders, body };
}

async function selfHostedStrategy(targetUrl) {
  if (!BROWSERLESS_SELF_URL) return { ok: false, error: "not configured" };
  return fetchViaContent(BROWSERLESS_SELF_URL, BROWSERLESS_SELF_TOKEN, targetUrl.href);
}

async function apiStrategy(targetUrl) {
  if (!BROWSERLESS_API_URL || !BROWSERLESS_API_TOKEN) {
    return { ok: false, error: "not configured" };
  }
  return fetchViaContent(BROWSERLESS_API_URL, BROWSERLESS_API_TOKEN, targetUrl.href);
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "") {
    return sendJSON(res, 200, { status: "ok" });
  }

  const targetUrl = extractTargetURL(req.url);
  if (!targetUrl) {
    return sendJSON(res, 400, { error: "invalid target URL" });
  }

  const incomingHeaders = stripHeaders(req.headers);

  let reqBody = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    reqBody = Buffer.concat(chunks);
  }

  // Strategy 1: Native header-spoofing proxy
  try {
    const result = await nativeStrategy(targetUrl, req.method, incomingHeaders, reqBody);
    if (!isBlocked(result.statusCode, result.body)) {
      result.headers["x-proxy-strategy"] = "native";
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
      return;
    }
    console.log(`[cascade] native blocked for ${targetUrl.hostname}`);
  } catch (err) {
    console.log(`[cascade] native error for ${targetUrl.hostname}: ${err.message}`);
  }

  // Strategy 2: Self-hosted Browserless
  try {
    const result = await selfHostedStrategy(targetUrl);
    if (result.ok && !isBlocked(result.statusCode, result.body)) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-proxy-strategy": "browserless-self",
      });
      res.end(result.body);
      return;
    }
    if (!result.ok) {
      console.log(`[cascade] browserless-self error: ${result.error}`);
    } else {
      console.log(`[cascade] browserless-self blocked for ${targetUrl.hostname}`);
    }
  } catch (err) {
    console.log(`[cascade] browserless-self error: ${err.message}`);
  }

  // Strategy 3: Cloud Browserless API
  try {
    const result = await apiStrategy(targetUrl);
    if (result.ok) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-proxy-strategy": "browserless-api",
      });
      res.end(result.body);
      return;
    }
    console.log(`[cascade] browserless-api error: ${result.error}`);
  } catch (err) {
    console.log(`[cascade] browserless-api error: ${err.message}`);
  }

  sendJSON(res, 502, { error: "all strategies failed" });
});

server.listen(PORT, () => {
  console.log(`render-proxy listening on port ${PORT}`);
  if (BROWSERLESS_SELF_URL) console.log(`  browserless-self: ${BROWSERLESS_SELF_URL}`);
  if (BROWSERLESS_API_URL) console.log(`  browserless-api: ${BROWSERLESS_API_URL}`);
});
