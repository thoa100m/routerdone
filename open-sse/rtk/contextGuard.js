// Context overflow guard: evict old reasoning encrypted_content blobs when the
// request body exceeds a byte-size threshold. Targets the biggest context
// accumulator in long agentic CLI sessions (Codex reasoning items).
//
// Reasoning items in OpenAI Responses format carry an opaque encrypted_content
// blob per turn. Over a long session these accumulate and can push input past
// the model context window. RTK only compresses tool_result content, so this
// guard fills the gap by trimming old reasoning blobs while preserving recent
// ones for continuity.

const DEFAULT_MAX_BYTES = 3_500_000; // ~875K tokens (4 chars/token); catches >1M-token drift
const DEFAULT_KEEP_RECENT = 8;       // keep last N reasoning items intact
const CHARS_PER_TOKEN = 4;           // rough estimate for logging only

// Find the conversation items array across supported request formats.
function findItems(body) {
  if (Array.isArray(body.input)) return body.input;
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body.contents)) return body.contents;
  if (Array.isArray(body.request?.contents)) return body.request.contents;
  return null;
}

// Sum sizes of string fields across all items (proxy for token count).
function estimateBytes(items) {
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") {
      if (typeof item === "string") total += item.length;
      continue;
    }
    if (typeof item.encrypted_content === "string") total += item.encrypted_content.length;
    if (typeof item.content === "string") {
      total += item.content.length;
    } else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && typeof part.text === "string") total += part.text.length;
        if (part && typeof part.output === "string") total += part.output.length;
      }
    }
    if (typeof item.output === "string") total += item.output.length;
    if (Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (s && typeof s.text === "string") total += s.text.length;
      }
    }
  }
  return total;
}

// Collect reasoning items that carry an encrypted_content blob.
function collectReasoning(items) {
  const found = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && item.type === "reasoning" && typeof item.encrypted_content === "string") {
      found.push({ index: i, encLen: item.encrypted_content.length });
    }
  }
  return found;
}

// Evict encrypted_content from old reasoning items, keeping the most recent N
// intact. Preserves the item (type/id/summary/content) so conversation
// structure stays valid; only the heavy blob is removed.
function evictOldReasoning(items, reasoning, keepRecent) {
  const evictCount = reasoning.length - keepRecent;
  if (evictCount <= 0) return null;

  let evictedBytes = 0;
  let evictedItems = 0;
  for (let i = 0; i < evictCount; i++) {
    const { index, encLen } = reasoning[i];
    const item = items[index];
    if (!item) continue;
    delete item.encrypted_content;
    evictedBytes += encLen;
    evictedItems++;
    const hasSummary = Array.isArray(item.summary) && item.summary.length > 0;
    if (!hasSummary) {
      item.summary = [{ type: "summary_text", text: "[reasoning context trimmed to manage conversation length]" }];
    }
  }

  if (evictedItems === 0) return null;
  return { evictedBytes, evictedItems, totalReasoningItems: reasoning.length, keptRecent: Math.min(keepRecent, reasoning.length) };
}

// Public entry. Returns stats object or null when nothing changed.
// isCompact: skip eviction during Codex context-handoff/compaction requests so
// upstream /compact receives full reasoning blobs to summarize.
export function guardContext(body, { enabled = true, maxBytes = DEFAULT_MAX_BYTES, keepRecent = DEFAULT_KEEP_RECENT, isCompact = false } = {}) {
  if (!enabled || !body || isCompact) return null;

  const items = findItems(body);
  if (!items || items.length === 0) return null;

  const reasoning = collectReasoning(items);
  if (reasoning.length === 0) return null;

  const estBytes = estimateBytes(items);
  if (estBytes < maxBytes) return null;

  const result = evictOldReasoning(items, reasoning, keepRecent);
  if (!result) return null;

  const estTokens = Math.round(estBytes / CHARS_PER_TOKEN);
  const afterTokens = Math.round((estBytes - result.evictedBytes) / CHARS_PER_TOKEN);
  return {
    ...result,
    estBytesBefore: estBytes,
    estTokensBefore: estTokens,
    estTokensAfter: afterTokens,
    threshold: maxBytes,
  };
}

// Estimate input token count from body (rough: total string bytes / 4).
// Reused by chatCore for per-request input logging and hard-cap enforcement.
export function estimateInputTokens(body) {
  if (!body) return 0;
  const items = findItems(body);
  if (!items || items.length === 0) return 0;
  return Math.round(estimateBytes(items) / CHARS_PER_TOKEN);
}

// Format a log line from guard stats.
export function formatContextGuardLog(stats) {
  if (!stats || stats.evictedItems === 0) return null;
  const savedKB = Math.round(stats.evictedBytes / 1024);
  return `[CTX-GUARD] trimmed ${stats.evictedItems}/${stats.totalReasoningItems} reasoning blobs (${savedKB}KB) | est ${stats.estTokensBefore} -> ${stats.estTokensAfter} tokens | kept recent ${stats.keptRecent}`;
}
