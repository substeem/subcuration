import { safeCall } from './steem';
import type { ClubStatusResult } from '../types';

interface HistoryCacheEntry {
  timestamp: number;
  data: ClubStatusResult;
}

const CLUB_STORAGE_KEY = 'substeem_club_cache_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_HISTORY_PAGES = 5;
const PAGE_LIMIT = 1000;

const memoryCache = new Map<string, HistoryCacheEntry>();
const inFlightRequests = new Map<string, Promise<ClubStatusResult>>();

function loadStorageCache(): Record<string, HistoryCacheEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CLUB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistClubEntry(username: string, entry: HistoryCacheEntry): void {
  if (typeof window === 'undefined') return;
  try {
    const store = loadStorageCache();
    store[username] = entry;
    // Prune expired entries opportunistically
    const now = Date.now();
    for (const [k, v] of Object.entries(store)) {
      if (now - v.timestamp >= CACHE_TTL_MS) {
        delete store[k];
      }
    }
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Synchronous 24h cache read so repeat authors auto-populate without clicking.
 */
export function getCachedClubStatus(rawUsername: string): ClubStatusResult | null {
  const username = rawUsername.trim().toLowerCase();
  const now = Date.now();

  const mem = memoryCache.get(username);
  if (mem && now - mem.timestamp < CACHE_TTL_MS) {
    return mem.data;
  }

  const stored = loadStorageCache()[username];
  if (stored && now - stored.timestamp < CACHE_TTL_MS) {
    memoryCache.set(username, stored);
    return stored.data;
  }

  return null;
}

async function fetchWindowHistory(username: string, maxAgeMs: number): Promise<any[]> {
  const collected: any[] = [];
  const now = Date.now();
  let start = -1;

  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const limit = start === -1 ? PAGE_LIMIT : Math.min(PAGE_LIMIT, start);
    if (limit <= 0) break;

    const batch = await safeCall<any[]>('condenser_api.get_account_history', [
      username,
      start,
      limit,
    ]);
    if (!Array.isArray(batch) || batch.length === 0) break;

    collected.push(...batch);

    const oldestEntry = batch[0];
    const oldestIdx = oldestEntry[0];
    const oldestMs = Date.parse(`${oldestEntry[1].timestamp}Z`);

    if (oldestIdx <= 0 || (!Number.isNaN(oldestMs) && now - oldestMs > maxAgeMs)) {
      break;
    }

    start = oldestIdx - 1;
  }

  return collected;
}

export async function calculateClubStatus(rawUsername: string): Promise<ClubStatusResult> {
  const username = rawUsername.trim().toLowerCase();

  const cached = getCachedClubStatus(username);
  if (cached) return cached;

  const existingPromise = inFlightRequests.get(username);
  if (existingPromise) return existingPromise;

  const task = (async (): Promise<ClubStatusResult> => {
    const fallbackResult: ClubStatusResult = {
      username,
      tier: 'Clubless',
      poweredUp: 0,
      transferredOut: 0,
      ratio: 0,
      isPoweringDown: false,
      eligible: false,
      periodDays: 30,
    };

    try {
      const accounts = await safeCall<any[]>('condenser_api.get_accounts', [[username]]);
      if (!accounts || accounts.length === 0) {
        return fallbackResult;
      }

      const acc = accounts[0];
      const toWithdraw = parseFloat(String(acc.to_withdraw || '0'));
      const withdrawRate = parseFloat(acc.vesting_withdraw_rate?.split(' ')[0] || '0');
      const isPoweringDown = toWithdraw > 0 && withdrawRate > 0;

      if (isPoweringDown) {
        const result: ClubStatusResult = { ...fallbackResult, isPoweringDown: true };
        const entry = { timestamp: Date.now(), data: result };
        memoryCache.set(username, entry);
        persistClubEntry(username, entry);
        return result;
      }

      const now = Date.now();
      const d30 = 30 * 24 * 3600 * 1000;
      const d60 = 60 * 24 * 3600 * 1000;
      const d90 = 90 * 24 * 3600 * 1000;

      const history = await fetchWindowHistory(username, d90);
      const seenIndices = new Set<number>();

      let pUp30 = 0;
      let tOut30 = 0;
      let pUp60 = 0;
      let tOut60 = 0;
      let pUp90 = 0;
      let tOut90 = 0;

      for (const [idx, item] of history) {
        if (seenIndices.has(idx)) continue;
        seenIndices.add(idx);

        const opDate = Date.parse(`${item.timestamp}Z`);
        if (Number.isNaN(opDate)) continue;

        const ageMs = now - opDate;
        if (ageMs < 0 || ageMs > d90) continue;

        const [opName, opData] = item.op;

        if (opName === 'transfer_to_vesting') {
          const amt = parseFloat(opData.amount?.split(' ')[0] || '0');
          if (opData.from === username && amt > 0) {
            if (ageMs <= d30) pUp30 += amt;
            if (ageMs <= d60) pUp60 += amt;
            pUp90 += amt;
          }
        } else if (opName === 'transfer') {
          const amt = parseFloat(opData.amount?.split(' ')[0] || '0');
          if (opData.from === username && opData.to !== username && amt > 0) {
            if (ageMs <= d30) tOut30 += amt;
            if (ageMs <= d60) tOut60 += amt;
            tOut90 += amt;
          }
        }
      }

      let tier: 'Club100' | 'Club75' | 'Club5050' | 'Clubless' = 'Clubless';
      let chosenPoweredUp = pUp30;
      let chosenTransferredOut = tOut30;
      let period = 30;

      if (pUp90 > 0 && tOut90 === 0) {
        tier = 'Club100';
        chosenPoweredUp = pUp90;
        chosenTransferredOut = tOut90;
        period = 90;
      } else {
        const total60 = pUp60 + tOut60;
        const ratio60 = total60 > 0 ? (pUp60 / total60) * 100 : 0;
        if (ratio60 >= 75 && pUp60 > 0) {
          tier = 'Club75';
          chosenPoweredUp = pUp60;
          chosenTransferredOut = tOut60;
          period = 60;
        } else {
          const total30 = pUp30 + tOut30;
          const ratio30 = total30 > 0 ? (pUp30 / total30) * 100 : 0;
          if (ratio30 >= 50 && pUp30 > 0) {
            tier = 'Club5050';
            chosenPoweredUp = pUp30;
            chosenTransferredOut = tOut30;
            period = 30;
          }
        }
      }

      const total = chosenPoweredUp + chosenTransferredOut;
      const ratio = total > 0 ? Math.round((chosenPoweredUp / total) * 1000) / 10 : 0;

      const result: ClubStatusResult = {
        username,
        tier,
        poweredUp: Math.round(chosenPoweredUp * 100) / 100,
        transferredOut: Math.round(chosenTransferredOut * 100) / 100,
        ratio,
        isPoweringDown: false,
        eligible: tier !== 'Clubless',
        periodDays: period,
      };

      const entry = { timestamp: Date.now(), data: result };
      memoryCache.set(username, entry);
      persistClubEntry(username, entry);
      return result;
    } catch (error) {
      console.error(`Error calculating club status for ${username}:`, error);
      return fallbackResult;
    } finally {
      inFlightRequests.delete(username);
    }
  })();

  inFlightRequests.set(username, task);
  return task;
}
