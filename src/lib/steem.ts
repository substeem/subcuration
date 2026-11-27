import { call, utils } from '@substeem/steem-sdk';
import {
  ALL_CURATOR_MEMBERS,
  COMMUNITY_CURATOR_TEAMS,
  CURATION_ACCOUNTS,
  KNOWN_BOT_ACCOUNTS,
  RPC_NODES,
  SUBSTEEM_PROTOCOL_ID,
  isLowQualityOrBotPost,
  isNsfwPost,
} from './constants';
import type { PostItem, CurationClaim, CurationTeam } from '../types';
import {
  countWordsMultilingual,
  extractPlainExcerpt,
  extractPostImages,
  detectPostLanguage,
  detectVideoPost,
} from './textUtils';

export const LOCAL_CLAIMS_KEY = 'substeem_curation_claims_cache_v1';
const COMMUNITY_CACHE_KEY = 'substeem_community_titles_v1';
const COMMUNITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let currentRpcIndex = 0;

/**
 * Direct JSON-RPC POST helper for genuine multi-node failover with array or named params.
 */
async function directRpcFetch<T>(
  nodeUrl: string,
  method: string,
  params: any[] | Record<string, any>
): Promise<T> {
  const res = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now(),
    }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${nodeUrl}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message || `RPC error from ${nodeUrl}`);
  }

  return json.result as T;
}

/**
 * Tries @substeem/steem-sdk first, then genuinely fails over across RPC_NODES.
 * Supports both array and named-object parameters (required for Bridge API calls).
 */
export async function safeCall<T = any>(
  method: string,
  params: any[] | Record<string, any> = []
): Promise<T> {
  let lastError: unknown;
  const isArrayParams = Array.isArray(params);

  for (let attempt = 0; attempt < RPC_NODES.length; attempt++) {
    const nodeUrl = RPC_NODES[currentRpcIndex];
    try {
      if (attempt === 0 && currentRpcIndex === 0 && isArrayParams) {
        return (await call(method, params)) as T;
      }
      return await directRpcFetch<T>(nodeUrl, method, params);
    } catch (err) {
      lastError = err;
      console.warn(`RPC call ${method} failed on ${nodeUrl}:`, err);
      currentRpcIndex = (currentRpcIndex + 1) % RPC_NODES.length;
    }
  }

  throw new Error(
    `Failed to call ${method} across all ${RPC_NODES.length} RPC nodes: ${String(lastError)}`
  );
}

/**
 * Executes a JSON-RPC 2.0 batch array against RPC_NODES with failover.
 */
async function batchRpcCall<T = any>(
  requests: { method: string; params: any[] | Record<string, any> }[],
  chunkSize = 40
): Promise<(T | null)[]> {
  if (requests.length === 0) return [];
  const results: (T | null)[] = new Array(requests.length).fill(null);

  for (let offset = 0; offset < requests.length; offset += chunkSize) {
    const chunk = requests.slice(offset, offset + chunkSize);
    const payload = chunk.map((r, idx) => ({
      jsonrpc: '2.0',
      method: r.method,
      params: r.params,
      id: idx + 1,
    }));

    let succeeded = false;
    for (let attempt = 0; attempt < RPC_NODES.length; attempt++) {
      const nodeUrl = RPC_NODES[currentRpcIndex];
      try {
        const res = await fetch(nodeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json)) throw new Error('Expected JSON-RPC batch array response');

        for (const entry of json) {
          if (entry && typeof entry.id === 'number' && !entry.error) {
            results[offset + entry.id - 1] = entry.result as T;
          }
        }
        succeeded = true;
        break;
      } catch (err) {
        console.warn(`Batch RPC failed on ${nodeUrl}:`, err);
        currentRpcIndex = (currentRpcIndex + 1) % RPC_NODES.length;
      }
    }

    if (!succeeded) {
      const fallback = await Promise.allSettled(
        chunk.map((r) => safeCall<T>(r.method, r.params))
      );
      fallback.forEach((res, idx) => {
        if (res.status === 'fulfilled') results[offset + idx] = res.value;
      });
    }
  }

  return results;
}

/**
 * Pages backwards through condenser_api.get_account_history in compliant batches of <= 100
 * operations until cutoffMs is reached (avoids api.steemit.com's 100-op upper limit error).
 */
async function fetchAccountHistoryWindow(
  account: string,
  cutoffMs: number,
  maxBatches = 25
): Promise<[number, any][]> {
  const entries: [number, any][] = [];
  const seenSeq = new Set<number>();
  let start = -1;

  for (let batch = 0; batch < maxBatches; batch++) {
    const batchLimit = start === -1 ? 100 : Math.min(100, start);
    if (batchLimit <= 0) break;

    const history = await safeCall<any[]>('condenser_api.get_account_history', [
      account,
      start,
      batchLimit,
    ]);
    if (!Array.isArray(history) || history.length === 0) break;

    let reachedCutoff = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const [seq, item] = history[i];
      if (seenSeq.has(seq)) continue;
      seenSeq.add(seq);

      const ts = Date.parse(`${item.timestamp}Z`);
      if (!Number.isNaN(ts) && ts < cutoffMs) {
        reachedCutoff = true;
        break;
      }
      entries.push([seq, item]);
    }

    const firstSeq = history[0][0];
    if (reachedCutoff || firstSeq <= 0) break;
    start = firstSeq - 1;
  }

  return entries;
}

/**
 * Resolves raw Steem community IDs (e.g. hive-144064) to human-readable titles
 * via bridge.get_community with 24h localStorage caching.
 */
export async function fetchCommunityTitles(
  categories: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const hiveIds = Array.from(
    new Set(categories.filter((c) => /^hive-\d+$/i.test(c)).map((c) => c.toLowerCase()))
  );
  if (hiveIds.length === 0) return result;

  const now = Date.now();
  let cacheStore: Record<string, { title: string; timestamp: number }> = {};

  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(COMMUNITY_CACHE_KEY);
      if (raw) cacheStore = JSON.parse(raw);
    } catch {
      cacheStore = {};
    }
  }

  const missing: string[] = [];
  for (const id of hiveIds) {
    const hit = cacheStore[id];
    if (hit && now - hit.timestamp < COMMUNITY_CACHE_TTL_MS && hit.title) {
      result.set(id, hit.title);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    const settled = await Promise.allSettled(
      missing.map((name) => safeCall<any>('bridge.get_community', { name }))
    );

    settled.forEach((res, idx) => {
      const id = missing[idx];
      if (res.status === 'fulfilled' && res.value?.title) {
        const title = String(res.value.title).trim();
        result.set(id, title);
        cacheStore[id] = { title, timestamp: now };
      }
    });

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(COMMUNITY_CACHE_KEY, JSON.stringify(cacheStore));
      } catch {
        // Ignore quota errors
      }
    }
  }

  return result;
}

function parseJsonMetadataTags(rawMeta: unknown): string[] {
  try {
    const parsed = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
    if (parsed && Array.isArray((parsed as any).tags)) {
      return (parsed as any).tags.map((t: any) => String(t).toLowerCase());
    }
  } catch {
    // Ignore malformed json_metadata
  }
  return [];
}

function mapRawDiscussionToPostItem(
  p: any,
  nowMs: number,
  claimsMap: Map<string, CurationClaim>,
  communityTitles?: Map<string, string>
): PostItem {
  const createdMs = Date.parse(`${p.created}Z`);
  const ageHours = Number.isNaN(createdMs) ? 0 : Math.max(0, (nowMs - createdMs) / 3600000);

  const activeVotes = Array.isArray(p.active_votes) ? p.active_votes : [];
  const curatorVotes = activeVotes.filter((v: any) => CURATION_ACCOUNTS.includes(v.voter));

  const body = typeof p.body === 'string' ? p.body : '';
  const trimmedBody = body.trim();
  // Extract images on raw post.body BEFORE running excerpt sanitization
  const images = extractPostImages({ body, json_metadata: p.json_metadata });
  const imageCount = images.length;
  const wordCount = countWordsMultilingual(body);
  const plainExcerpt = extractPlainExcerpt(body, 220, p.title);

  const pendingPayout = parseFloat(p.pending_payout_value?.split(' ')[0] || '0.00');
  const claimKey = `${p.author}/${p.permlink}`;
  const categoryStr = String(p.category || '').toLowerCase();
  const communityTitle = communityTitles?.get(categoryStr);

  const tags = parseJsonMetadataTags(p.json_metadata);
  const hasBurnTag = tags.some((t) => t.toLowerCase() === 'burnsteem25');
  const beneficiaries = Array.isArray(p.beneficiaries) ? p.beneficiaries : [];
  const hasNullBeneficiary = beneficiaries.some(
    (b: any) => b.account === 'null' && Number(b.weight) >= 2500
  );
  const isBurnSteem25 = hasBurnTag || hasNullBeneficiary;
  const isSteemExclusive = tags.some((t) => t.toLowerCase().includes('steemexclusive'));
  const isVideoPost = detectVideoPost(body);
  const language = detectPostLanguage({
    body,
    title: p.title,
    category: p.category,
    tags,
    json_metadata: p.json_metadata,
  });

  const parentAuthor = typeof p.parent_author === 'string' ? p.parent_author.trim() : '';
  const isComment = Boolean(parentAuthor) || Number(p.depth || 0) > 0;
  const resolvedTitle =
    p.title && String(p.title).trim().length > 0
      ? p.title
      : parentAuthor
      ? `Comment on @${parentAuthor}`
      : '';

  return {
    id: p.id,
    author: p.author,
    authorReputation: p.author_reputation,
    permlink: p.permlink,
    title: resolvedTitle,
    body,
    category: p.category,
    created: p.created,
    ageHours: Math.round(ageHours * 10) / 10,
    pendingPayout,
    totalVotes: activeVotes.length,
    commentCount: Number(p.children || 0),
    curationVotesCount: curatorVotes.length,
    curatorVoted: curatorVotes.length > 0,
    curatorAccountsVoted: curatorVotes.map((v: any) => v.voter),
    wordCount,
    imageCount,
    images,
    json_metadata: p.json_metadata,
    communityTitle,
    plainExcerpt,
    claim: claimsMap.get(claimKey),
    // Extra chain metadata consumed by App.tsx Rescue & Diversity filters
    ...(p.cashout_time ? { cashoutTime: p.cashout_time } : {}),
    bodyLength: trimmedBody.length,
    tags,
    beneficiaries,
    isBurnSteem25,
    isSteemExclusive,
    isVideoPost,
    language,
    isComment,
    ...(parentAuthor ? { parentAuthor } : {}),
  } as PostItem;
}

/**
 * Persists a claim locally so UI reflects broadcasts instantly before chain indexing catches up.
 */
export function saveLocalClaim(claim: CurationClaim | null, author: string, permlink: string): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(LOCAL_CLAIMS_KEY);
    const parsed: Record<string, CurationClaim> = raw ? JSON.parse(raw) : {};
    const key = `${author}/${permlink}`;
    if (claim) {
      parsed[key] = claim;
    } else {
      delete parsed[key];
    }
    localStorage.setItem(LOCAL_CLAIMS_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Fetch on-chain claims & revision states via custom_json merged with localStorage cache.
 */
export async function fetchRecentClaims(): Promise<Map<string, CurationClaim>> {
  const claimsMap = new Map<string, CurationClaim>();

  // 1. Seed from localStorage optimistic cache
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(LOCAL_CLAIMS_KEY);
      if (raw) {
        const cached: Record<string, CurationClaim> = JSON.parse(raw);
        for (const [k, v] of Object.entries(cached)) {
          claimsMap.set(k, v);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 2. Scan recent custom_json ops across team curation accounts
  try {
    const sampleAccounts = COMMUNITY_CURATOR_TEAMS.map((t) => t.account);
    const histories = await Promise.allSettled(
      sampleAccounts.map((acc) =>
        safeCall<any[]>('condenser_api.get_account_history', [acc, -1, 100])
      )
    );

    for (const res of histories) {
      if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
      for (const [, item] of res.value) {
        const [opName, opData] = item.op || [];
        if (opName !== 'custom_json' || opData?.id !== SUBSTEEM_PROTOCOL_ID) continue;

        try {
          const payload = JSON.parse(opData.json);
          if (!payload.author || !payload.permlink) continue;
          const key = `${payload.author}/${payload.permlink}`;

          if (payload.action === 'release' || payload.action === 'unclaim') {
            claimsMap.delete(key);
          } else {
            claimsMap.set(key, {
              ...payload,
              timestamp: item.timestamp,
              txId: item.trx_id,
            } as CurationClaim);
          }
        } catch {
          // Skip malformed custom_json payloads
        }
      }
    }
  } catch (error) {
    console.warn('Could not sync on-chain custom_json claims:', error);
  }

  return claimsMap;
}

/**
 * Fetch discussions in the curation window + hydrate on-chain claims & community titles.
 * Completely filters out #nsfw posts.
 */
export async function fetchCurationFeed(limit = 50): Promise<PostItem[]> {
  try {
    const [rawPosts, claimsMap] = await Promise.all([
      safeCall<any[]>('condenser_api.get_discussions_by_created', [{ limit: limit + 10 }]),
      fetchRecentClaims(),
    ]);
    const cleanRawPosts = (rawPosts || []).filter((p) => !isNsfwPost(p));
    const now = Date.now();
    const categories = cleanRawPosts.map((p) => String(p.category || ''));
    const communityTitles = await fetchCommunityTitles(categories);
    return cleanRawPosts
      .map((p) => mapRawDiscussionToPostItem(p, now, claimsMap, communityTitles))
      .filter((p) => !isNsfwPost(p))
      .slice(0, limit);
  } catch (error) {
    console.error('Error fetching curation feed:', error);
    return [];
  }
}

/**
 * Paginates backward in time from a specific start post cursor (Load More).
 * Completely filters out #nsfw posts.
 */
export async function fetchMoreCurationFeed(
  startAuthor: string,
  startPermlink: string,
  limit = 50
): Promise<PostItem[]> {
  try {
    const [rawPosts, claimsMap] = await Promise.all([
      safeCall<any[]>('condenser_api.get_discussions_by_created', [
        { limit: limit + 15, start_author: startAuthor, start_permlink: startPermlink },
      ]),
      fetchRecentClaims(),
    ]);
    if (!Array.isArray(rawPosts) || rawPosts.length <= 1) return [];
    // Drop first post which matches the startAuthor/startPermlink cursor and filter NSFW
    const nextBatch = rawPosts.slice(1).filter((p) => !isNsfwPost(p));
    const now = Date.now();
    const categories = nextBatch.map((p) => String(p.category || ''));
    const communityTitles = await fetchCommunityTitles(categories);
    return nextBatch
      .map((p) => mapRawDiscussionToPostItem(p, now, claimsMap, communityTitles))
      .filter((p) => !isNsfwPost(p))
      .slice(0, limit);
  } catch (error) {
    console.error('Error fetching more curation feed:', error);
    return [];
  }
}

/**
 * Returns the currently active connected RPC node hostname for telemetry/status display.
 */
export function getCurrentRpcNode(): string {
  try {
    const url = RPC_NODES[currentRpcIndex] || RPC_NODES[0];
    return new URL(url).hostname;
  } catch {
    return 'api.steemit.com';
  }
}

export interface RescueScanResult {
  posts: PostItem[];
  nextStartKey: [string, string, string] | null;
  hasMore: boolean;
}

/**
 * Scans the blockchain specifically for high-effort posts in danger of expiring
 * without official curation support (between minHoursToExpiry and maxHoursToExpiry from cashout).
 * Queries database_api.list_comments with order: 'by_cashout_time' to find genuine near-expiry posts.
 *
 * NOTE: Steemit posts cash out at 7.0 days (168h). Posts older than 6 days and 12 hours (156h)
 * have under 12 hours remaining, which is too short for team voting rounds and revision windows.
 * Therefore, minHoursToExpiry defaults to 12 hours (i.e. <= 6d 12h old).
 */
export async function fetchRescueCandidates(
  limit = 30,
  minHoursToExpiry = 12,
  maxHoursToExpiry = 72,
  startKey?: [string, string, string] | null
): Promise<RescueScanResult> {
  const now = Date.now();
  const startCashoutTime = new Date(now + minHoursToExpiry * 3600 * 1000)
    .toISOString()
    .slice(0, 19);
  const minCashoutMs = now + minHoursToExpiry * 3600 * 1000;
  const maxCashoutTimeMs = now + maxHoursToExpiry * 3600 * 1000;

  const claimsMap = await fetchRecentClaims();
  const targetCandidates: { author: string; permlink: string }[] = [];
  const seen = new Set<string>();

  let currentKey: [string, string, string] =
    startKey && startKey.length === 3 ? startKey : [startCashoutTime, '', ''];
  const pages = 4;
  const batchSize = 100;
  let nextStartKey: [string, string, string] | null = null;
  let hasMore = true;

  for (let page = 0; page < pages; page++) {
    try {
      const res = await safeCall<{ comments: any[] }>('database_api.list_comments', {
        start: currentKey,
        limit: batchSize,
        order: 'by_cashout_time',
      });

      const batch = res?.comments;
      if (!Array.isArray(batch) || batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const c of batch) {
        // Skip comments (only top-level posts have empty parent_author)
        if (c.parent_author) continue;

        const cashoutMs = Date.parse(`${c.cashout_time}Z`);
        if (Number.isNaN(cashoutMs) || cashoutMs > maxCashoutTimeMs) {
          hasMore = false;
          continue;
        }

        // Exclude posts older than 6 days 12 hours (less than 12 hours remaining)
        if (cashoutMs < minCashoutMs) continue;

        const key = `${c.author}/${c.permlink}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const bodyLen = c.body ? c.body.length : 0;
        if (bodyLen < 900) continue;

        // Banned #nsfw check immediately on raw comment
        if (isNsfwPost(c)) continue;

        const author = String(c.author || '').toLowerCase();
        if (ALL_CURATOR_MEMBERS.has(author) || KNOWN_BOT_ACCOUNTS.has(author)) {
          continue;
        }

        targetCandidates.push({ author: c.author, permlink: c.permlink });
        if (targetCandidates.length >= limit * 2) break;
      }

      const last = batch[batch.length - 1];
      const lastCashoutMs = Date.parse(`${last.cashout_time}Z`);
      if (lastCashoutMs > maxCashoutTimeMs) {
        hasMore = false;
        nextStartKey = null;
        break;
      }

      nextStartKey = [last.cashout_time, last.author, last.permlink];
      currentKey = nextStartKey;

      if (targetCandidates.length >= limit * 2) break;
      if (batch.length < batchSize) {
        hasMore = false;
        nextStartKey = null;
        break;
      }
    } catch (err) {
      console.warn(`Error scanning by_cashout_time on page ${page + 1}:`, err);
      break;
    }
  }

  if (targetCandidates.length === 0) {
    return { posts: [], nextStartKey, hasMore: hasMore && Boolean(nextStartKey) };
  }

  // Fetch full post discussions via condenser_api.get_content to obtain active_votes & pending_payout
  const contentResults = await Promise.allSettled(
    targetCandidates.slice(0, limit * 2).map((t) =>
      safeCall<any>('condenser_api.get_content', [t.author, t.permlink])
    )
  );

  const fullDiscussions: any[] = [];
  for (const res of contentResults) {
    if (res.status === 'fulfilled' && res.value && res.value.author && res.value.title) {
      fullDiscussions.push(res.value);
    }
  }

  // Resolve community titles
  const categories = fullDiscussions.map((p) => String(p.category || ''));
  const communityTitles = await fetchCommunityTitles(categories);

  const mapped: PostItem[] = [];
  for (const raw of fullDiscussions) {
    if (isNsfwPost(raw)) continue;

    const postItem = mapRawDiscussionToPostItem(raw, now, claimsMap, communityTitles);

    // Banned #nsfw post check
    if (isNsfwPost(postItem)) continue;

    // Must not have an official curation team vote
    if (postItem.curatorVoted) continue;

    // Must be sitting under $1.00
    if (postItem.pendingPayout >= 1.0) continue;

    // Filter out spam / bot / gambling posts
    if (isLowQualityOrBotPost(postItem)) continue;

    // Must have at least 200 words
    if (postItem.wordCount < 200) continue;

    mapped.push(postItem);
  }

  // Sort by cashout time ascending (most urgent first: expiring in 12h, 14h, 16h...)
  const sorted = mapped
    .sort((a, b) => {
      const expA = a.cashoutTime ? Date.parse(`${a.cashoutTime}Z`) : Infinity;
      const expB = b.cashoutTime ? Date.parse(`${b.cashoutTime}Z`) : Infinity;
      return expA - expB;
    })
    .slice(0, limit);

  return {
    posts: sorted,
    nextStartKey,
    hasMore: hasMore && Boolean(nextStartKey),
  };
}

/**
 * Computes an exact fallback 100% vote value in STU when SDK helper is unavailable.
 */
function estimateVoteValueFallback(
  acc: any,
  vpPercent: number,
  rewardFund: any,
  medianPrice: any
): number {
  try {
    const ownVests = parseFloat(acc.vesting_shares?.split(' ')[0] || '0');
    const receivedVests = parseFloat(acc.received_vesting_shares?.split(' ')[0] || '0');
    const delegatedVests = parseFloat(acc.delegated_vesting_shares?.split(' ')[0] || '0');
    const effectiveVests = Math.max(0, ownVests + receivedVests - delegatedVests);

    const recentClaims = parseFloat(rewardFund?.recent_claims || '0');
    const rewardBalance = parseFloat(rewardFund?.reward_balance?.split(' ')[0] || '0');
    const basePrice = parseFloat(medianPrice?.base?.split(' ')[0] || '0');
    const quotePrice = parseFloat(medianPrice?.quote?.split(' ')[0] || '1');
    if (recentClaims <= 0 || rewardBalance <= 0 || quotePrice <= 0) return 0;

    const steemPrice = basePrice / quotePrice;
    const rshares = effectiveVests * 1000000 * (vpPercent / 100) * 0.02;
    return (rshares / recentClaims) * rewardBalance * steemPrice;
  } catch {
    return 0;
  }
}

/**
 * Fetch live Voting Power & 100% vote value for all Community Curator accounts
 */
export async function fetchTeamAccountsStatus(): Promise<CurationTeam[]> {
  const uniqueNames = Array.from(new Set(COMMUNITY_CURATOR_TEAMS.map((t) => t.account)));

  try {
    const [accounts, rewardFund, medianPrice] = await Promise.all([
      safeCall<any[]>('condenser_api.get_accounts', [uniqueNames]),
      safeCall<any>('condenser_api.get_reward_fund', ['post']),
      safeCall<any>('condenser_api.get_current_median_history_price', []),
    ]);

    const accountMap = new Map<string, any>();
    for (const acc of accounts) {
      accountMap.set(acc.name, acc);
    }

    const teamPromises = COMMUNITY_CURATOR_TEAMS.map(async (team) => {
      const acc = accountMap.get(team.account);
      if (!acc) {
        return {
          id: team.id,
          name: team.name,
          account: team.account,
          members: team.members,
          currentVP: 0,
          voteValue100: 0,
        };
      }

      let currentVP = 100;
      try {
        if (utils.getVotingMana) {
          const vpMana = await utils.getVotingMana(acc);
          currentVP = Math.round(vpMana.percentage || 100);
        }
      } catch {
        currentVP = Math.round((acc.voting_power || 10000) / 100);
      }

      let voteValue100 = 0;
      try {
        if (utils.getVoteValue) {
          voteValue100 = await utils.getVoteValue(acc, 10000);
        }
      } catch {
        voteValue100 = 0;
      }

      if (!voteValue100) {
        voteValue100 = estimateVoteValueFallback(acc, currentVP, rewardFund, medianPrice);
      }

      return {
        id: team.id,
        name: team.name,
        account: team.account,
        members: team.members,
        currentVP,
        voteValue100: Math.round(voteValue100 * 100) / 100,
      };
    });

    return await Promise.all(teamPromises);
  } catch (error) {
    console.error('Error fetching team accounts status:', error);
    return [];
  }
}

export interface TeamCurationAudit {
  teamId: string;
  teamName: string;
  account: string;
  members: string[];
  totalVotes: number;
  ownTeamSelfVotes: number;
  ownTeamSelfVotePercent: number;
  memberVotes: { member: string; votes: number }[];
  crossTeamVotes: number;
  compliant: boolean;
}

export interface CurationIntelligenceSnapshot {
  windowDays: number;
  totalVotes: number;
  postVotes: number;
  commentVotes: number;
  uniqueAuthorsSupported: number;
  ownTeamSelfVotes?: number;
  ownTeamSelfVotePercent?: number;
  fellowCuratorVotes?: number;
  fellowCuratorVotePercent?: number;
  crossTeamCuratorVotes?: number;
  crossTeamCuratorVotePercent?: number;
  curatorSelfVotes: number;
  curatorSelfVotePercent: number;
  repeatVoteRate: number;
  giniCoefficient: number;
  topSupportedAuthors: { author: string; votes: number; isCurator: boolean }[];
  teamAudits?: TeamCurationAudit[];
}

function calculateGini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0;

  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return Math.max(0, Math.min(1, weightedSum / (n * sum)));
}

/**
 * Aggregates live on-chain votes from sc0x & booming0x accounts over the past N days
 * to answer Steemit Team post/comment reach, Gini inequality, and curator self-vote metrics.
 */
export async function fetchCurationIntelligence(
  days = 7
): Promise<CurationIntelligenceSnapshot> {
  const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
  const authorCounts = new Map<string, number>();

  const teamAccountMembersMap = new Map<string, Set<string>>();
  const teamMetaMap = new Map<
    string,
    { id: string; name: string; account: string; members: string[] }
  >();

  for (const team of COMMUNITY_CURATOR_TEAMS) {
    const accLower = team.account.toLowerCase();
    teamAccountMembersMap.set(
      accLower,
      new Set(team.members.map((m) => m.toLowerCase()))
    );
    teamMetaMap.set(accLower, team);
  }

  const allCuratorsSet = new Set(
    COMMUNITY_CURATOR_TEAMS.flatMap((t) => t.members.map((m) => m.toLowerCase()))
  );

  let totalVotes = 0;
  let postVotes = 0;
  let commentVotes = 0;
  let ownTeamSelfVotes = 0;
  let fellowCuratorVotes = 0;

  // Track per-team metrics for deep policy compliance
  const teamStats = new Map<
    string,
    {
      totalVotes: number;
      ownTeamSelfVotes: number;
      memberVoteCounts: Map<string, number>;
      crossTeamVotes: number;
    }
  >();

  for (const team of COMMUNITY_CURATOR_TEAMS) {
    teamStats.set(team.account.toLowerCase(), {
      totalVotes: 0,
      ownTeamSelfVotes: 0,
      memberVoteCounts: new Map(),
      crossTeamVotes: 0,
    });
  }

  const histories = await Promise.allSettled(
    CURATION_ACCOUNTS.map((acc) => fetchAccountHistoryWindow(acc, cutoffMs, 15))
  );

  const ambiguousVotes: [string, string][] = [];
  const ambiguousSeen = new Set<string>();
  const allVoteTargets: { author: string; permlink: string }[] = [];

  for (let i = 0; i < histories.length; i++) {
    const res = histories[i];
    const curatorAcc = CURATION_ACCOUNTS[i];
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;

    const voterLower = curatorAcc.toLowerCase();
    const myTeamMembers = teamAccountMembersMap.get(voterLower);
    const teamRecord = teamStats.get(voterLower);

    for (const [, item] of res.value) {
      const ts = Date.parse(`${item.timestamp}Z`);
      if (Number.isNaN(ts) || ts < cutoffMs) continue;

      const [opName, opData] = item.op || [];
      if (opName !== 'vote' || opData?.voter !== curatorAcc || (opData?.weight ?? 0) <= 0) {
        continue;
      }

      const targetAuthor = String(opData.author || '').toLowerCase();
      const targetPermlink = String(opData.permlink || '');
      if (!targetAuthor || !targetPermlink) continue;

      totalVotes++;
      if (teamRecord) teamRecord.totalVotes++;
      allVoteTargets.push({ author: targetAuthor, permlink: targetPermlink });

      // Condenser comments often use 6-char random slugs rather than 're-'
      if (targetPermlink.startsWith('re-') || targetPermlink.length <= 12) {
        const key = `${targetAuthor}/${targetPermlink}`;
        if (!ambiguousSeen.has(key)) {
          ambiguousSeen.add(key);
          ambiguousVotes.push([targetAuthor, targetPermlink]);
        }
      }

      const isOwnTeam = myTeamMembers ? myTeamMembers.has(targetAuthor) : false;
      const isCurator = allCuratorsSet.has(targetAuthor);

      if (isOwnTeam) {
        ownTeamSelfVotes++;
        if (teamRecord) {
          teamRecord.ownTeamSelfVotes++;
          teamRecord.memberVoteCounts.set(
            targetAuthor,
            (teamRecord.memberVoteCounts.get(targetAuthor) || 0) + 1
          );
        }
      } else if (isCurator) {
        if (teamRecord) {
          teamRecord.crossTeamVotes++;
        }
      }

      if (isCurator) {
        fellowCuratorVotes++;
      }

      authorCounts.set(targetAuthor, (authorCounts.get(targetAuthor) || 0) + 1);
    }
  }

  // Accurately resolve comment vs post status via database_api.find_comments in batches of 100
  const confirmedComments = new Set<string>();
  if (ambiguousVotes.length > 0) {
    const chunkCalls: Promise<any>[] = [];
    for (let offset = 0; offset < ambiguousVotes.length; offset += 100) {
      chunkCalls.push(
        safeCall<{ comments: any[] }>('database_api.find_comments', {
          comments: ambiguousVotes.slice(offset, offset + 100),
        })
      );
    }
    const chunkResults = await Promise.allSettled(chunkCalls);
    for (const r of chunkResults) {
      if (r.status === 'fulfilled' && Array.isArray(r.value?.comments)) {
        for (const c of r.value.comments) {
          if (c && (c.parent_author || Number(c.depth || 0) > 0)) {
            confirmedComments.add(`${String(c.author).toLowerCase()}/${c.permlink}`);
          }
        }
      }
    }
  }

  for (const target of allVoteTargets) {
    const key = `${target.author}/${target.permlink}`;
    if (confirmedComments.has(key) || target.permlink.startsWith('re-')) {
      commentVotes++;
    } else {
      postVotes++;
    }
  }

  const countsArray = Array.from(authorCounts.values());
  const uniqueAuthorsSupported = authorCounts.size;
  const ownTeamSelfVotePercent =
    totalVotes > 0 ? Math.round((ownTeamSelfVotes / totalVotes) * 1000) / 10 : 0;
  const fellowCuratorVotePercent =
    totalVotes > 0 ? Math.round((fellowCuratorVotes / totalVotes) * 1000) / 10 : 0;
  const crossTeamCuratorVotes = Math.max(0, fellowCuratorVotes - ownTeamSelfVotes);
  const crossTeamCuratorVotePercent =
    totalVotes > 0 ? Math.round((crossTeamCuratorVotes / totalVotes) * 1000) / 10 : 0;

  const repeatVoteRate =
    uniqueAuthorsSupported > 0
      ? Math.round((totalVotes / uniqueAuthorsSupported) * 100) / 100
      : 0;
  const giniCoefficient = Math.round(calculateGini(countsArray) * 1000) / 1000;

  const topSupportedAuthors = Array.from(authorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([author, votes]) => ({
      author,
      votes,
      isCurator: allCuratorsSet.has(author),
    }));

  const maxAllowedWeeklySelfVotes = days === 7 ? 7 : 14;

  const teamAudits = COMMUNITY_CURATOR_TEAMS.map((team) => {
    const stat = teamStats.get(team.account.toLowerCase()) || {
      totalVotes: 0,
      ownTeamSelfVotes: 0,
      memberVoteCounts: new Map(),
      crossTeamVotes: 0,
    };

    const ownPct =
      stat.totalVotes > 0
        ? Math.round((stat.ownTeamSelfVotes / stat.totalVotes) * 1000) / 10
        : 0;

    const memberVotes = team.members.map((m) => ({
      member: m,
      votes: stat.memberVoteCounts.get(m.toLowerCase()) || 0,
    }));

    // Policy rule: Max 1 vote/curator day -> max 7 votes in 7 days or <= 10.0% of team votes
    const compliant =
      stat.ownTeamSelfVotes <= maxAllowedWeeklySelfVotes || ownPct <= 10.0;

    return {
      teamId: team.id,
      teamName: team.name,
      account: team.account,
      members: team.members,
      totalVotes: stat.totalVotes,
      ownTeamSelfVotes: stat.ownTeamSelfVotes,
      ownTeamSelfVotePercent: ownPct,
      memberVotes,
      crossTeamVotes: stat.crossTeamVotes,
      compliant,
    };
  });

  return {
    windowDays: days,
    totalVotes,
    postVotes,
    commentVotes,
    uniqueAuthorsSupported,
    ownTeamSelfVotes,
    ownTeamSelfVotePercent,
    fellowCuratorVotes,
    fellowCuratorVotePercent,
    crossTeamCuratorVotes,
    crossTeamCuratorVotePercent,
    curatorSelfVotes: ownTeamSelfVotes,
    curatorSelfVotePercent: ownTeamSelfVotePercent,
    repeatVoteRate,
    giniCoefficient,
    topSupportedAuthors,
    teamAudits,
  };
}

export interface TeamOnChainCurationData {
  items: PostItem[]; // All curated posts and comments in the window
  posts: PostItem[]; // Top-level posts only (for Top 7 Candidate Picker)
  postsCount: number;
  commentsCount: number;
  feedbackCommentsCount: number;
  uniqueAuthorsGuided: number;
}

/**
 * Fetches complete N-day on-chain curation activity for a specific team account.
 * Pages backwards through condenser_api.get_account_history in compliant 100-op batches,
 * captures ALL positive votes (both top-level posts and comments) plus team feedback comments,
 * and batch-fetches content via JSON-RPC batching.
 */
export async function fetchTeamOnChainCurationData(
  account: string,
  days = 7,
  limit = 500
): Promise<TeamOnChainCurationData> {
  const empty: TeamOnChainCurationData = {
    items: [],
    posts: [],
    postsCount: 0,
    commentsCount: 0,
    feedbackCommentsCount: 0,
    uniqueAuthorsGuided: 0,
  };

  const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
  const targets: { author: string; permlink: string }[] = [];
  const seenVotes = new Set<string>();
  const seenFeedbackComments = new Set<string>();
  const guidedAuthors = new Set<string>();

  try {
    const history = await fetchAccountHistoryWindow(account, cutoffMs, 30);
    if (!Array.isArray(history) || history.length === 0) return empty;

    for (const [, item] of history) {
      const ts = Date.parse(`${item.timestamp}Z`);
      if (Number.isNaN(ts) || ts < cutoffMs) continue;

      const [opName, opData] = item.op || [];

      if (opName === 'vote' && opData?.voter === account && (opData?.weight ?? 0) > 0) {
        const author = String(opData.author || '').toLowerCase();
        const permlink = String(opData.permlink || '');
        if (!author || !permlink) continue;

        const key = `${author}/${permlink}`;
        if (!seenVotes.has(key) && targets.length < limit) {
          seenVotes.add(key);
          targets.push({ author, permlink });
        }
      } else if (
        opName === 'comment' &&
        opData?.author === account &&
        opData?.parent_author &&
        opData.parent_author !== account
      ) {
        const targetKey = `${String(opData.parent_author).toLowerCase()}/${opData.parent_permlink || ''}`;
        if (!seenFeedbackComments.has(targetKey)) {
          seenFeedbackComments.add(targetKey);
          guidedAuthors.add(String(opData.parent_author).toLowerCase());
        }
      }
    }
  } catch (err) {
    console.warn(`Could not fetch account history for ${account}:`, err);
    return empty;
  }

  if (targets.length === 0) {
    return {
      ...empty,
      feedbackCommentsCount: seenFeedbackComments.size,
      uniqueAuthorsGuided: guidedAuthors.size,
    };
  }

  // Batch fetch full content via JSON-RPC batching (40 items per HTTP call)
  const batchRequests = targets.map((t) => ({
    method: 'condenser_api.get_content',
    params: [t.author, t.permlink],
  }));
  const rawResults = await batchRpcCall<any>(batchRequests, 40);

  const rawItems: any[] = [];
  for (const raw of rawResults) {
    if (raw && raw.author && !isNsfwPost(raw)) {
      rawItems.push(raw);
    }
  }

  if (rawItems.length === 0) {
    return {
      ...empty,
      feedbackCommentsCount: seenFeedbackComments.size,
      uniqueAuthorsGuided: guidedAuthors.size,
    };
  }

  // Resolve community titles
  const categories = rawItems.map((p) => String(p.category || ''));
  const communityTitles = await fetchCommunityTitles(categories);
  const now = Date.now();
  const claimsMap = new Map<string, CurationClaim>();

  const items = rawItems
    .map((raw) => mapRawDiscussionToPostItem(raw, now, claimsMap, communityTitles))
    .filter((p) => !isNsfwPost(p));

  const posts = items.filter((p) => !p.isComment);
  const commentsCount = items.length - posts.length;

  return {
    items,
    posts,
    postsCount: posts.length,
    commentsCount,
    feedbackCommentsCount: seenFeedbackComments.size,
    uniqueAuthorsGuided: guidedAuthors.size,
  };
}

/**
 * Fetches actual on-chain curated posts for a specific team account over the last N days.
 * Backwards-compatible wrapper returning all curated top-level posts.
 */
export async function fetchTeamOnChainCuratedPosts(
  account: string,
  days = 7,
  limit = 500
): Promise<PostItem[]> {
  const data = await fetchTeamOnChainCurationData(account, days, limit);
  return data.posts;
}

/**
 * Parses and fetches a post by Steemit URL or @author/permlink path.
 */
export async function fetchPostBySteemUrl(urlOrPath: string): Promise<PostItem | null> {
  const match = urlOrPath.match(/@([a-z0-9.-]+)\/([a-z0-9-]+)/i);
  if (!match) return null;
  const author = match[1].toLowerCase();
  const permlink = match[2].toLowerCase();

  try {
    const raw = await safeCall<any>('condenser_api.get_content', [author, permlink]);
    if (!raw || !raw.author || raw.author.toLowerCase() !== author || !raw.title) {
      return null;
    }

    if (isNsfwPost(raw)) {
      throw new Error('This post is tagged #nsfw and is banned from curation.');
    }

    const categories = [String(raw.category || '')];
    const communityTitles = await fetchCommunityTitles(categories);
    const now = Date.now();
    const claimsMap = new Map<string, CurationClaim>();

    const postItem = mapRawDiscussionToPostItem(raw, now, claimsMap, communityTitles);
    if (isNsfwPost(postItem)) {
      throw new Error('This post is tagged #nsfw and is banned from curation.');
    }

    return postItem;
  } catch (err) {
    console.warn(`Failed to fetch post by URL ${urlOrPath}:`, err);
    return null;
  }
}
