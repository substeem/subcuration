import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { PostCard } from './components/PostCard';
import { PostCardSkeleton } from './components/PostCardSkeleton';
import { PostModal } from './components/PostModal';
import { IntelligenceView } from './components/IntelligenceView';
import { ReportView } from './components/ReportView';
import {
  fetchCurationFeed,
  fetchMoreCurationFeed,
  fetchTeamAccountsStatus,
  fetchRescueCandidates,
  fetchPostBySteemUrl,
  LOCAL_CLAIMS_KEY, // Ensure identical cache-key import for offline preservation
  getCurrentRpcNode,
} from './lib/steem';
import {
  COMMUNITY_CURATOR_TEAMS,
  isDiaryPost,
  OPPORTUNITY_MAX_PAYOUT,
  OPPORTUNITY_MIN_WORDS,
  isLowQualityOrBotPost,
  isNsfwPost,
} from './lib/constants';
import type { PostItem, CurationTeam, CurationClaim } from './types';
import {
  Search,
  RefreshCw,
  Shield,
  Users,
  MessageSquareQuote,
  SlidersHorizontal,
  AlertTriangle,
  Clock,
  EyeOff,
  RotateCcw,
  Sparkles,
  Bot,
} from 'lucide-react';

const STEEM_PAYOUT_WINDOW_HOURS = 168; // 7 days
const DIARY_QUOTA_THRESHOLD_PERCENT = 30;

function parseSteemUtcMs(timestamp?: string): number | null {
  if (!timestamp) return null;
  const normalized = timestamp.endsWith('Z') ? timestamp : `${timestamp}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function getPostAgeHours(post: PostItem, nowMs: number): number | null {
  const createdMs = parseSteemUtcMs(post.created);
  if (createdMs === null) return null;
  return Math.max(0, (nowMs - createdMs) / 3600000);
}

function getHoursToExpiry(post: PostItem, nowMs: number): number | null {
  const cashoutMs = parseSteemUtcMs(post.cashoutTime);
  if (cashoutMs !== null) {
    return Math.max(0, (cashoutMs - nowMs) / 3600000);
  }
  const ageHours = getPostAgeHours(post, nowMs);
  if (ageHours === null) return null;
  return Math.max(0, STEEM_PAYOUT_WINDOW_HOURS - ageHours);
}

function getEstimatedCharCount(post: PostItem): number {
  if (typeof post.bodyLength === 'number') return post.bodyLength;
  if (typeof post.body === 'string') return post.body.length;
  return post.wordCount * 6;
}

export function App() {
  const [activeTab, setActiveTab] = useState('radar');
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [teamAccounts, setTeamAccounts] = useState<CurationTeam[]>([]);
  const [claims, setClaims] = useState<Map<string, CurationClaim>>(new Map());
  const [loading, setLoading] = useState(true);
  const [lastRefreshedMs, setLastRefreshedMs] = useState<number>(() => Date.now());
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('substeem_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    }
    return 'dark';
  });

  // Radar Filters, Language & Sorting
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedLanguage, setSelectedLanguage] = useState('all');
  const [sortBy, setSortBy] = useState<
    'newest' | 'oldest' | 'wordCountDesc' | 'payoutAsc' | 'payoutDesc' | 'votesDesc' | 'commentsDesc'
  >('newest');
  const [filterOpportunitiesOnly, setFilterOpportunitiesOnly] = useState(false);
  const [filterLowPayoutOnly, setFilterLowPayoutOnly] = useState(false);
  const [filterClubOnly, setFilterClubOnly] = useState(false);
  const [filterHideAiSpam, setFilterHideAiSpam] = useState(true);
  const [filterExcludeCurators, setFilterExcludeCurators] = useState(false);
  const [filterHideDiary, setFilterHideDiary] = useState(false);
  const [filterHideShort, setFilterHideShort] = useState(false);

  // Pagination (Load More)
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Dismissed Posts State
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('substeem_dismissed_keys_v1');
        if (saved) return new Set(JSON.parse(saved));
      } catch {}
    }
    return new Set();
  });
  const [showDismissed, setShowDismissed] = useState(false);

  // Telemetry & Freshness
  const [freshnessMinutes, setFreshnessMinutes] = useState(0);

  useEffect(() => {
    const updateFreshness = () => {
      const elapsed = Math.floor((Date.now() - lastRefreshedMs) / 60000);
      setFreshnessMinutes(elapsed);
    };
    updateFreshness();
    const interval = setInterval(updateFreshness, 30000);
    return () => clearInterval(interval);
  }, [lastRefreshedMs]);

  // Rescue Tab state & pagination
  const [strictRescueMode, setStrictRescueMode] = useState(false);
  const [rescuePostsData, setRescuePostsData] = useState<PostItem[]>([]);
  const [rescueStartKey, setRescueStartKey] = useState<[string, string, string] | null>(null);
  const [hasMoreRescue, setHasMoreRescue] = useState(true);
  const [loadingMoreRescue, setLoadingMoreRescue] = useState(false);
  const [rescueScanning, setRescueScanning] = useState(false);
  const [hasScannedRescue, setHasScannedRescue] = useState(false);

  // Modal inspection
  const [selectedPost, setSelectedPost] = useState<PostItem | null>(null);
  const [showRevisionModal, setShowRevisionModal] = useState(false);

  // Persistent registry of claimed, in-review, and guided posts
  const LOCAL_CLAIMED_POSTS_KEY = 'substeem_cached_claimed_posts_v2';
  const [cachedClaimedPosts, setCachedClaimedPosts] = useState<PostItem[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem(LOCAL_CLAIMED_POSTS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        }
      } catch (e) {
        console.warn('Failed to parse cached claimed posts:', e);
      }
    }
    return [];
  });

  const saveCachedClaimedPosts = (items: PostItem[]) => {
    try {
      localStorage.setItem(LOCAL_CLAIMED_POSTS_KEY, JSON.stringify(items));
    } catch (e) {
      console.warn('Failed to write cached claimed posts to localStorage:', e);
    }
  };

  // Apply visual theme to standard elements
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      if (theme === 'light') {
        root.classList.remove('dark');
        root.classList.add('light');
        document.body.style.backgroundColor = '#f8fafc';
      } else {
        root.classList.remove('light');
        root.classList.add('dark');
        document.body.style.backgroundColor = '#020617';
      }
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('substeem_theme', next);
      return next;
    });
  };

  const handleInspectPost = (post: PostItem) => {
    setShowRevisionModal(false);
    setSelectedPost(post);
  };

  const handleClaimPost = (post: PostItem) => {
    setShowRevisionModal(false);
    setSelectedPost(post);
  };

  const handleQuickMentorship = (post: PostItem) => {
    setShowRevisionModal(true);
    setSelectedPost(post);
  };

  const handleCloseModal = () => {
    setSelectedPost(null);
    setShowRevisionModal(false);
  };

  const handleScanRescue = async () => {
    if (rescueScanning) return;
    setRescueScanning(true);
    try {
      const result = await fetchRescueCandidates(30, 12, 72, null);
      setRescuePostsData(result.posts);
      setRescueStartKey(result.nextStartKey);
      setHasMoreRescue(result.hasMore);
      setHasScannedRescue(true);

      if (result.posts.length > 0) {
        setClaims((prev) => {
          const next = new Map(prev);
          for (const c of result.posts) {
            if (c.claim) {
              next.set(`${c.author}/${c.permlink}`, c.claim);
            }
          }
          return next;
        });
      }
    } catch (err) {
      console.error('Error scanning rescue candidates:', err);
    } finally {
      setRescueScanning(false);
    }
  };

  const handleLoadMoreRescue = async () => {
    if (loadingMoreRescue || !hasMoreRescue || rescueScanning) return;
    setLoadingMoreRescue(true);
    try {
      const result = await fetchRescueCandidates(30, 12, 72, rescueStartKey);
      if (result.posts.length === 0) {
        setHasMoreRescue(false);
      } else {
        setRescuePostsData((prev) => {
          const existing = new Set(prev.map((p) => `${p.author}/${p.permlink}`));
          const unique = result.posts.filter((p) => !existing.has(`${p.author}/${p.permlink}`));
          if (unique.length === 0) setHasMoreRescue(false);
          return [...prev, ...unique];
        });
        setRescueStartKey(result.nextStartKey);
        setHasMoreRescue(result.hasMore);

        setClaims((prev) => {
          const next = new Map(prev);
          for (const c of result.posts) {
            if (c.claim) {
              next.set(`${c.author}/${c.permlink}`, c.claim);
            }
          }
          return next;
        });
      }
    } catch (err) {
      console.error('Error loading more rescue posts:', err);
    } finally {
      setLoadingMoreRescue(false);
    }
  };

  const allCuratorMembers = useMemo(() => {
    const members = new Set<string>();
    const sourceTeams = teamAccounts.length > 0 ? teamAccounts : COMMUNITY_CURATOR_TEAMS;
    for (const team of sourceTeams) {
      if (team.account) members.add(team.account.toLowerCase());
      for (const m of team.members) {
        members.add(m.toLowerCase());
      }
    }
    return members;
  }, [teamAccounts]);

  const currentTeam: CurationTeam | null = useMemo(() => {
    if (!currentUser) return null;
    const normalizedUser = currentUser.toLowerCase();

    const liveTeam = teamAccounts.find(
      (t) =>
        t.account.toLowerCase() === normalizedUser ||
        t.members.some((m) => m.toLowerCase() === normalizedUser)
    );
    if (liveTeam) return liveTeam;

    const fallback = COMMUNITY_CURATOR_TEAMS.find(
      (t) =>
        t.account.toLowerCase() === normalizedUser ||
        t.members.some((m) => m.toLowerCase() === normalizedUser)
    );
    return fallback ? { ...fallback, currentVP: 100, voteValue100: 0 } : null;
  }, [currentUser, teamAccounts]);

  const isAuthorizedCurator = useMemo(() => {
    if (!currentUser) return false;
    const normalizedUser = currentUser.toLowerCase();
    return allCuratorMembers.has(normalizedUser) || Boolean(currentTeam);
  }, [currentUser, allCuratorMembers, currentTeam]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [feedData, teamsData] = await Promise.all([
        fetchCurationFeed(50),
        fetchTeamAccountsStatus(),
      ]);

      const hydratedClaims = new Map<string, CurationClaim>();
      // Pre-hydrate from offline cache
      try {
        const rawLocal = localStorage.getItem(LOCAL_CLAIMS_KEY);
        if (rawLocal) {
          const parsed = JSON.parse(rawLocal);
          for (const [k, v] of Object.entries(parsed)) {
            hydratedClaims.set(k, v as CurationClaim);
          }
        }
      } catch (err) {
        console.warn('Failed to parse cached local claims:', err);
      }

      for (const p of feedData) {
        if (p.claim) {
          hydratedClaims.set(`${p.author}/${p.permlink}`, p.claim);
        }
      }

      setPosts(feedData);
      setTeamAccounts(teamsData);
      setClaims(hydratedClaims);
      setLastRefreshedMs(Date.now());

      // Hydrate any missing full PostItems for active claims from the blockchain
      const cachedList: PostItem[] = (() => {
        try {
          const raw = localStorage.getItem(LOCAL_CLAIMED_POSTS_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
          }
        } catch {}
        return [];
      })();

      const knownKeys = new Set([
        ...feedData.map((p) => `${p.author}/${p.permlink}`),
        ...cachedList.map((p) => `${p.author}/${p.permlink}`),
      ]);

      const missingClaims: { author: string; permlink: string; claim: CurationClaim }[] = [];
      for (const [k, c] of hydratedClaims.entries()) {
        if (!knownKeys.has(k)) {
          missingClaims.push({ author: c.author, permlink: c.permlink, claim: c });
        }
      }

      if (missingClaims.length > 0) {
        Promise.allSettled(
          missingClaims.map((m) => fetchPostBySteemUrl(`${m.author}/${m.permlink}`))
        ).then((results) => {
          const newlyFetched: PostItem[] = [];
          results.forEach((res, idx) => {
            if (res.status === 'fulfilled' && res.value) {
              newlyFetched.push({
                ...res.value,
                claim: missingClaims[idx].claim,
              });
            }
          });

          if (newlyFetched.length > 0) {
            setCachedClaimedPosts((prev) => {
              const combined = [...prev];
              for (const np of newlyFetched) {
                const k = `${np.author}/${np.permlink}`;
                const idx = combined.findIndex((p) => `${p.author}/${p.permlink}` === k);
                if (idx >= 0) {
                  combined[idx] = np;
                } else {
                  combined.push(np);
                }
              }
              saveCachedClaimedPosts(combined);
              return combined;
            });
          }
        });
      }
    } catch (e) {
      console.error('Error loading curation data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const savedUser = localStorage.getItem('substeem_curator_user');
    if (savedUser) setCurrentUser(savedUser);
  }, []);

  useEffect(() => {
    if (activeTab === 'rescue' && !hasScannedRescue && !loading) {
      handleScanRescue();
    }
  }, [activeTab, hasScannedRescue, loading]);

  const handleLogin = (username: string) => {
    setCurrentUser(username);
    localStorage.setItem('substeem_curator_user', username);
  };

  const handleLogout = () => {
    setCurrentUser(null);
    localStorage.removeItem('substeem_curator_user');
  };

  const handleClaimUpdated = (post: PostItem, newClaim: CurationClaim | null) => {
    const key = `${post.author}/${post.permlink}`;
    setClaims((prev) => {
      const next = new Map(prev);
      if (newClaim) {
        next.set(key, newClaim);
      } else {
        next.delete(key);
      }
      try {
        const obj = Object.fromEntries(next);
        // Correct cache key synchronicity with LOCAL_CLAIMS_KEY
        localStorage.setItem(LOCAL_CLAIMS_KEY, JSON.stringify(obj));
      } catch (e) {
        console.error('Cache save error:', e);
      }
      return next;
    });

    setCachedClaimedPosts((prev) => {
      let next: PostItem[];
      if (newClaim) {
        const updatedPost: PostItem = {
          ...post,
          claim: newClaim,
        };
        const existingIdx = prev.findIndex(
          (p) => `${p.author}/${p.permlink}` === key
        );
        if (existingIdx >= 0) {
          next = [...prev];
          next[existingIdx] = updatedPost;
        } else {
          next = [updatedPost, ...prev];
        }
      } else {
        next = prev.filter((p) => `${p.author}/${p.permlink}` !== key);
      }
      saveCachedClaimedPosts(next);
      return next;
    });

    setPosts((prev) =>
      prev.map((p) =>
        `${p.author}/${p.permlink}` === key ? { ...p, claim: newClaim || undefined } : p
      )
    );

    setRescuePostsData((prev) =>
      prev.map((p) =>
        `${p.author}/${p.permlink}` === key ? { ...p, claim: newClaim || undefined } : p
      )
    );

    setSelectedPost((prev) =>
      prev && `${prev.author}/${prev.permlink}` === key
        ? { ...prev, claim: newClaim || undefined }
        : prev
    );
  };

  const handleLoadMore = async () => {
    if (loadingMore || posts.length === 0) return;
    setLoadingMore(true);
    try {
      const last = posts[posts.length - 1];
      const morePosts = await fetchMoreCurationFeed(last.author, last.permlink, 50);
      if (morePosts.length === 0) {
        setHasMore(false);
      } else {
        setPosts((prev) => {
          const existing = new Set(prev.map((p) => `${p.author}/${p.permlink}`));
          const unique = morePosts.filter((p) => !existing.has(`${p.author}/${p.permlink}`));
          if (unique.length === 0) setHasMore(false);
          return [...prev, ...unique];
        });
      }
    } catch (err) {
      console.error('Failed to load more curation posts:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleDismissPost = (post: PostItem) => {
    const key = `${post.author}/${post.permlink}`;
    setDismissedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      try {
        localStorage.setItem('substeem_dismissed_keys_v1', JSON.stringify([...next]));
      } catch {}
      return next;
    });
  };

  const handleResetDismissed = () => {
    setDismissedKeys(new Set());
    setShowDismissed(false);
    try {
      localStorage.removeItem('substeem_dismissed_keys_v1');
    } catch {}
  };

  const isFilterDirty =
    Boolean(searchQuery.trim()) ||
    selectedCategory !== 'all' ||
    selectedLanguage !== 'all' ||
    sortBy !== 'newest' ||
    filterOpportunitiesOnly ||
    filterLowPayoutOnly ||
    filterClubOnly ||
    !filterHideAiSpam ||
    filterExcludeCurators ||
    filterHideDiary ||
    filterHideShort ||
    showDismissed;

  const handleResetFilters = () => {
    setSearchQuery('');
    setSelectedCategory('all');
    setSelectedLanguage('all');
    setSortBy('newest');
    setFilterOpportunitiesOnly(false);
    setFilterLowPayoutOnly(false);
    setFilterClubOnly(false);
    setFilterHideAiSpam(true);
    setFilterExcludeCurators(false);
    setFilterHideDiary(false);
    setFilterHideShort(false);
    setShowDismissed(false);
  };

  const filteredPosts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const result = posts.filter((p) => {
      // Completely ban #nsfw posts
      if (isNsfwPost(p)) {
        return false;
      }

      const postKey = `${p.author}/${p.permlink}`;
      if (!showDismissed && dismissedKeys.has(postKey)) {
        return false;
      }

      if (
        q &&
        !p.title.toLowerCase().includes(q) &&
        !p.author.toLowerCase().includes(q)
      ) {
        return false;
      }

      if (selectedCategory !== 'all' && p.category !== selectedCategory) {
        return false;
      }

      if (selectedLanguage !== 'all' && p.language && p.language !== selectedLanguage) {
        return false;
      }

      if (filterHideAiSpam && isLowQualityOrBotPost(p)) {
        return false;
      }

      if (filterOpportunitiesOnly) {
        const isBot = isLowQualityOrBotPost(p);
        const isOpp =
          !isBot &&
          !p.curatorVoted &&
          p.pendingPayout < OPPORTUNITY_MAX_PAYOUT &&
          p.wordCount >= OPPORTUNITY_MIN_WORDS &&
          !allCuratorMembers.has(p.author.toLowerCase());
        if (!isOpp) return false;
      }

      if (filterLowPayoutOnly && p.pendingPayout >= OPPORTUNITY_MAX_PAYOUT) {
        return false;
      }

      if (filterClubOnly && p.clubStatus && p.clubStatus.tier === 'Clubless') {
        return false;
      }

      if (filterExcludeCurators && allCuratorMembers.has(p.author.toLowerCase())) {
        return false;
      }

      if (filterHideDiary && isDiaryPost(p)) {
        return false;
      }

      if (filterHideShort && p.wordCount < OPPORTUNITY_MIN_WORDS) {
        return false;
      }

      return true;
    });

    return result.sort((a, b) => {
      switch (sortBy) {
        case 'oldest':
          return b.ageHours - a.ageHours;
        case 'wordCountDesc':
          return b.wordCount - a.wordCount;
        case 'payoutAsc':
          return a.pendingPayout - b.pendingPayout;
        case 'payoutDesc':
          return b.pendingPayout - a.pendingPayout;
        case 'votesDesc':
          return b.totalVotes - a.totalVotes;
        case 'commentsDesc':
          return (b.commentCount || 0) - (a.commentCount || 0);
        case 'newest':
        default:
          return a.ageHours - b.ageHours;
      }
    });
  }, [
    posts,
    searchQuery,
    selectedCategory,
    selectedLanguage,
    sortBy,
    filterOpportunitiesOnly,
    filterLowPayoutOnly,
    filterClubOnly,
    filterHideAiSpam,
    filterExcludeCurators,
    filterHideDiary,
    filterHideShort,
    allCuratorMembers,
    dismissedKeys,
    showDismissed,
  ]);

  const opportunityCount = useMemo(() => {
    return posts.filter((p) => {
      return (
        !isLowQualityOrBotPost(p) &&
        !p.curatorVoted &&
        p.pendingPayout < OPPORTUNITY_MAX_PAYOUT &&
        p.wordCount >= OPPORTUNITY_MIN_WORDS &&
        !allCuratorMembers.has(p.author.toLowerCase())
      );
    }).length;
  }, [posts, allCuratorMembers]);

  const { rescuePosts, strictRescueCount } = useMemo(() => {
    // Combine dedicated on-chain rescue scan candidates with any feed posts in near-expiry jeopardy (12h <= cashout <= 72h)
    const combined = [...rescuePostsData];
    const seen = new Set(combined.map((p) => `${p.author}/${p.permlink}`));
    for (const p of posts) {
      const key = `${p.author}/${p.permlink}`;
      if (!seen.has(key)) {
        const exp = getHoursToExpiry(p, lastRefreshedMs);
        if (exp !== null && exp >= 12 && exp <= 72) {
          combined.push(p);
          seen.add(key);
        }
      }
    }

    const baseCandidates = combined.filter((p) => {
      const postKey = `${p.author}/${p.permlink}`;
      if (dismissedKeys.has(postKey)) return false;
      if (isNsfwPost(p)) return false;
      if (p.curatorVoted) return false;
      if (p.pendingPayout >= 1.0) return false;
      if (allCuratorMembers.has(p.author.toLowerCase())) return false;
      if (isLowQualityOrBotPost(p)) return false;

      // Must be approaching cashout between 12h and 72h (i.e. 6d 12h old or newer)
      const expiryHours = getHoursToExpiry(p, lastRefreshedMs);
      if (expiryHours === null || expiryHours < 12 || expiryHours > 72) return false;

      return p.wordCount >= 200;
    });

    const matchesStrictSpec = (p: PostItem) => {
      const chars = getEstimatedCharCount(p);
      if (chars < 3000) return false;

      const ageHours = getPostAgeHours(p, lastRefreshedMs);
      if (ageHours !== null && ageHours < 3) return false;

      // Strict mode: 12h <= expiryHours <= 48h (age between 5d and 6d 12h)
      const expiryHours = getHoursToExpiry(p, lastRefreshedMs);
      if (expiryHours === null || expiryHours < 12 || expiryHours > 48) return false;

      return true;
    };

    const strictMatches = baseCandidates.filter(matchesStrictSpec);
    const activeList = strictRescueMode ? strictMatches : baseCandidates;

    const sorted = [...activeList].sort((a, b) => {
      const expA = getHoursToExpiry(a, lastRefreshedMs) ?? 999;
      const expB = getHoursToExpiry(b, lastRefreshedMs) ?? 999;
      if (expA !== expB) {
        return expA - expB;
      }
      if (a.pendingPayout !== b.pendingPayout) {
        return a.pendingPayout - b.pendingPayout;
      }
      return b.wordCount - a.wordCount;
    });

    return {
      rescuePosts: sorted,
      strictRescueCount: strictMatches.length,
    };
  }, [rescuePostsData, posts, allCuratorMembers, strictRescueMode, lastRefreshedMs, dismissedKeys]);

  // Unified pool of all posts encountered across radar, rescue, and persistent curation claims
  const allKnownPosts = useMemo(() => {
    const map = new Map<string, PostItem>();
    for (const p of posts) {
      map.set(`${p.author}/${p.permlink}`, p);
    }
    for (const p of rescuePostsData) {
      const key = `${p.author}/${p.permlink}`;
      if (!map.has(key)) map.set(key, p);
    }
    for (const p of cachedClaimedPosts) {
      const key = `${p.author}/${p.permlink}`;
      const existing = map.get(key);
      map.set(key, { ...existing, ...p });
    }
    const result: PostItem[] = [];
    for (const p of map.values()) {
      const key = `${p.author}/${p.permlink}`;
      const activeClaim = claims.get(key) || p.claim;
      result.push({ ...p, claim: activeClaim });
    }
    return result;
  }, [posts, rescuePostsData, cachedClaimedPosts, claims]);

  // Active Queue: Claim locks ('claimed'), in-review ('in_review'), and approved for vote ('approved')
  const queuePosts = useMemo(
    () =>
      allKnownPosts.filter((p) => {
        if (!p.claim) return false;
        return (
          p.claim.status === 'claimed' ||
          p.claim.status === 'in_review' ||
          p.claim.status === 'approved'
        );
      }),
    [allKnownPosts]
  );

  // Creator Guidance Ledger: Posts placed into 'needs_revision' awaiting author response
  const revisionPosts = useMemo(
    () => allKnownPosts.filter((p) => p.claim?.status === 'needs_revision'),
    [allKnownPosts]
  );

  const approvedPosts = useMemo(
    () => allKnownPosts.filter((p) => p.claim?.status === 'approved'),
    [allKnownPosts]
  );

  const diversityStats = useMemo(() => {
    const sample = queuePosts.length > 0 ? queuePosts : posts;
    const diaryCount = sample.filter((p) => isDiaryPost(p)).length;
    const diaryPercent =
      sample.length > 0 ? Math.round((diaryCount / sample.length) * 100) : 0;

    return {
      scope: queuePosts.length > 0 ? 'Active Team Claims' : 'Live Feed',
      total: sample.length,
      diaryCount,
      diaryPercent,
      quotaExceeded:
        sample.length >= 3 && diaryPercent > DIARY_QUOTA_THRESHOLD_PERCENT,
    };
  }, [queuePosts, posts]);

  // Partition into human-readable communities vs general tags
  const { communityOptions, tagOptions } = useMemo(() => {
    const communities = new Map<string, string>();
    const tags = new Map<string, string>();

    for (const p of posts) {
      if (isNsfwPost(p)) continue;
      const cat = p.category;
      if (!cat || cat.toLowerCase() === 'nsfw') continue;
      if (/^hive-\d+$/i.test(cat) || p.communityTitle) {
        if (!communities.has(cat)) {
          communities.set(cat, p.communityTitle || `#${cat}`);
        }
      } else {
        if (!tags.has(cat)) {
          tags.set(cat, `#${cat}`);
        }
      }
    }

    return {
      communityOptions: Array.from(communities.entries()).slice(0, 15),
      tagOptions: Array.from(tags.entries()).slice(0, 15),
    };
  }, [posts]);

  const curationClaimsList = useMemo(() => Array.from(claims.values()), [claims]);

  return (
    <div className={`min-h-screen font-sans selection:bg-teal-500/25 selection:text-teal-200 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 ${
      theme === 'dark' ? 'dark' : ''
    }`}>
      {/* Header with Mode Toggle */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        currentUser={currentUser}
        currentTeam={currentTeam}
        teamAccounts={teamAccounts}
        onLogin={handleLogin}
        onLogout={handleLogout}
        theme={theme}
        toggleTheme={toggleTheme}
        queueCount={queuePosts.length}
        guidanceCount={revisionPosts.length}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 transition-colors duration-200">
        {/* Live Diversity Quota Warning Banner */}
        {!loading &&
          diversityStats.quotaExceeded &&
          (activeTab === 'radar' || activeTab === 'claims' || activeTab === 'report') && (
            <div className="mb-5 px-4 py-3 rounded-2xl border flex flex-wrap items-center justify-between gap-3 shadow-sm border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/50 dark:text-amber-200">
              <div className="flex items-center gap-2.5 text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  <strong className="text-amber-800 dark:text-amber-300">
                    Diary Quota Warning ({diversityStats.scope}):
                  </strong>{' '}
                  <span className="font-mono tabular-nums">{diversityStats.diaryPercent}%</span> ({diversityStats.diaryCount}/{diversityStats.total})
                  are Diary Game posts (policy limit: {DIARY_QUOTA_THRESHOLD_PERCENT}%). Prioritize Science, Tech, or Literature.
                </span>
              </div>
              {activeTab === 'radar' && !filterHideDiary && (
                <button
                  onClick={() => setFilterHideDiary(true)}
                  className="tactile-button text-xs px-3 py-1 rounded-lg font-medium border transition-all border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200 dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
                >
                  Hide Diary Posts
                </button>
              )}
            </div>
          )}

        {/* TAB 1: Curation Radar */}
        {activeTab === 'radar' && (
          <div className="space-y-6 animate-in fade-in duration-200">
            {/* Filter & Search Bar */}
            <div className="p-3.5 sm:p-4 rounded-2xl flex flex-col gap-3 bg-white border border-slate-200 shadow-sm dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
              {/* Row 1: Search + Selects + Action Controls */}
              <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-2.5">
                {/* Search Bar */}
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3.5 top-2.5 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search posts or @author..."
                    className="w-full border rounded-xl pl-9 pr-3 py-2 text-xs font-sans focus:outline-none focus:border-emerald-600 bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400 dark:bg-slate-950 dark:border-slate-700/80 dark:text-white dark:placeholder-slate-500"
                  />
                </div>

                {/* Filter Dropdowns + Reset + Refresh */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Category Dropdown */}
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="flex-1 sm:flex-none border text-xs rounded-xl px-2.5 py-2 focus:outline-none focus:border-emerald-600 font-mono shadow-xs bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-950 dark:border-slate-700/80 dark:text-slate-300 max-w-full sm:max-w-[190px] truncate"
                  >
                    <option value="all">All Communities &amp; Tags</option>
                    {communityOptions.length > 0 && (
                      <optgroup label="Communities">
                        {communityOptions.map(([catId, label]) => (
                          <option key={catId} value={catId}>
                            {label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {tagOptions.length > 0 && (
                      <optgroup label="General Tags">
                        {tagOptions.map(([catId, label]) => (
                          <option key={catId} value={catId}>
                            {label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  {/* Language Selector */}
                  <select
                    value={selectedLanguage}
                    onChange={(e) => setSelectedLanguage(e.target.value)}
                    className="flex-1 sm:flex-none border text-xs rounded-xl px-2.5 py-2 focus:outline-none focus:border-emerald-600 font-mono shadow-xs bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-950 dark:border-slate-700/80 dark:text-slate-300"
                    title="Filter posts by language script & tags"
                  >
                    <option value="all">🌐 All Languages</option>
                    <option value="en">English</option>
                    <option value="ko">한국어 (Korean)</option>
                    <option value="es">Español (Spanish)</option>
                    <option value="bn">বাংলা (Bengali)</option>
                    <option value="uk">Українська / RU</option>
                    <option value="id">Bahasa Indonesia</option>
                    <option value="other">Other</option>
                  </select>

                  {/* Sorting Dropdown */}
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="flex-1 sm:flex-none border text-xs rounded-xl px-2.5 py-2 focus:outline-none focus:border-emerald-600 font-mono shadow-xs bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-950 dark:border-slate-700/80 dark:text-slate-300"
                    title="Sort curation feed"
                  >
                    <option value="newest">⏱️ Newest First</option>
                    <option value="oldest">⏳ Oldest First</option>
                    <option value="wordCountDesc">📝 Longest (Words)</option>
                    <option value="payoutAsc">💎 Lowest Payout</option>
                    <option value="payoutDesc">💰 Highest Payout</option>
                    <option value="votesDesc">👍 Most Votes</option>
                    <option value="commentsDesc">💬 Most Comments</option>
                  </select>

                  {/* Reset Filters Control */}
                  {isFilterDirty && (
                    <button
                      onClick={handleResetFilters}
                      className="tactile-button flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/60 dark:text-rose-300 transition-colors shrink-0 cursor-pointer"
                      title="Clear all active filters and return to default feed"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Reset</span>
                    </button>
                  )}

                  {/* Refresh Button */}
                  <button
                    onClick={loadData}
                    disabled={loading}
                    className="tactile-button p-2 rounded-xl border transition-colors bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 shrink-0 cursor-pointer"
                    title="Refresh Curation Window"
                    aria-label="Refresh Curation Feed"
                  >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-emerald-600' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Row 2: Counter + Quick Filter Pills + Telemetry */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-2.5 border-t border-slate-100 dark:border-slate-800">
                {/* Pills scrollable container on mobile, wrapped on tablet/desktop */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 sm:flex-wrap">
                  {/* Feed Count & Opportunities Summary Indicator */}
                  <div
                    className="px-2.5 py-1 rounded-xl border text-[11px] font-mono tabular-nums shrink-0 bg-slate-100 border-slate-200 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 whitespace-nowrap"
                    title="Filtered post count and uncurated high-effort opportunities"
                  >
                    <span className="font-semibold">{filteredPosts.length}</span> posts ·{' '}
                    <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                      {opportunityCount} opportunities
                    </span>
                  </div>

                  <button
                    onClick={() => setFilterOpportunitiesOnly(!filterOpportunitiesOnly)}
                    className={`tactile-button text-[11px] px-2.5 py-1 rounded-xl font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      filterOpportunitiesOnly
                        ? 'border border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-200 shadow-xs'
                        : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white'
                    }`}
                    title="Filter exclusively for high-effort posts (< $1.50) without curation votes"
                  >
                    Opportunities
                  </button>

                  <button
                    onClick={() => setFilterLowPayoutOnly(!filterLowPayoutOnly)}
                    className={`tactile-button text-[11px] px-2.5 py-1 rounded-xl font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      filterLowPayoutOnly
                        ? 'border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/50 dark:text-amber-200 shadow-xs'
                        : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white'
                    }`}
                    title={`Filter posts with pending payout < $${OPPORTUNITY_MAX_PAYOUT}`}
                  >
                    Low Payout (&lt; ${OPPORTUNITY_MAX_PAYOUT})
                  </button>

                  <button
                    onClick={() => setFilterClubOnly(!filterClubOnly)}
                    className={`tactile-button text-[11px] px-2.5 py-1 rounded-xl font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      filterClubOnly
                        ? 'border border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-800/70 dark:bg-teal-950/60 dark:text-teal-200 shadow-xs'
                        : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white'
                    }`}
                    title="Filter to posts with Club5050, Club75, or Club100 status"
                  >
                    Club5050+
                  </button>

                  <button
                    onClick={() => setFilterHideAiSpam(!filterHideAiSpam)}
                    className={`tactile-button text-[11px] px-2.5 py-1 rounded-xl font-medium transition-all flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer ${
                      filterHideAiSpam
                        ? 'border border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/60 dark:text-rose-200 shadow-xs'
                        : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white'
                    }`}
                    title="Filter out automated spam bots, coin-doubler promotions, and AI digests"
                  >
                    <Bot className="w-3.5 h-3.5" />
                    <span>Hide AI &amp; Spam</span>
                  </button>

                  <button
                    onClick={() => setFilterExcludeCurators(!filterExcludeCurators)}
                    className={`tactile-button text-[11px] px-2.5 py-1 rounded-xl font-medium transition-all flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer ${
                      filterExcludeCurators
                        ? 'border border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-800/70 dark:bg-indigo-950/60 dark:text-indigo-200 shadow-xs'
                        : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white'
                    }`}
                    title="Exclude posts authored by active Community Curators"
                  >
                    <EyeOff className="w-3.5 h-3.5" />
                    <span>Exclude Curators</span>
                  </button>

                  <button
                    onClick={() => setFilterHideShort(!filterHideShort)}
                    className={`tactile-button text-[11px] px-2.5 py-1 rounded-xl font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      filterHideShort
                        ? 'border border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800/70 dark:bg-sky-950/60 dark:text-sky-200 shadow-xs'
                        : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white'
                    }`}
                    title={`Hide short posts with fewer than ${OPPORTUNITY_MIN_WORDS} words`}
                  >
                    Hide Short (&lt;{OPPORTUNITY_MIN_WORDS}w)
                  </button>

                  <button
                    onClick={() => setFilterHideDiary(!filterHideDiary)}
                    className={`tactile-button text-[11px] px-2.5 py-1 rounded-xl font-medium transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      filterHideDiary
                        ? 'border border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-200 shadow-xs'
                        : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white'
                    }`}
                    title="Hide Diary Game and Dairy Game posts to diversify curation"
                  >
                    Hide Diary
                  </button>

                  {dismissedKeys.size > 0 && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setShowDismissed(!showDismissed)}
                        className={`tactile-button text-[11px] px-2 py-1 rounded-xl font-medium transition-all cursor-pointer ${
                          showDismissed
                            ? 'border border-slate-400 bg-slate-200 text-slate-900 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100'
                            : 'border border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-400'
                        }`}
                        title="Toggle visibility of dismissed posts"
                      >
                        {showDismissed ? 'Hide Dismissed' : `Dismissed (${dismissedKeys.size})`}
                      </button>
                      <button
                        onClick={handleResetDismissed}
                        className="tactile-button p-1 rounded-xl border border-slate-200 bg-slate-100 text-slate-500 hover:text-slate-800 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-400 cursor-pointer"
                        title="Restore all dismissed posts"
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Right: Freshness & RPC Node Telemetry */}
                <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-[11px] font-mono border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400"
                    title={`Connected to node: ${getCurrentRpcNode()} · Updated: ${
                      freshnessMinutes < 1 ? 'Just now' : `${freshnessMinutes}m ago`
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="truncate max-w-[120px]">{getCurrentRpcNode()}</span>
                    <span className="text-slate-300 dark:text-slate-700">·</span>
                    <span>{freshnessMinutes < 1 ? 'Just now' : `${freshnessMinutes}m ago`}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Post Feed Grid with Skeleton Loading */}
            {loading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 items-stretch animate-pulse">
                {Array.from({ length: 6 }).map((_, idx) => (
                  <PostCardSkeleton key={idx} />
                ))}
              </div>
            ) : filteredPosts.length === 0 ? (
              <div
                className={`py-24 text-center text-slate-500 rounded-2xl ${
                  theme === 'dark' ? 'tactile-card' : 'bg-white border border-slate-200'
                }`}
              >
                <SlidersHorizontal className="w-8 h-8 text-slate-400 mx-auto mb-2.5" />
                <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                  No posts found matching criteria.
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Try resetting filters or adjusting your search term.
                </p>
                {isFilterDirty && (
                  <button
                    onClick={handleResetFilters}
                    className="mt-4 px-3.5 py-1.5 rounded-xl text-xs font-semibold border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/60 dark:text-rose-300 transition-colors inline-flex items-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Reset All Filters</span>
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 items-stretch">
                  {filteredPosts.map((post) => (
                    <PostCard
                      key={`${post.author}/${post.permlink}`}
                      post={post}
                      onInspect={handleInspectPost}
                      onClaim={handleClaimPost}
                      onQuickMentorship={handleQuickMentorship}
                      onDismiss={handleDismissPost}
                      currentUser={currentUser}
                      isAuthorizedCurator={isAuthorizedCurator}
                      theme={theme}
                    />
                  ))}
                </div>

                {/* Load More Pagination */}
                <div className="flex flex-col items-center justify-center pt-6 pb-2 gap-2">
                  {hasMore ? (
                    <button
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className="tactile-button flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-teal-500 shadow-sm transition-all disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-teal-400"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${loadingMore ? 'animate-spin text-teal-500' : ''}`}
                      />
                      <span>
                        {loadingMore ? 'Loading older posts from chain...' : 'Load 50 More Posts'}
                      </span>
                    </button>
                  ) : (
                    <div className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                      Reached end of available discussions.
                    </div>
                  )}
                  <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">
                    Showing {filteredPosts.length} posts ({posts.length} loaded from blockchain)
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 2: Rescue & Loss Watch */}
        {activeTab === 'rescue' && (
          <div className="space-y-6 animate-in fade-in duration-200">
            <div className="p-6 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white border border-slate-200 shadow-sm dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <Shield className="w-5 h-5 text-rose-500" />
                  <h2 className="text-lg font-bold text-slate-900 dark:text-white [text-wrap:balance]">
                    Creator Rescue & Loss Watch
                  </h2>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 max-w-2xl [text-wrap:pretty]">
                  Non-curator, high-effort content sitting under $0.50 STU—sorted by expiry urgency so overlooked writers get rescued before payout closes.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  onClick={() => {
                    const nextMode = !strictRescueMode;
                    setStrictRescueMode(nextMode);
                    if (nextMode && !hasScannedRescue) {
                      handleScanRescue();
                    }
                  }}
                  className={`tactile-button text-xs px-3.5 py-1.5 rounded-xl font-medium transition-all flex items-center gap-1.5 ${
                    strictRescueMode
                      ? 'border border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/60 dark:text-rose-200'
                      : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white'
                  }`}
                  title="Filter to >= 3000 chars, expiring in 12h-48h (age 5d-6.5d)"
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span>Strict (&gt;3000 chars, 12h–48h): <span className="font-mono tabular-nums">{strictRescueCount}</span></span>
                </button>
                <button
                  onClick={handleScanRescue}
                  disabled={rescueScanning}
                  className="tactile-button text-xs px-3.5 py-1.5 rounded-xl font-medium transition-all flex items-center gap-1.5 disabled:opacity-50 bg-white border border-slate-200 text-slate-600 hover:text-slate-800 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:text-white"
                  title="Scan blockchain cashout queue (12h-72h to cashout, max age 6d 12h)"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-rose-500 ${rescueScanning ? 'animate-spin' : ''}`} />
                  <span>{rescueScanning ? 'Scanning Chain...' : 'Rescan Chain'}</span>
                </button>
                <div className="px-3.5 py-1.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/60 dark:text-rose-200 font-mono text-xs font-bold tabular-nums">
                  {rescuePosts.length} Posts in Jeopardy
                </div>
              </div>
            </div>

            {rescueScanning && rescuePosts.length === 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 items-stretch animate-pulse">
                {Array.from({ length: 6 }).map((_, idx) => (
                  <PostCardSkeleton key={idx} />
                ))}
              </div>
            ) : rescuePosts.length === 0 ? (
              <div className="py-24 text-center text-slate-500 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800">
                <Shield className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
                  {strictRescueMode
                    ? 'No posts in the scanned window match strict rescue thresholds (>3000 chars, 12h-48h to cashout).'
                    : 'No uncurated high-effort posts in danger of expiring under $1.00 found in the 12h–72h window.'}
                </p>
                <div className="flex items-center justify-center gap-3 mt-4">
                  <button
                    onClick={handleScanRescue}
                    className="tactile-button text-xs px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-medium shadow-md shadow-rose-950/40"
                  >
                    Rescan Chain (12h–72h Window)
                  </button>
                  {strictRescueMode && (
                    <button
                      onClick={() => setStrictRescueMode(false)}
                      className="tactile-button text-xs px-3.5 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-300 hover:text-white animate-fade-in dark:bg-slate-800 dark:border-slate-700"
                    >
                      Switch to Broad Watch (&gt;= 200 words)
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 items-stretch animate-in slide-in-from-bottom duration-300">
                  {rescuePosts.map((post) => (
                    <PostCard
                      key={`${post.author}/${post.permlink}`}
                      post={post}
                      onInspect={handleInspectPost}
                      onClaim={handleClaimPost}
                      onQuickMentorship={handleQuickMentorship}
                      currentUser={currentUser}
                      isAuthorizedCurator={isAuthorizedCurator}
                      theme={theme}
                    />
                  ))}
                </div>

                {/* Rescue Load More Pagination */}
                <div className="flex flex-col items-center justify-center pt-6 pb-2 gap-2">
                  {hasMoreRescue ? (
                    <button
                      onClick={handleLoadMoreRescue}
                      disabled={loadingMoreRescue || rescueScanning}
                      className="tactile-button flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-rose-500 shadow-sm transition-all disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-rose-400"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 text-rose-500 ${loadingMoreRescue ? 'animate-spin' : ''}`}
                      />
                      <span>
                        {loadingMoreRescue
                          ? 'Scanning chain for more expiring posts...'
                          : 'Load More Expiring Posts'}
                      </span>
                    </button>
                  ) : (
                    <div className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                      Reached end of the 72-hour cashout window.
                    </div>
                  )}
                  <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">
                    Showing {rescuePosts.length} posts in jeopardy (12h–72h before cashout, max age 6d 12h)
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 3: Team Queue & Claims */}
        {activeTab === 'claims' && (
          <div className="space-y-6">
            <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-sm dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
              <div className="flex items-center gap-2 mb-1.5">
                <Users className="w-5 h-5 text-teal-600 dark:text-teal-400" />
                <h2 className="text-lg font-bold text-slate-900 dark:text-white [text-wrap:balance]">
                  Team Curation Queue & Anti-Collision Locks
                </h2>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 [text-wrap:pretty]">
                Real-time claim locks broadcasted via <code className="text-emerald-700 dark:text-emerald-400 font-mono">custom_json</code>. Prevents duplicate reviews between teammates and reserves a 45-minute exclusive evaluation window.
              </p>
            </div>

            {queuePosts.length === 0 ? (
              <div className="py-24 text-center text-slate-500 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800">
                <Users className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">No active claims right now.</p>
                <p className="text-xs text-slate-400 mt-1">
                  Navigate to Curation Radar or Rescue and click &quot;Claim Post&quot; to lock a post for your team.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 items-stretch animate-in zoom-in-95 duration-200">
                {queuePosts.map((post) => (
                  <PostCard
                    key={`${post.author}/${post.permlink}`}
                    post={post}
                    onInspect={handleInspectPost}
                    onClaim={handleClaimPost}
                    onQuickMentorship={handleQuickMentorship}
                    currentUser={currentUser}
                    isAuthorizedCurator={isAuthorizedCurator}
                    theme={theme}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: Creator Mentorship & Guidance */}
        {activeTab === 'mentorship' && (
          <div className="space-y-6">
            <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-sm dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
              <div className="flex items-center gap-2 mb-1.5">
                <MessageSquareQuote className="w-5 h-5 text-amber-500" />
                <h2 className="text-lg font-bold text-slate-900 dark:text-white [text-wrap:balance]">
                  Creator Mentorship & Guidance Ledger
                </h2>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 [text-wrap:pretty]">
                Creator Guidance &amp; Revision Loop: Posts placed into <code className="text-amber-700 dark:text-amber-400 font-mono">needs_revision</code>. Authors have 24–48 hours to update tags, source citations, or formatting before getting upvoted.
              </p>
            </div>

            {revisionPosts.length === 0 ? (
              <div className="py-24 text-center text-slate-500 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800">
                <MessageSquareQuote className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">No posts currently awaiting revisions.</p>
                <p className="text-xs text-slate-400 mt-1">
                  When inspecting any post, click &quot;Request Revisions (Needs Work)&quot; to guide a creator.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 items-stretch">
                {revisionPosts.map((post) => (
                  <PostCard
                    key={`${post.author}/${post.permlink}`}
                    post={post}
                    onInspect={handleInspectPost}
                    onClaim={handleClaimPost}
                    onQuickMentorship={handleQuickMentorship}
                    currentUser={currentUser}
                    isAuthorizedCurator={isAuthorizedCurator}
                    theme={theme}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 5: Curation Intelligence */}
        {activeTab === 'intelligence' && (
          <IntelligenceView
            posts={posts}
            teamAccounts={teamAccounts}
            curationClaims={curationClaimsList}
            theme={theme}
          />
        )}

        {/* TAB 6: Weekly Report Generator */}
        {activeTab === 'report' && (
          <ReportView
            posts={posts}
            approvedPosts={approvedPosts}
            currentTeam={currentTeam}
            currentUser={currentUser}
            theme={theme}
          />
        )}
      </main>

      {/* Modal Inspector */}
      <PostModal
        post={selectedPost}
        onClose={handleCloseModal}
        currentUser={currentUser}
        teamAccount={currentTeam ? currentTeam.account : ''}
        teamName={currentTeam ? currentTeam.name : 'Observer (Read-Only)'}
        isAuthorizedCurator={isAuthorizedCurator}
        onClaimUpdated={handleClaimUpdated}
        initialShowRevision={showRevisionModal}
        theme={theme}
        onLogin={handleLogin}
      />
    </div>
  );
}

export default App;
