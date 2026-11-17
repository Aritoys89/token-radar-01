// lib/model.ts — the valuation model behind the Token Launch Radar.
//
// Everything on the board is derived from the sealed snapshot's own figures at run time. No protocol
// is named, weighted or special-cased anywhere in this file: the same functions score every row.
//
// THE MODEL
//   The snapshot's tokenised protocols are the market's own answer to "what is a dollar of TVL worth
//   as a token?". Each priced protocol's market-cap / TVL ratio is first winsorised to [0.01, 3]:
//   beyond that band a ratio says more about what the TVL record covers than about price (one priced
//   prediction market trades at 400x its recorded TVL). For each category, take the median of its
//   winsorised ratios, shrunk toward the global median so a thin or quarrelsome category cannot
//   shout:
//
//       multiple(cat) = clamp( (n * median(cat) + w(cat) * median(all)) / (n + w(cat)), 0.03, 2.5 )
//       w(cat)        = clamp( 5 + 2.5 * spread(cat), 5, 20 )
//       spread(cat)   = (Q3 - Q1) of the category's winsorised ratios / median(cat)
//
//   The prior weight is earned by the evidence, not fixed: a category whose priced peers agree with
//   each other (a narrow interquartile band around their median) is trusted sooner, while one whose
//   peers scatter across the whole band leans harder on the market as a whole. A category with a
//   single priced peer has no measurable agreement at all, so it is priced mostly by the market —
//   one observation at the winsorised cap cannot carry a category on its own. The same two numbers
//   — peer count and spread — grade each category's confidence (high / medium / low), which the
//   dashboard prints beside every multiple instead of hiding it.
//
//   A pre-token protocol's implied value is its TVL priced at that multiple, then adjusted by four
//   factors that also come from its own record:
//
//       growth   = 1 + 0.30 * clamp(change_7d, -60, +150) / 100     (a hot week is worth something,
//                                                                    a collapsing one is a warning)
//       momentum = 1 + 0.10 * clamp(change_7d - median change_7d of its category, -40, +40) / 40
//                                                                  (the week's tide lifts or sinks a
//                                                                    whole category at once; what marks
//                                                                    a launch candidate is gaining share
//                                                                    against its own category, so the
//                                                                    radar prices that separately)
//       overdue  = 1 + 0.45 * min(age_days, 1460) / 1460            (the longer a protocol has run at
//                                                                    size with no token, the more of
//                                                                    its value a launch would price)
//       breadth  = 1 + 0.05 * min(chains - 1, 8)                    (more chains, more holders a
//                                                                    launch would reach)
//       implied  = round( tvl_usd * multiple * growth * momentum * overdue * breadth )
//
//   Protocols with no listed_at date are scored at 40% of the overdue cap; protocols with no reported
//   7-day change get neutral growth and momentum factors of 1.
//
// THE SIGNAL
//   Beside the value, each row carries a 0–100 radar signal: how strong the launch evidence in the
//   protocol's own record is, independent of how large the protocol is priced. It sums five parts,
//   each computed from the snapshot: the protocol's 7-day growth percentile inside its own category
//   (30), its tokenless age against the same 1,460-day cap (25), the confidence of the multiple it
//   was priced at (20), its size on a log scale from the snapshot's $5M edge to $2B (15), and its
//   chain breadth (10). The dashboard shows the parts, so the score can be argued with.
//
// THE BOARD
//   The board ranks launch candidates: protocols that record no token and pass the same product test
//   the house's watchlist applies — not an exchange, not a bridge or staking wrapper of an asset that
//   already trades, not a versioned pool of another protocol. Every watchlist slug is on the board
//   (the gate requires it, and the test passes all 40 anyway). Tokenised protocols never enter the
//   board; they ship beside it in the data file as the comparables set the multiples came from, so a
//   reader can check any row's price against live peers in its own category.

/** One protocol record, exactly as the snapshot carries it. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label, printed on the page and in board.json. */
export const MODEL_VERSION = 'radar-signal-3.0';

/** The model's constants, shipped in the data file so the page can state them exactly. */
export const MODEL = {
  prior_base: 5,
  prior_per_spread: 2.5,
  prior_min: 5,
  prior_max: 20,
  ratio_floor: 0.01,
  ratio_cap: 3,
  multiple_floor: 0.03,
  multiple_cap: 2.5,
  growth_weight: 0.3,
  growth_floor_pct: -60,
  growth_cap_pct: 150,
  momentum_weight: 0.1,
  momentum_cap_pp: 40,
  overdue_weight: 0.45,
  overdue_days_cap: 1460,
  unknown_age_fraction: 0.4,
  chain_weight: 0.05,
  chain_cap: 8,
  signal_growth_pts: 30,
  signal_age_pts: 25,
  signal_confidence_pts: 20,
  signal_size_pts: 15,
  signal_breadth_pts: 10,
  signal_size_floor_usd: 5_000_000,
  signal_size_cap_usd: 2_000_000_000,
  comparables_shown: 96,
  peers_per_row: 4,
} as const;

/** How much a category's evidence can be trusted: its priced-peer count and their agreement. */
export type Confidence = 'high' | 'medium' | 'low';

/** Why a snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------- snapshot

/** The snapshot parsed out of a file's text, refused unless it carries the shape the model reads. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string' || o.source.length === 0) throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no usable floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const seen = new Set<string>();
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || p.slug.length === 0) throw new SnapshotError(`protocol ${i} has no slug`);
    if (seen.has(p.slug)) throw new SnapshotError(`protocol slug ${p.slug} appears twice`);
    seen.add(p.slug);
    if (typeof p.name !== 'string' || p.name.length === 0) throw new SnapshotError(`protocol ${p.slug} has no name`);
    if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd) || p.tvl_usd < 0) throw new SnapshotError(`protocol ${p.slug} has no usable tvl_usd`);
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) && p.mcap_usd > 0 ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- basics

const DAY_MS = 86_400_000;

/** Whole days from listed_at to the snapshot's as_of date; null when the record carries no date. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token when all three token fields are empty. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A protocol records a priced token when it carries a market cap. */
function recordsPricedToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.tvl_usd > 0;
}

const bySlugAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A quantile of a non-empty list, linearly interpolated between the two nearest ranks. */
function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  return s[lo]! + (s[lo + 1]! - s[lo]!) * (at - lo);
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- multiples

/** One category's evidence: how many priced peers it has, their raw median, and the multiple used. */
export interface CategoryMultiple {
  category: string;
  peers: number;
  raw_median: number | null;
  multiple: number;
  basis: 'category' | 'shrunk' | 'global';
  /** The interquartile range of the category's winsorised ratios; null when it has no priced peers. */
  iqr: number | null;
  /** iqr / median: how far apart the category's own peers sit, relative to their level. */
  spread: number | null;
  /** The shrinkage weight this category's dispersion earned it. */
  prior_weight: number;
  /** The confidence grade the peer count and spread together support. */
  confidence: Confidence;
}

/** Grade a category's evidence: many peers that agree are high; few peers, or peers scattered
 *  across the whole winsorised band, are low; everything between is medium. */
function confidenceFor(peers: number, spread: number | null): Confidence {
  if (peers >= 8 && spread !== null && spread <= 1.5) return 'high';
  if (peers <= 2 || spread === null || spread > 4) return 'low';
  return 'medium';
}

/** The multiple table derived from the snapshot's priced tokenised protocols. */
export interface Multiples {
  global_median: number;
  priced_peers: number;
  byCategory: Map<string, CategoryMultiple>;
}

/** Derive every category's multiple from the snapshot itself; nothing is looked up or hardcoded. */
export function deriveMultiples(snapshot: Snapshot): Multiples {
  const ratiosByCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsPricedToken(p)) continue;
    const ratio = Math.min(MODEL.ratio_cap, Math.max(MODEL.ratio_floor, p.mcap_usd! / p.tvl_usd));
    all.push(ratio);
    const cat = p.category ?? '';
    const list = ratiosByCat.get(cat);
    if (list === undefined) ratiosByCat.set(cat, [ratio]);
    else list.push(ratio);
  }
  const globalMedian = all.length > 0 ? median(all) : 0;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [cat, ratios] of ratiosByCat) {
    const raw = median(ratios);
    const n = ratios.length;
    const iqr = quantile(ratios, 0.75) - quantile(ratios, 0.25);
    // Dispersion of a single observation is undefined, not zero: one peer cannot agree with itself.
    // Two peers get a floor under their spread, because half a range is all the evidence they hold.
    const spread = n >= 2 && raw > 0 ? iqr / raw : null;
    const spreadEff = spread === null ? 6 : n === 2 ? Math.max(spread, 3) : spread;
    const prior = Math.round(
      Math.min(MODEL.prior_max, Math.max(MODEL.prior_min, MODEL.prior_base + MODEL.prior_per_spread * spreadEff)),
    );
    const shrunk = (n * raw + prior * globalMedian) / (n + prior);
    byCategory.set(cat, {
      category: cat,
      peers: n,
      raw_median: round6(raw),
      multiple: round6(Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, shrunk))),
      basis: n > prior ? 'category' : 'shrunk',
      iqr: round6(iqr),
      spread: spread === null ? null : round4(spread),
      prior_weight: prior,
      confidence: confidenceFor(n, spread),
    });
  }
  return { global_median: round6(globalMedian), priced_peers: all.length, byCategory };
}

/** The multiple one protocol is priced at: its category's, or the global median when it has no priced peers. */
export function multipleFor(multiples: Multiples, category: string | null): CategoryMultiple {
  const found = multiples.byCategory.get(category ?? '');
  if (found !== undefined) return found;
  return {
    category: category ?? '',
    peers: 0,
    raw_median: null,
    multiple: round6(Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, multiples.global_median))),
    basis: 'global',
    iqr: null,
    spread: null,
    prior_weight: MODEL.prior_max,
    confidence: 'low',
  };
}

// ---------------------------------------------------------------- category change context

/** One category's 7-day weather: every reported change in it, tokenised and pre-token alike. */
export interface CategoryChange {
  category: string;
  /** The category's median 7-day change; null when nobody in it reports one. */
  median_change: number | null;
  /** Every reported change in the category, ascending, for percentiles. */
  changes: number[];
}

/** Build every category's change context from the snapshot's own records. */
export function deriveCategoryChanges(snapshot: Snapshot): Map<string, CategoryChange> {
  const byCat = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.change_7d === null) continue;
    const cat = p.category ?? '';
    const list = byCat.get(cat);
    if (list === undefined) byCat.set(cat, [p.change_7d]);
    else list.push(p.change_7d);
  }
  const out = new Map<string, CategoryChange>();
  for (const [cat, changes] of byCat) {
    const sorted = [...changes].sort((a, b) => a - b);
    out.set(cat, { category: cat, median_change: round2(median(sorted)), changes: sorted });
  }
  return out;
}

/** Where a value sits inside a sorted list, as a 0..1 fraction; ties count half. */
function percentileOf(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return (below + 0.5 * equal) / sorted.length;
}

// ---------------------------------------------------------------- scoring

/** The five parts of one row's radar signal, each with the points it earned. */
export interface SignalParts {
  growth: number;
  age: number;
  confidence: number;
  size: number;
  breadth: number;
}

/** The full score of one pre-token protocol: the implied value and every component that made it. */
export interface Score {
  age_days: number | null;
  multiple: number;
  multiple_basis: 'category' | 'shrunk' | 'global';
  multiple_peers: number;
  multiple_confidence: Confidence;
  growth_pct: number | null;
  growth_factor: number;
  /** This protocol's 7-day change minus its category's median change, in percentage points. */
  momentum_pp: number | null;
  momentum_factor: number;
  overdue_factor: number;
  chain_factor: number;
  implied_value_usd: number;
  signal: number;
  signal_parts: SignalParts;
}

/** The signal's confidence points for one grade: the full twenty only when the multiple is well evidenced. */
function confidencePoints(confidence: Confidence): number {
  if (confidence === 'high') return MODEL.signal_confidence_pts;
  if (confidence === 'medium') return Math.round(MODEL.signal_confidence_pts * 0.6);
  return Math.round(MODEL.signal_confidence_pts * 0.25);
}

/** Score one protocol under the model. Pure: the same record always scores the same. */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  multiples: Multiples,
  changes: Map<string, CategoryChange>,
): Score {
  const mult = multipleFor(multiples, p.category);
  const catChange = changes.get(p.category ?? '');
  const age = ageDays(asOf, p.listed_at);
  let growthPct: number | null = null;
  let growthFactor = 1;
  let momentumPp: number | null = null;
  let momentumFactor = 1;
  if (p.change_7d !== null) {
    growthPct = round2(Math.min(MODEL.growth_cap_pct, Math.max(MODEL.growth_floor_pct, p.change_7d)));
    growthFactor = 1 + MODEL.growth_weight * (growthPct / 100);
    if (catChange !== undefined && catChange.median_change !== null) {
      momentumPp = round2(
        Math.min(MODEL.momentum_cap_pp, Math.max(-MODEL.momentum_cap_pp, p.change_7d - catChange.median_change)),
      );
      momentumFactor = 1 + MODEL.momentum_weight * (momentumPp / MODEL.momentum_cap_pp);
    }
  }
  const ageFraction = age === null ? MODEL.unknown_age_fraction : Math.min(age, MODEL.overdue_days_cap) / MODEL.overdue_days_cap;
  const overdueFactor = 1 + MODEL.overdue_weight * ageFraction;
  const chainFactor = 1 + MODEL.chain_weight * Math.min(Math.max(p.chains.length - 1, 0), MODEL.chain_cap);
  const implied = Math.max(1, Math.round(p.tvl_usd * mult.multiple * growthFactor * momentumFactor * overdueFactor * chainFactor));

  const growthPts =
    p.change_7d === null || catChange === undefined
      ? Math.round(MODEL.signal_growth_pts * 0.4)
      : Math.round(MODEL.signal_growth_pts * percentileOf(catChange.changes, p.change_7d));
  const agePts =
    age === null
      ? Math.round(MODEL.signal_age_pts * MODEL.unknown_age_fraction)
      : Math.round(MODEL.signal_age_pts * (Math.min(age, MODEL.overdue_days_cap) / MODEL.overdue_days_cap));
  const sizeSpan = Math.log10(MODEL.signal_size_cap_usd) - Math.log10(MODEL.signal_size_floor_usd);
  const sizeFrac = Math.min(1, Math.max(0, (Math.log10(Math.max(p.tvl_usd, 1)) - Math.log10(MODEL.signal_size_floor_usd)) / sizeSpan));
  const parts: SignalParts = {
    growth: growthPts,
    age: agePts,
    confidence: confidencePoints(mult.confidence),
    size: Math.round(MODEL.signal_size_pts * sizeFrac),
    breadth: Math.round(MODEL.signal_breadth_pts * (Math.min(Math.max(p.chains.length - 1, 0), MODEL.chain_cap) / MODEL.chain_cap)),
  };
  return {
    age_days: age,
    multiple: mult.multiple,
    multiple_basis: mult.basis,
    multiple_peers: mult.peers,
    multiple_confidence: mult.confidence,
    growth_pct: growthPct,
    growth_factor: round4(growthFactor),
    momentum_pp: momentumPp,
    momentum_factor: round4(momentumFactor),
    overdue_factor: round4(overdueFactor),
    chain_factor: round4(chainFactor),
    implied_value_usd: implied,
    signal: parts.growth + parts.age + parts.confidence + parts.size + parts.breadth,
    signal_parts: parts,
  };
}

// ---------------------------------------------------------------- board selection

/** Categories that are products of an asset that already trades, or an exchange's own balance sheet. */
const PRODUCT_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
/** A name ending in a version marker is a pool of another protocol, not a launch of its own. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A name carrying a whole word wrapped, staked or staking is a wrapped or staked product. */
const WRAPPED_NAME = /\b(wrapped|staked|staking)\b/i;
/** A name beginning with an exchange's name is that exchange's product. */
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a pre-token protocol is a launch candidate in its own right: it passes the same product
 * test the house's watchlist applies, so the board never ranks an exchange, a bridge wrapper or a
 * versioned pool as if it were waiting on a first token.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name) || WRAPPED_NAME.test(p.name) || EXCHANGE_NAME.test(p.name)) return false;
  return true;
}

// ---------------------------------------------------------------- farm plans

/** A tiny deterministic hash of a slug, so per-protocol variation never needs a clock or a coin flip. */
function slugSeed(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The next pick from a seeded stream: an index into a list of `count` variants. */
function pick(seed: number, salt: number, count: number): number {
  let x = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) % count;
}

/** The capital a sensible first position needs, from the protocol's own size. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 500;
  if (tvl >= 250_000_000) return 250;
  if (tvl >= 50_000_000) return 150;
  if (tvl >= 15_000_000) return 75;
  return 50;
}

/** A rough one-way gas allowance for a chain, in dollars, as the plan states it. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 12;
  if (chain === 'Solana' || chain === 'Base' || chain === 'Arbitrum' || chain === 'Optimism' || chain === 'Polygon' || chain === 'BSC') return 1;
  if (chain === 'Avalanche' || chain === 'Linea' || chain === 'Scroll' || chain === 'Mantle') return 2;
  return 3;
}

/** How long a position should season, from the protocol's age: younger records get the longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 365) return 60;
  if (age < 900) return 45;
  return 30;
}

/** The core qualifying action for a category, written for a reader who will actually do it. */
function coreAction(category: string | null, name: string, chain: string, capital: number): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC as collateral in ${name} on ${chain}, then borrow about 40% of it and repay within the week so the account shows both sides of the market`;
  if (c.includes('dex') || c.includes('liquidity')) return `Add $${capital} of liquidity to ${name}'s deepest stablecoin pair on ${chain} and leave the position open; route your normal swaps through ${name} while it is live`;
  if (c.includes('deriv') || c.includes('perpetual')) return `Deposit $${capital} of USDC margin in ${name} on ${chain} and hold one small hedged position (long one market, short the same size elsewhere) so the account trades without directional risk`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('index')) return `Deposit $${capital} into a flagship curated vault in ${name} on ${chain} and keep the vault shares in the same wallet for the whole window`;
  if (c.includes('rwa')) return `Subscribe $${capital} to ${name}'s flagship tokenised asset on ${chain} and hold it; if subscriptions are gated, join the allowlist and complete the onboarding instead`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token; do not sell or re-pledge it during the window`;
  if (c.includes('prediction')) return `Fund ${name} with $${capital} on ${chain} and hold positions in at least two open markets until they settle`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} against a position you actually hold, and keep the policy to expiry`;
  if (c.includes('stable') || c.includes('basis') || c.includes('cede')) return `Deposit $${capital} of USDC into ${name}'s flagship vault on ${chain} and hold the yield-bearing shares it issues`;
  if (c.includes('payment') || c.includes('card')) return `Open a ${name} account, load $${capital} on ${chain} and route two weeks of spending you would make anyway through it`;
  if (c.includes('chain')) return `Bridge $${capital} to ${chain} through ${name}'s canonical route, keep a balance there and use two native apps so the wallet reads as a resident, not a passer-by`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${name} on ${chain} in the protocol's standard denomination and leave it pooled for the full window`;
  if (c.includes('yield') || c.includes('farm') || c.includes('aggregator')) return `Deposit $${capital} of USDC into ${name}'s flagship vault on ${chain} and compound the yield back into the same vault each week`;
  return `Deposit $${capital} of USDC into ${name}'s flagship product on ${chain} and keep the position open for the whole window`;
}

/** The weekly upkeep action for a category. */
function weeklyAction(category: string | null, name: string): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return `adjust the borrow so the health factor stays above 2.0 and claim any rewards ${name} shows`;
  if (c.includes('dex') || c.includes('liquidity')) return `make two swaps through ${name} and re-centre the liquidity if the price has drifted out of range`;
  if (c.includes('deriv') || c.includes('perpetual')) return `roll the hedge in ${name} so the two legs stay the same size and the funding paid stays near zero`;
  if (c.includes('prediction')) return `add one position in a new market on ${name} so the account is active in more than one question`;
  return `make one small deposit or claim in ${name} so the wallet is active in a fresh week, not just an old one`;
}

/**
 * One protocol's farm plan: concrete steps with a cost and a time on each, parameterised by the
 * protocol's own record (name, category, chains, TVL, age) and varied by a seed drawn from its slug,
 * so two protocols in the same category do not read as photocopies. The shape is a real campaign:
 * set up, enter in two tranches a week apart, keep a weekly cadence, review at the midpoint, hold
 * to the end of the window, then claim safely and log everything.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const seed = slugSeed(p.slug);
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its home chain';
  const gas = gasFor(chain);
  const capital = capitalFor(p.tvl_usd);
  const firstTranche = Math.round(capital * 0.6);
  const secondTranche = capital - firstTranche;
  const hold = holdDaysFor(age);
  const weeks = Math.max(2, Math.round(hold / 7));
  const midDay = Math.round(hold / 2);
  const walletLines = [
    `Start from a fresh wallet funded only with what this plan needs, and store its recovery phrase offline, never in a screenshot or a cloud note`,
    `Use one dedicated wallet for ${p.name} alone, so its activity is clean to read and easy to unwind later`,
  ];
  const steps: string[] = [];
  steps.push(`${walletLines[pick(seed, 1, walletLines.length)]}. Cost: about $${gas} of gas to make the first transaction on ${chain}. Time: 10 minutes.`);
  steps.push(`${coreAction(p.category, p.name, chain, firstTranche)} — this is tranche one, about 60% of the plan's capital; the rest follows in a week so the wallet's history is not a single day. Cost: $${firstTranche} of capital plus about $${gas * 2} of gas. Time: 20 minutes to set up.`);
  if (p.chains.length >= 3) {
    const second = p.chains[1 + pick(seed, 2, Math.min(3, p.chains.length - 1))]!;
    steps.push(`On day 7, repeat a smaller version on ${second}: move about $${Math.max(25, Math.floor(capital / 3))} through ${p.name} there too, because multi-chain users are the ones launches usually weight most. Cost: about $${gasFor(second) * 2} of gas plus bridge fees near $2. Time: 15 minutes.`);
  } else {
    steps.push(`On day 7, add tranche two: another $${secondTranche} into the same ${p.name} position on ${chain}, so the account's activity spans two weekly snapshots instead of one. Cost: $${secondTranche} of capital plus about $${gas} of gas. Time: 10 minutes.`);
  }
  steps.push(`Once a week for the next ${weeks} weeks, ${weeklyAction(p.category, p.name)}. Cost: about $${gas} of gas a week, near $${gas * weeks} across the window. Time: 10 minutes a week.`);
  steps.push(`At the midpoint, day ${midDay}, do a review pass: open ${p.name}'s official site from your own bookmark, confirm the position is still live and its balance reads as expected, and screenshot it for the journal. Cost: nothing but about $${gas} of gas if the review needs a transaction. Time: 10 minutes.`);
  steps.push(`Hold the position for at least ${hold} days so the activity spans more than one weekly snapshot of the protocol. Cost: the $${capital} stays committed and carries the protocol's own smart-contract risk. Time: ${hold} days.`);
  const exitLines = [
    `When you finish, check ${p.name}'s own site and verified socials for a points or rewards page and claim only from links published there; a claim never asks for a fee or a signature you cannot read`,
    `Before withdrawing, open ${p.name}'s official points page from its own site (never from a search ad or a DM) and screenshot your balance for your records`,
  ];
  steps.push(`${exitLines[pick(seed, 3, exitLines.length)]}. Cost: nothing to check, and never pay to claim. Time: 10 minutes.`);
  steps.push(`Log the wallet address, every date and every transaction hash in a farm journal, so the position can be repeated, proved or unwound without guesswork. Cost: nothing but the log. Time: 5 minutes.`);
  return steps;
}

// ---------------------------------------------------------------- the board

/** One row of board.json, with the model's working shown beside the value it produced. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  watchlist: boolean;
  implied_value_usd: number;
  signal: number;
  model: {
    multiple: number;
    multiple_basis: 'category' | 'shrunk' | 'global';
    multiple_peers: number;
    multiple_confidence: Confidence;
    growth_pct: number | null;
    growth_factor: number;
    momentum_pp: number | null;
    momentum_factor: number;
    overdue_factor: number;
    chain_factor: number;
  };
  farm_steps: string[];
}

/** Rank the board: every watchlist slug plus every launch candidate, by implied value. */
export function buildBoard(snapshot: Snapshot, multiples: Multiples, changes: Map<string, CategoryChange>): BoardRow[] {
  const onWatchlist = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => onWatchlist.has(p.slug) || isLaunchCandidate(p));
  const scored = chosen.map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, multiples, changes) }));
  scored.sort((a, b) => b.score.implied_value_usd - a.score.implied_value_usd || bySlugAsc(a.p.slug, b.p.slug));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.score.age_days,
    token_status: 'pre-token',
    watchlist: onWatchlist.has(s.p.slug),
    implied_value_usd: s.score.implied_value_usd,
    signal: s.score.signal,
    model: {
      multiple: s.score.multiple,
      multiple_basis: s.score.multiple_basis,
      multiple_peers: s.score.multiple_peers,
      multiple_confidence: s.score.multiple_confidence,
      growth_pct: s.score.growth_pct,
      growth_factor: s.score.growth_factor,
      momentum_pp: s.score.momentum_pp,
      momentum_factor: s.score.momentum_factor,
      overdue_factor: s.score.overdue_factor,
      chain_factor: s.score.chain_factor,
    },
    farm_steps: farmSteps(s.p, s.score.age_days),
  }));
}

// ---------------------------------------------------------------- comparables & peers

/** A tokenised protocol as the dashboard shows it: the market's own value, not a model's. */
export interface ComparableRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

/** The comparables set: every priced tokenised protocol, biggest market cap first, capped for the data file. */
export function buildComparables(snapshot: Snapshot): ComparableRow[] {
  return snapshot.protocols
    .filter(recordsPricedToken)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || bySlugAsc(a.slug, b.slug))
    .slice(0, MODEL.comparables_shown)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: round4(p.mcap_usd! / p.tvl_usd),
      change_7d: p.change_7d,
    }));
}

/** One live peer shown in a board row's detail view. */
export interface PeerRow {
  name: string;
  symbol: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

/** The priced peers nearest in TVL inside one protocol's own category: the check on its multiple. */
export function peersFor(p: SnapshotProtocol, snapshot: Snapshot): PeerRow[] {
  if (p.category === null) return [];
  return snapshot.protocols
    .filter((q) => q.category === p.category && recordsPricedToken(q))
    .sort((a, b) => Math.abs(Math.log(a.tvl_usd / p.tvl_usd)) - Math.abs(Math.log(b.tvl_usd / p.tvl_usd)) || bySlugAsc(a.slug, b.slug))
    .slice(0, MODEL.peers_per_row)
    .map((q) => ({ name: q.name, symbol: q.symbol, tvl_usd: q.tvl_usd, mcap_usd: q.mcap_usd!, ratio: round4(q.mcap_usd! / q.tvl_usd) }));
}

// ---------------------------------------------------------------- the dashboard's data

/** A board row as the dashboard carries it: the board row plus its live peers and signal parts. */
export interface DataRow extends BoardRow {
  peers: PeerRow[];
  signal_parts: SignalParts;
  /** The median 7-day change of this row's own category, for the momentum readout. */
  category_median_change: number | null;
}

/** Everything the dashboard renders, computed once from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: {
    prior_base: number;
    prior_per_spread: number;
    prior_min: number;
    prior_max: number;
    ratio_floor: number;
    ratio_cap: number;
    multiple_floor: number;
    multiple_cap: number;
    growth_weight: number;
    growth_floor_pct: number;
    growth_cap_pct: number;
    momentum_weight: number;
    momentum_cap_pp: number;
    overdue_weight: number;
    overdue_days_cap: number;
    chain_weight: number;
    chain_cap: number;
    signal_growth_pts: number;
    signal_age_pts: number;
    signal_confidence_pts: number;
    signal_size_pts: number;
    signal_breadth_pts: number;
    global_median: number;
    priced_peers: number;
    categories: CategoryMultiple[];
  };
  stats: {
    protocols: number;
    pre_token: number;
    tokenised: number;
    board_rows: number;
    watchlist: number;
    comparables: number;
  };
  rows: DataRow[];
  comparables: ComparableRow[];
}

/** Build the board and the dashboard's data from one snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; data: RadarData } {
  const multiples = deriveMultiples(snapshot);
  const changes = deriveCategoryChanges(snapshot);
  const board = buildBoard(snapshot, multiples, changes);
  const comparables = buildComparables(snapshot);
  const bySlugMap = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const categories = [...multiples.byCategory.values()]
    .filter((c) => c.category !== '')
    .sort((a, b) => b.peers - a.peers || bySlugAsc(a.category, b.category));
  const data: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      prior_base: MODEL.prior_base,
      prior_per_spread: MODEL.prior_per_spread,
      prior_min: MODEL.prior_min,
      prior_max: MODEL.prior_max,
      ratio_floor: MODEL.ratio_floor,
      ratio_cap: MODEL.ratio_cap,
      multiple_floor: MODEL.multiple_floor,
      multiple_cap: MODEL.multiple_cap,
      growth_weight: MODEL.growth_weight,
      growth_floor_pct: MODEL.growth_floor_pct,
      growth_cap_pct: MODEL.growth_cap_pct,
      momentum_weight: MODEL.momentum_weight,
      momentum_cap_pp: MODEL.momentum_cap_pp,
      overdue_weight: MODEL.overdue_weight,
      overdue_days_cap: MODEL.overdue_days_cap,
      chain_weight: MODEL.chain_weight,
      chain_cap: MODEL.chain_cap,
      signal_growth_pts: MODEL.signal_growth_pts,
      signal_age_pts: MODEL.signal_age_pts,
      signal_confidence_pts: MODEL.signal_confidence_pts,
      signal_size_pts: MODEL.signal_size_pts,
      signal_breadth_pts: MODEL.signal_breadth_pts,
      global_median: multiples.global_median,
      priced_peers: multiples.priced_peers,
      categories,
    },
    stats: {
      protocols: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter(recordsNoToken).length,
      tokenised: snapshot.protocols.filter((p) => !recordsNoToken(p)).length,
      board_rows: board.length,
      watchlist: snapshot.watchlist.length,
      comparables: comparables.length,
    },
    rows: board.map((row) => {
      const p = bySlugMap.get(row.slug)!;
      const score = scoreProtocol(p, snapshot.as_of, multiples, changes);
      return {
        ...row,
        peers: peersFor(p, snapshot),
        signal_parts: score.signal_parts,
        category_median_change: changes.get(row.category ?? '')?.median_change ?? null,
      };
    }),
    comparables,
  };
  return { board, data };
}

/** The data file the dashboard loads: one script, no fetch, no network. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}

// ---------------------------------------------------------------- self-check

/** Why a board is not one the gate will take, or null. Mirrors the gate's board rows one for one. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set<string>();
  for (const r of board) {
    if (slugs.has(r.slug)) return `slug ${r.slug} appears twice`;
    slugs.add(r.slug);
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `slug ${r.slug} is not in the snapshot`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is held by ${byRank[i]!.slug} with rank ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} (${byRank[i]!.slug}) is worth more than rank ${i}`;
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every row carries the same implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.name.trim().length === 0) return `${r.slug} has an empty name`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} trimmed characters`;
    }
  }
  return null;
}
