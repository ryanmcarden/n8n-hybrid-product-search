/**
 * SKU / Product Code Extractor
 * n8n Code node — "Run Once for All Items"
 *
 * Extracts a product/style code from a natural language query when one is present.
 * When a code is found, sets onlyProdNo = true and the vector search path is bypassed.
 *
 * Handles:
 *   ST640, "ST 640", "st-640"        → ST640
 *   GWT-SB                            → GWT-SB  (alpha-dash style codes)
 *   C112, C-112                       → C112
 *
 * Does NOT treat as codes:
 *   "cutter-buck", "sport-tek"        → brand names (blocked list)
 *   "ladies", "unisex"                → alpha-only, no dash
 *   "800-555-1234"                    → phone number heuristic
 */

const CONFIG = {
  blockedAlphaDashPhrases: [
    "CUTTER-BUCK",
    "CUTTER-AND-BUCK",
    "CUTTER-&-BUCK",
    "SPORT-TEK",
  ],

  // Alpha-only codes — must contain at least one dash (GWT-SB, ST-CORE)
  alphaDash: {
    minTotalLen: 3,
    maxTotalLen: 15,
    re: /\b([A-Z]{2,6}(?:-[A-Z]{1,6})+)\b/,
  },

  // Alphanumeric codes — letters + digits, optionally dashed (C112, AB-12)
  alphaNumDash: {
    minTotalLen: 3,
    maxTotalLen: 15,
    re: /\b([A-Z0-9]+(?:-[A-Z0-9]+)*)\b/,
  },

  numericPair: {
    re: /\b(\d{2,3})[- _./]?(\d{3,4})\b/,
  },

  contiguousDigits: {
    re: /\d{5,7}/,
  },
};

function toUpperTrim(x) {
  return String(x ?? "").trim().toUpperCase();
}

function onlyDigits(s) {
  return String(s ?? "").replace(/\D+/g, "");
}

function isUSPhoneDigits(digits) {
  return digits.length === 7 || digits.length === 10 || digits.length === 11;
}

function phraseKey(s) {
  return toUpperTrim(s)
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

const BLOCKED_KEYS = new Set(CONFIG.blockedAlphaDashPhrases.map(phraseKey));

function isBlocked(candidate, sourceText = "") {
  const ck = phraseKey(candidate);
  const sk = phraseKey(sourceText);
  if (BLOCKED_KEYS.has(ck)) return true;
  for (const bk of BLOCKED_KEYS) {
    if (sk.includes(bk) && bk.startsWith(ck)) return true;
  }
  return false;
}

function hasLetterAndDigit(s) {
  return /[A-Z]/.test(s) && /\d/.test(s);
}

function tryExtractProdNo(str, tokens) {
  const S = toUpperTrim(str);
  if (!S) return null;

  const digitsInS = onlyDigits(S);
  const looksLikePhone = isUSPhoneDigits(digitsInS);

  // 1) Alpha-dash codes (GWT-SB)
  const m0 = S.match(CONFIG.alphaDash.re);
  if (m0) {
    const code = m0[1];
    if (
      code.length >= CONFIG.alphaDash.minTotalLen &&
      code.length <= CONFIG.alphaDash.maxTotalLen &&
      !isBlocked(code, S)
    ) {
      return code;
    }
  }

  // 2) Alphanumeric codes (ST640, C-112)
  if (/[A-Z]/.test(S) && /\d/.test(S)) {
    const m1 = S.match(CONFIG.alphaNumDash.re);
    if (m1) {
      const code = m1[1];
      if (
        code.length >= CONFIG.alphaNumDash.minTotalLen &&
        code.length <= CONFIG.alphaNumDash.maxTotalLen &&
        hasLetterAndDigit(code)
      ) {
        return code;
      }
    }
  }

  // 3) Numeric pair (avoid misreading phone numbers)
  const m2 = S.match(CONFIG.numericPair.re);
  if (m2) {
    const [, a, b] = m2;
    const hasDash = /-/.test(m2[0]);
    if (hasDash || looksLikePhone) return `${a}-${b}`;
    return `${a}${b}`;
  }

  // 4) Contiguous 5–7 digits
  const m3 = S.match(CONFIG.contiguousDigits.re);
  if (m3) {
    const digits = m3[0];
    if (looksLikePhone && digits.length === 7) {
      return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    }
    return digits;
  }

  // 5) Token fallback — handles "ST 640" typed with a space
  if (Array.isArray(tokens) && tokens.length >= 2) {
    const T = tokens.map(t => String(t ?? "").trim()).filter(Boolean);
    if (/^\d{2,3}$/.test(T[0]) && /^\d{3,4}$/.test(T[1])) {
      return `${T[0]}${T[1]}`;
    }
    const letters = (T.find(x => /^[A-Za-z]{1,6}$/.test(x)) || "").toUpperCase();
    const digits  = T.find(x => /^\d{1,6}$/.test(x)) || "";
    if (letters && digits) return `${letters}${digits}`;
  }

  return null;
}

// --- Main ---
return items.map(item => {
  const j = { ...(item.json || {}) };
  const rawQ = String(j.q ?? "").trim();
  const prodNo = tryExtractProdNo(rawQ, j.tokens);

  if (prodNo) {
    j.originalQ  = j.originalQ || rawQ;
    j.q          = prodNo;
    j.codes      = [...new Set([prodNo, ...(j.codes || [])])];
    j.onlyProdNo = true;
    j.tokens     = prodNo.includes("-") ? prodNo.split("-") : [prodNo];
  }

  return { json: j };
});
