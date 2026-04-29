const ACCEPT_LANGUAGE = "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7";
const TIMEOUT = 30_000;

async function fetchViaContent(browserlessUrl, token, targetUrl) {
  const url = new URL("/chromium/content", browserlessUrl);
  if (token) url.searchParams.set("token", token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(url.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        url: targetUrl,
        waitForEvent: { event: "networkidle0", timeout: TIMEOUT },
        setExtraHTTPHeaders: {
          "Accept-Language": ACCEPT_LANGUAGE,
        },
      }),
    });

    const body = await res.text();

    if (!res.ok) {
      return { ok: false, error: `browserless returned ${res.status}` };
    }

    return { ok: true, body, statusCode: 200 };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchViaContent };
