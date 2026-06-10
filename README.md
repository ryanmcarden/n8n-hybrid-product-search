# Hybrid Semantic Product Search

A production search pipeline combining local vector embeddings, Pinecone semantic retrieval, and SQL enrichment — built on self-hosted n8n. Returns ranked, price-enriched, sale-aware product results in a single webhook response.

**Live at:** [stitchamerica.com](https://stitchamerica.com) — the search bar on every page runs this workflow.

---

## What It Does

A user types "navy Richardson trucker hat under $30" into a search bar. Within one round trip, this pipeline:

1. Parses the query — extracts brand (`Richardson`), intent family (`headwear`), and semantic tokens
2. Detects if the query is a direct SKU lookup and routes accordingly
3. Embeds the cleaned query using a locally-hosted Ollama model (zero inference cost)
4. Queries Pinecone for semantically similar products
5. Gates results to the correct product family, with penalty fallback if matches are thin
6. Enriches every result with live pricing, available colors, and color count from SQL Server
7. Checks for active sale/discount records and applies them in real time
8. Injects bestseller rank from last-30-days order data
9. Deduplicates and returns a clean ranked array to the frontend

No LLM call. No cloud embedding API. Sub-400ms on typical queries.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        QUERY PARSING                            │
│  Raw query → tokenize → brand detection (n-grams) →            │
│  SKU extraction → intent family → OMIT_UNLESS_ONLY patch        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
    ┌─────────▼──────────┐   ┌──────────▼──────────────────────┐
    │  DIRECT SKU ROUTE  │   │      VECTOR SEARCH ROUTE         │
    │                    │   │                                  │
    │  SQL exact lookup  │   │  Ollama nomic-embed-text →       │
    │  pricing + colors  │   │  Pinecone /query (topK 150) →   │
    │  single product    │   │  family gating + scoring →      │
    └─────────┬──────────┘   │  SQL enrichment (bulk)          │
              │               └──────────┬───────────────────────┘
              │                          │
              └────────────┬─────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                     SQL ENRICHMENT                              │
│  ProductPrices join → ProductAttributes join →                  │
│  color array per SKU → color count per SKU                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                   RANKING + SALE INJECTION                      │
│  Check active Specials table → apply discount to PriceLow/High  │
│  Inject bestseller rank (last 30 days order volume) →           │
│  Deduplicate → respond                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### Local embeddings over API embeddings

All query embeddings use `nomic-embed-text` via a self-hosted Ollama instance. The tradeoff: a GPU-equipped server to maintain, zero per-query cost, no outbound latency to an embedding API, and no rate limits. At search volume, this pays for itself quickly.

### SKU routing before vector search

Before any embedding happens, the query parser checks whether the input resolves to a product code — a pattern like `ST640`, `C112`, `GWT-SB`. If it does, the workflow bypasses Pinecone entirely and goes straight to a SQL exact match. Vector search is expensive relative to a primary-key lookup. Routing around it when unnecessary keeps latency low and the Pinecone index clean.

### Family gating with penalty fallback

After Pinecone returns candidates, an intent family classifier (`headwear`, `tees`, `polos`, `sweatshirts`, `outerwear`, `bags`, `bottoms`, `accessories`) cross-checks each result against its metadata category. Products that don't match the detected intent family are either filtered out or penalized in score.

The fallback logic matters: if strict gating returns fewer than 12 results, the pipeline widens to include items with no detectable family (metadata-light records). If that's still too thin, it switches to penalty mode — all results pass, but clear mismatches lose 0.90 from their final score. This prevents empty result pages while keeping relevance high on well-populated queries.

### `OMIT_UNLESS_ONLY` token patch

Queries like "Richardson trucker hat" shouldn't send "hat" and "cap" to Pinecone as search tokens — they add noise because every headwear product matches them. The parser strips `hat`, `hats`, `cap`, `caps` from the token list when the query contains other meaningful terms, but preserves them when they're the only term (a query of just "hat" should return hats). `bucket` is explicitly excluded from this omission because it's a specific product type, not a generic category label.

### Real-time discount injection

Every search response checks the active `Specials` table for records where today's date falls within `SpecialStartDate` and `SpecialEndDate`. Matching products get their `PriceLow` and `PriceHigh` multiplied by `(1 - discount)` and an `on-sale: true` flag injected before the response is returned. No caching layer — always live.

### Bestseller re-ranking

A parallel branch queries the last 30 days of order data, sums revenue per SKU, and returns a ranked list. Results are tagged with `popularRank` and `_sortKeys.mostPopular` so the frontend can offer a "Most Popular" sort without a second API call. The catalog order is preserved as `_sortKeys.defaultIndex` so switching sort modes is a client-side operation.

---

## Notable Code: SKU Extraction

The query parser handles product codes that appear in natural language — typed with spaces, dashes, or run together:

```javascript
// Handles: "ST640", "ST 640", "st-640", "GWT-SB", "C-112"
// Avoids: "cutter-buck" (blocked brand phrase), "ladies" (alpha-only, no dash)

const CONFIG = {
  alphaDash: {
    re: /\b([A-Z]{2,6}(?:-[A-Z]{1,6})+)\b/,  // GWT-SB style
  },
  alphaNumDash: {
    re: /\b([A-Z0-9]+(?:-[A-Z0-9]+)*)\b/,     // ST640, C-112 style
  },
  blockedAlphaDashPhrases: [
    "CUTTER-BUCK", "CUTTER-AND-BUCK", "SPORT-TEK"  // brand names, not SKUs
  ]
};
```

Brand names like `Sport-Tek` match the alpha-dash pattern but should not be treated as SKUs. The blocker list handles this explicitly. When a SKU is extracted, `onlyProdNo` flips to `true` and the vector path is skipped entirely.

---

## Notable Code: Family Gating

```javascript
// After Pinecone returns candidates:
const set1 = enriched.filter(x => hasFam(x.fams));       // clear intent match
const set2 = enriched.filter(x => x.fams.size === 0);    // no detectable family

if (set1.length >= 12) {
  gated = set1;                                           // strict gate
} else if (set1.length + set2.length >= 12) {
  gated = set1.concat(set2);                             // include unknowns
} else {
  // penalty mode: allow all, penalize mismatches
  gated = enriched.map(x => {
    const match = hasFam(x.fams);
    let penalty = 0;
    if (!match && x.fams.size > 0) penalty -= 0.90;      // clear mismatch
    else if (!match && x.fams.size === 0) penalty -= 0.30; // unknown
    return { ...x, final: x.final + penalty };
  });
}
```

This three-tier fallback was the result of watching strict gating produce empty result pages on long-tail queries. Penalty mode keeps the page populated while still pushing mismatched categories to the bottom.

---

## Stack

| Layer | Technology |
|---|---|
| Orchestration | n8n (self-hosted) |
| Embeddings | Ollama — `nomic-embed-text` |
| Vector store | Pinecone |
| Database | Microsoft SQL Server (legacy production) |
| Runtime | Windows Server + NVIDIA RTX 3060 (local GPU for Ollama) |
| Frontend integration | Webhook → JSON response |

---

## Schema

The generic schema this workflow expects is documented in [`products.sql`](products.sql). The production version runs against a 21M-record SQL Server database with 20+ years of order history. The schema here is normalized for clarity.

---

## What I Would Build Next

**Typo tolerance.** The current tokenizer is strict — `trucekr hat` returns nothing. A lightweight fuzzy pre-pass or a spell-correction step before embedding would fix the most common failure mode.

**Query rewriting.** "Something for a golf outing" is a valid search intent that the current pipeline handles poorly because there's no category token to gate on and the embedding drifts. A small LLM rewrite step — "golf outing" → "polo shirt golf" — would significantly improve coverage on conversational queries without adding much latency.

**Embedding cache.** Common queries ("trucker hat", "Richardson 112") hit Ollama on every request. A Redis TTL cache on the embedding output for the top 500 queries would cut the most frequent latency cost entirely.

**A/B result scoring.** The penalty weights (`-0.90` for mismatch, `-0.30` for unknown) were set by observation. Logging click-through and add-to-cart rates per result position would let these be tuned against real user behavior.

---

## Related Projects

- [Conversational AI Lead Qualification System](https://github.com/ryanmcarden/conversational-ai-lead-qualification) — GPT-4o chatbot with Postgres session memory, structured JSON output, and SMS lead notification

---

*Built and maintained by [Ryan Carden](https://ryancarden.com) · [LinkedIn](https://linkedin.com/in/ryanmcarden)*
