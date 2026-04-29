const BLOCK_PATTERNS = [
  { status: 403, body: "Acesso Negado" },
  { status: 403, body: "Access Denied" },
  { status: 403, body: "Você não tem permissão" },
  { status: 403, body: "Attention Required" },
  { status: null, body: "Just a moment", extra: "Cloudflare" },
];

function isBlocked(statusCode, body) {
  if (!body) return false;
  const text = typeof body === "string" ? body : body.toString("utf8", 0, 4096);

  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.status && pattern.status !== statusCode) continue;
    if (!text.includes(pattern.body)) continue;
    if (pattern.extra && !text.includes(pattern.extra)) continue;
    return true;
  }

  return false;
}

module.exports = { isBlocked };
