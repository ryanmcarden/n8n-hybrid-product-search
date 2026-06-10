/**
 * Intent Family Gating
 * Standalone reference file — readable version of the logic embedded in the n8n Code node.
 * The actual node code lives inline in hybrid-search-sanitized.json.
 * This file is NOT meant to be pasted directly into n8n.
 *
 * Applied after Pinecone returns candidates.
 *
 * Cross-checks each result against the detected intent family from the query parser.
 * Uses a three-tier fallback to prevent empty result pages on long-tail queries:
 *
 *   Tier 1 (strict):   ≥12 results match the intent family → return only those
 *   Tier 2 (widened):  <12 strict matches → include metadata-light "unknown" items
 *   Tier 3 (penalty):  still <12 → allow all results, penalize clear mismatches
 *
 * The penalty weights (-0.90, -0.30) were tuned against observed result quality.
 * A/B testing against click-through rates is the right next step for further tuning.
 */

const FAM_SYNS = {
  headwear: [
    "hat","cap","caps","beanie","beanies","toque","knit cap",
    "trucker","trucker hat","foam trucker","snapback","fitted","dad hat","visor",
    "bucket","boonie","flat bill","mesh back","patch hat","5 panel","five panel"
  ],
  tees: ["t-shirt","tee","tees","short sleeve tee","long sleeve tee","ringer","crewneck tee","pocket tee","shirt","shirts"],
  polos: ["polo","polos","golf shirt","golf polo","sport polo"],
  sweatshirts: ["hoodie","hoodies","hooded","pullover","zip hoodie","crewneck sweatshirt","sweatshirt","fleece","quarter zip","1/4 zip","quarter-zip"],
  outerwear: ["jacket","jackets","shell","soft shell","softshell","windbreaker","rain jacket","parka","anorak","vest","vests","outerwear"],
  bags: ["bag","bags","backpack","backpacks","duffel","duffle","tote","totes","cinch sack","drawstring","waist pack","fanny pack","cooler","lunch bag"],
  bottoms: ["pants","trousers","shorts","joggers","sweatpants","leggings"],
  accessories: ["apron","aprons","blanket","blankets","gaiter","scarf","scarves","glove","gloves","socks","patch","patches"]
};

// Map product category strings to families
const CAT_TOKEN_MAP = {
  headwear: ["headwear","cap","caps","beanie","beanies","visor","bucket","trucker","fitted","snapback"],
  tees: ["tee","t-shirt","shirt","shirts","tops"],
  polos: ["polo","polos","golf"],
  sweatshirts: ["sweatshirt","sweatshirts","hoodie","hoodies","fleece","crewneck","quarter zip","1/4 zip"],
  outerwear: ["outerwear","jacket","jackets","vest","vests","shell","soft shell","softshell","windbreaker","rain"],
  bags: ["bags","bag","backpack","tote","duffel","duffle","cooler"],
  bottoms: ["pants","shorts","joggers","leggings"],
  accessories: ["blanket","apron","gaiter","scarf","glove","gloves","socks","patch"]
};

function detectFamiliesFromText(txt) {
  const out = new Set();
  const h = " " + txt.toLowerCase() + " ";
  function hit(word) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\W)${esc}(?=\\W|$)`).test(h);
  }
  for (const [fam, syns] of Object.entries(FAM_SYNS)) {
    for (const w of syns) if (hit(w)) { out.add(fam); break; }
  }
  return out;
}

function detectFamiliesFromCategories(catArr) {
  const out = new Set();
  for (const c of catArr) {
    const parts = String(c || "").toLowerCase().split(/[|>/,]+/).map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      for (const [fam, toks] of Object.entries(CAT_TOKEN_MAP)) {
        if (toks.includes(p)) out.add(fam);
      }
    }
  }
  return out;
}

// --- Main (expects $json.matches from Pinecone and $json.intentFamilies from query parser) ---

const intentFamilies = Array.isArray($json.intentFamilies)
  ? $json.intentFamilies.map(s => String(s).toLowerCase())
  : [];

const HARD_GATE = intentFamilies.length > 0;

// [grouped items come from upstream merge node]
// This node receives enriched[] array — each item has { it, fams, base, boost, final }

function familiesForItem(it) {
  const fams = new Set();
  for (const f of detectFamiliesFromCategories(it.Category)) fams.add(f);
  const textBlob = [
    it.Title.join(" | "),
    it.LongDescription.join(" | "),
    it.Category.join(" | "),
    it.AltTag.join(" | ")
  ].join(" | ");
  for (const f of detectFamiliesFromText(textBlob)) fams.add(f);
  return fams;
}

// After scoring, apply family gating:
function applyFamilyGating(enriched) {
  if (!HARD_GATE) return enriched;

  const hasFam = (fs) => intentFamilies.some(f => fs.has(f));

  const set1 = enriched.filter(x => hasFam(x.fams));
  const set2 = enriched.filter(x => x.fams.size === 0); // metadata-light unknowns

  if (set1.length >= 12) {
    return set1;
  } else if (set1.length + set2.length >= 12) {
    return set1.concat(set2);
  } else {
    // Penalty mode — allow all, penalize mismatches
    return enriched.map(x => {
      const match = hasFam(x.fams);
      let penalty = 0;
      if (!match && x.fams.size > 0) penalty -= 0.90;   // clear category mismatch
      else if (!match && x.fams.size === 0) penalty -= 0.30; // unknown, slight penalty
      return { ...x, final: x.final + penalty };
    });
 