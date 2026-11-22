import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  FileText,
  Copy,
  Check,
  Sparkles,
  Trash2,
  AlertTriangle,
  ShieldAlert,
  Search,
  Download,
  Plus,
  RefreshCw,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  Eye,
  Code,
  Wand2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { PostItem, CurationTeam } from '../types';
import {
  ALL_CURATOR_MEMBERS,
  COMMUNITY_CURATOR_TEAMS,
  DEFAULT_POST_FALLBACK_IMAGE,
  isDiaryPost,
} from '../lib/constants';
import { REVISION_REASONS } from '../lib/mentorshipTemplates';
import {
  generateSteemPodReport,
  type ReportConfig,
  type CurationReachSummary,
  buildCleanSteemUrl,
} from '../lib/reportGenerator';
import {
  fetchCurationIntelligence,
  fetchTeamOnChainCuratedPosts,
  fetchPostBySteemUrl,
} from '../lib/steem';
import { formatSteemReputation, extractPostImages } from '../lib/textUtils';

const reportSanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'center',
    'iframe',
    'sub',
    'sup',
  ],
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), 'className', 'align'],
    p: [...(defaultSchema.attributes?.p ?? []), 'className', 'align'],
    center: ['className'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'className'],
    a: ['href', 'title', 'target', 'rel', 'className'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align', 'valign'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align', 'valign'],
  },
};

interface ReportViewProps {
  posts: PostItem[];
  approvedPosts: PostItem[];
  currentTeam: CurationTeam | null;
  currentUser: string | null;
  theme?: 'dark' | 'light';
}

export const ReportView: React.FC<ReportViewProps> = ({
  posts,
  approvedPosts,
  currentTeam,
  currentUser,
}) => {
  // Auto-compute default week and month based on current calendar date
  const now = useMemo(() => new Date(), []);
  const defaultWeek = useMemo(
    () => Math.min(5, Math.max(1, Math.ceil(now.getDate() / 7))),
    [now]
  );
  const defaultMonth = useMemo(
    () => new Intl.DateTimeFormat('en-US', { month: 'long' }).format(now),
    [now]
  );

  const [selectedTeamId, setSelectedTeamId] = useState<string>(
    currentTeam ? currentTeam.id : 'team-3'
  );
  const [weekNumber, setWeekNumber] = useState(defaultWeek);
  const [monthName, setMonthName] = useState(defaultMonth);
  const [includeReachAudit, setIncludeReachAudit] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [outputTab, setOutputTab] = useState<'preview' | 'raw'>('preview');

  // On-chain 7-day curated posts for the selected team
  const [onChainCandidates, setOnChainCandidates] = useState<PostItem[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);

  // Candidate search & URL input
  const [searchQuery, setSearchQuery] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [urlStatusMessage, setUrlStatusMessage] = useState<{
    text: string;
    type: 'success' | 'error';
  } | null>(null);

  const [top7, setTop7] = useState<
    { post: PostItem; justification: string; nominatedBy: string }[]
  >([]);

  const [generatedMarkdown, setGeneratedMarkdown] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // Sync dropdown once currentTeam finishes loading
  useEffect(() => {
    if (currentTeam) {
      setSelectedTeamId(currentTeam.id);
    }
  }, [currentTeam]);

  const team = useMemo(
    () =>
      COMMUNITY_CURATOR_TEAMS.find((t) => t.id === selectedTeamId) ||
      COMMUNITY_CURATOR_TEAMS[2],
    [selectedTeamId]
  );

  // Fetch actual 7-day on-chain votes cast by this team's curation account
  const loadTeamCuratedPosts = useCallback(async (account: string) => {
    setLoadingCandidates(true);
    try {
      const results = await fetchTeamOnChainCuratedPosts(account, 7, 30);
      setOnChainCandidates(results);
    } catch (err) {
      console.warn(`Failed to fetch 7-day on-chain votes for ${account}:`, err);
    } finally {
      setLoadingCandidates(false);
    }
  }, []);

  useEffect(() => {
    if (team.account) {
      loadTeamCuratedPosts(team.account);
    }
  }, [team.account, loadTeamCuratedPosts]);

  // Genuine team-curated or team-approved posts from current memory feed
  const feedTeamVotedPosts = useMemo(
    () =>
      posts.filter(
        (p) =>
          p.curatorAccountsVoted.includes(team.account) ||
          approvedPosts.some((ap) => ap.id === p.id && ap.claim?.account === team.account)
      ),
    [posts, approvedPosts, team.account]
  );

  // Deduplicate and combine on-chain curated posts with feed-curated posts
  const combinedCandidates = useMemo(() => {
    const map = new Map<string, PostItem>();

    // 1. Prioritize on-chain ledger votes
    for (const p of onChainCandidates) {
      map.set(`${p.author}/${p.permlink}`, p);
    }
    // 2. Add feed-curated posts
    for (const p of feedTeamVotedPosts) {
      const key = `${p.author}/${p.permlink}`;
      if (!map.has(key)) map.set(key, p);
    }
    // 3. Fallback to general feed only if team has zero curated posts anywhere
    if (map.size === 0) {
      for (const p of posts) {
        map.set(`${p.author}/${p.permlink}`, p);
      }
    }

    return Array.from(map.values());
  }, [onChainCandidates, feedTeamVotedPosts, posts]);

  // Filter candidates by search query (author, title, category)
  const filteredCandidates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return combinedCandidates;
    // Don't filter if query looks like a full URL (user wants to fetch it)
    if (q.startsWith('http') || q.includes('/@')) {
      return combinedCandidates;
    }
    return combinedCandidates.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.communityTitle && p.communityTitle.toLowerCase().includes(q))
    );
  }, [combinedCandidates, searchQuery]);

  // Is current search query a Steemit URL or @author/permlink?
  const isUrlInput = useMemo(() => {
    const q = searchQuery.trim();
    return q.includes('/@') || (q.startsWith('@') && q.includes('/'));
  }, [searchQuery]);

  // Fetch post by URL and add to candidate list
  const handleFetchUrlPost = async () => {
    if (!searchQuery.trim()) return;
    setFetchingUrl(true);
    setUrlStatusMessage(null);
    try {
      const fetched = await fetchPostBySteemUrl(searchQuery.trim());
      if (fetched) {
        // Add to candidates list at top
        setOnChainCandidates((prev) => {
          const key = `${fetched.author}/${fetched.permlink}`;
          return [fetched, ...prev.filter((p) => `${p.author}/${p.permlink}` !== key)];
        });
        // If room in Top 7, offer to add directly
        if (top7.length < 7 && !top7.some((t) => t.post.id === fetched.id)) {
          setTop7((prev) => [
            ...prev,
            {
              post: fetched,
              justification: `Outstanding original contribution in #${fetched.category} demonstrating clear technical depth, verified sources, and meticulous presentation.`,
              nominatedBy: currentUser || team.members[0],
            },
          ]);
          setUrlStatusMessage({
            text: `Added @${fetched.author}'s post directly to Top 7!`,
            type: 'success',
          });
        } else {
          setUrlStatusMessage({
            text: `Found @${fetched.author}'s post and added to candidates.`,
            type: 'success',
          });
        }
        setSearchQuery('');
      } else {
        setUrlStatusMessage({
          text: 'Could not locate post on-chain. Please verify the URL/permlink.',
          type: 'error',
        });
      }
    } catch {
      setUrlStatusMessage({
        text: 'Error querying Steem RPC for this URL.',
        type: 'error',
      });
    } finally {
      setFetchingUrl(false);
    }
  };

  // Real mentored posts from revision ledger / resolved claims
  const mentoredEntries = useMemo(() => {
    return posts
      .filter(
        (p) =>
          p.claim &&
          (p.claim.status === 'needs_revision' ||
            Boolean(p.claim.guidanceCommentPermlink) ||
            (p.claim.reasons && p.claim.reasons.length > 0))
      )
      .map((p) => {
        const reasonLabels = (p.claim?.reasons || [])
          .map((id) => REVISION_REASONS.find((r) => r.id === id)?.label || id)
          .join(', ');
        return {
          post: p,
          revisionOutcome:
            reasonLabels || p.claim?.notes || 'Guided creator on formatting, citations & club adherence',
          curator: p.claim?.curator || team.members[0],
        };
      });
  }, [posts, team.members]);

  // Compliance checks on Top 7 selections
  const top7DiaryCount = top7.filter((item) => isDiaryPost(item.post)).length;
  const top7CuratorAuthors = top7
    .filter((item) => ALL_CURATOR_MEMBERS.has(item.post.author.toLowerCase()))
    .map((item) => `@${item.post.author}`);

  const handleSelectPostForTop7 = (post: PostItem) => {
    if (top7.some((item) => item.post.id === post.id)) return;
    if (top7.length >= 7) return;
    setTop7((prev) => [
      ...prev,
      {
        post,
        justification: `Outstanding original contribution in #${post.category} demonstrating clear technical depth, verified sources, and meticulous presentation.`,
        nominatedBy: currentUser || team.members[0],
      },
    ]);
  };

  // Auto-fill Top 7 smartly prioritizing non-curators, high effort, and diverse categories
  const handleAutoFillTop7 = () => {
    const currentIds = new Set(top7.map((t) => t.post.id));
    const needed = 7 - top7.length;
    if (needed <= 0) return;

    // Filter eligible: not already selected, not a curator author
    const eligible = combinedCandidates.filter(
      (p) => !currentIds.has(p.id) && !ALL_CURATOR_MEMBERS.has(p.author.toLowerCase())
    );

    // Sort by wordCount descending and imageCount
    eligible.sort((a, b) => b.wordCount + b.imageCount * 100 - (a.wordCount + a.imageCount * 100));

    const additions = eligible.slice(0, needed).map((post, idx) => ({
      post,
      justification: `High-quality original publication in #${post.category} with comprehensive structure, authentic imagery, and valuable community insights.`,
      nominatedBy: team.members[idx % team.members.length] || currentUser || 'curator',
    }));

    setTop7((prev) => [...prev, ...additions]);
  };

  const handleRemoveTop7 = (id: number) => {
    setTop7((prev) => prev.filter((item) => item.post.id !== id));
  };

  const handleMoveTop7 = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= top7.length) return;
    setTop7((prev) => {
      const copy = [...prev];
      const temp = copy[index];
      copy[index] = copy[targetIndex];
      copy[targetIndex] = temp;
      return copy;
    });
  };

  const handleUpdateJustification = (id: number, text: string) => {
    setTop7((prev) =>
      prev.map((item) => (item.post.id === id ? { ...item, justification: text } : item))
    );
  };

  const canGenerate = top7.length > 0 || includeReachAudit;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    try {
      let reachMetrics: CurationReachSummary | undefined;
      if (includeReachAudit) {
        try {
          const audit = await fetchCurationIntelligence(7);
          const totalActiveAuthors = new Set(posts.map((p) => p.author.toLowerCase())).size;
          const postSupportRate =
            audit.totalVotes > 0 ? (audit.postVotes / audit.totalVotes) * 100 : 0;
          const commentSupportRate =
            audit.totalVotes > 0 ? (audit.commentVotes / audit.totalVotes) * 100 : 0;

          reachMetrics = {
            totalActiveAuthors: Math.max(totalActiveAuthors, audit.uniqueAuthorsSupported),
            authorsCurated: audit.uniqueAuthorsSupported,
            postSupportRatePercent: postSupportRate,
            commentSupportRatePercent: commentSupportRate,
            giniCoefficient: audit.giniCoefficient,
          };
        } catch (err) {
          console.warn('Could not attach live reach metrics:', err);
        }
      }

      // Include all curated posts from on-chain history + feed + explicitly picked Top 7
      const verifiedPostMap = new Map<number, PostItem>();
      for (const p of onChainCandidates) verifiedPostMap.set(p.id, p);
      for (const p of feedTeamVotedPosts) verifiedPostMap.set(p.id, p);
      for (const pick of top7) verifiedPostMap.set(pick.post.id, pick.post);

      // Auto-compute club distribution from verified posts
      let club100 = 0, club75 = 0, club5050 = 0, clubless = 0;
      for (const p of verifiedPostMap.values()) {
        const tier = p.clubStatus?.tier;
        if (tier === 'Club100') club100++;
        else if (tier === 'Club75') club75++;
        else if (tier === 'Club5050') club5050++;
        else clubless++;
      }

      const config: ReportConfig = {
        teamName: team.name,
        account: team.account,
        curatorMembers: team.members,
        weekNumber,
        monthName,
        year: 2026,
        topSevenPicks: top7,
        allCuratedPosts: Array.from(verifiedPostMap.values()),
        mentoredPosts: mentoredEntries,
        reachMetrics,
        clubDistribution: {
          club100,
          club75,
          club5050,
          clubless,
        },
      };

      const reportMd = generateSteemPodReport(config);
      setGeneratedMarkdown(reportMd);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = () => {
    if (!generatedMarkdown) return;
    navigator.clipboard.writeText(generatedMarkdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!generatedMarkdown) return;
    const filename = `Steem-POD-Weekly-Report-Week${weekNumber}-${monthName}-2026.md`;
    const blob = new Blob([generatedMarkdown], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <FileText className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 [text-wrap:balance]">
              Steem Community Curation Weekly Report Overhaul
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-2xl [text-wrap:pretty] leading-relaxed">
            Compiles modern, gold-standard Steemit curation reports with embedded cover showcases, shift self-reward audits, Club100/75/5050 distributions, mentorship logs, and verified Steemit Team reach ratios.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <select
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            className="rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold font-mono text-emerald-800 shadow-2xs focus:border-emerald-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-emerald-300 cursor-pointer"
          >
            {COMMUNITY_CURATOR_TEAMS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (@{t.account})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* Left Column: Controls & Candidate Picker */}
        <div className="space-y-5 lg:col-span-6">
          {/* Card 1: Report Cycle Parameters */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h4 className="mb-4 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Report Cycle Parameters
            </h4>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Week Number
                </span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={weekNumber}
                  onChange={(e) => setWeekNumber(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-2xs transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-emerald-400 font-mono tabular-nums"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Month
                </span>
                <input
                  type="text"
                  value={monthName}
                  onChange={(e) => setMonthName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-2xs transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-emerald-400"
                />
              </label>
            </div>

            <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={includeReachAudit}
                onChange={(e) => setIncludeReachAudit(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-emerald-600 dark:border-slate-600 cursor-pointer"
              />
              <span>Attach live 7-day Reach &amp; Gini Ledger Audit</span>
            </label>
          </section>

          {/* Card 2: Top 7 Weekly Picks */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Top 7 Weekly Selections{' '}
                  <span className="font-mono text-xs font-medium text-slate-500 dark:text-slate-400">
                    ({top7.length}/7)
                  </span>
                </h4>
                {top7.length < 7 && (
                  <button
                    type="button"
                    onClick={handleAutoFillTop7}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 cursor-pointer transition-colors"
                    title="Automatically pick top-scoring curated posts"
                  >
                    <Wand2 className="w-3 h-3" />
                    <span>Auto-Fill</span>
                  </button>
                )}
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {mentoredEntries.length} Mentored Logged
              </span>
            </div>

            {/* Live Compliance Guardrails */}
            {top7DiaryCount > 2 && (
              <div className="mb-3 p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800/60 dark:text-amber-200 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span>
                  <strong>Diversity Alert:</strong> {top7DiaryCount} of your Top 7 picks are Diary Game posts (recommended max: 2).
                </span>
              </div>
            )}

            {top7CuratorAuthors.length > 0 && (
              <div className="mb-3 p-2.5 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-900 dark:bg-indigo-950/40 dark:border-indigo-800/60 dark:text-indigo-200 text-xs flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <span>
                  <strong>Steemit Team Reminder:</strong> Fellow curator(s) selected ({top7CuratorAuthors.join(', ')}). Teams should avoid picking other Community Curators in Top 7 selections.
                </span>
              </div>
            )}

            {top7.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-4 py-6 text-center text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-400">
                Select up to 7 curated articles below, click &quot;Auto-Fill&quot;, or paste a Steemit URL to compile your report.
              </div>
            ) : (
              <div className="space-y-3 max-h-84 overflow-y-auto pr-1">
                {top7.map((item, idx) => {
                  const images = extractPostImages({
                    body: item.post.body,
                    json_metadata: item.post.json_metadata,
                  });
                  const thumb = images[0] || DEFAULT_POST_FALLBACK_IMAGE;

                  return (
                    <div
                      key={item.post.id}
                      className="p-3 rounded-lg border border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-800/50 space-y-2 text-xs"
                    >
                      <div className="flex items-center justify-between font-mono">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-emerald-700 dark:text-emerald-400">
                            #{idx + 1}
                          </span>
                          <a
                            href={buildCleanSteemUrl(item.post)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-slate-900 dark:text-slate-100 hover:underline flex items-center gap-1"
                          >
                            <span>@{item.post.author}</span>
                            <ExternalLink className="w-3 h-3 text-slate-400" />
                          </a>
                          {item.post.clubStatus && (
                            <span className="rounded bg-slate-200/80 px-1.5 py-0.2 text-[10px] font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                              {item.post.clubStatus.tier}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleMoveTop7(idx, 'up')}
                            disabled={idx === 0}
                            className="p-1 text-slate-500 hover:text-slate-900 disabled:opacity-30 dark:hover:text-white cursor-pointer"
                            title="Move Up"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMoveTop7(idx, 'down')}
                            disabled={idx === top7.length - 1}
                            className="p-1 text-slate-500 hover:text-slate-900 disabled:opacity-30 dark:hover:text-white cursor-pointer"
                            title="Move Down"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveTop7(item.post.id)}
                            className="p-1 text-rose-600 hover:text-rose-700 dark:text-rose-400 ml-1 cursor-pointer"
                            title="Remove from Top 7"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2.5">
                        <img
                          src={thumb}
                          alt="Thumbnail"
                          className="w-12 h-10 object-cover rounded-md border border-slate-200 dark:border-slate-700 shrink-0"
                          onError={(e) => {
                            e.currentTarget.src = DEFAULT_POST_FALLBACK_IMAGE;
                          }}
                        />
                        <p className="text-slate-800 dark:text-slate-200 font-medium truncate flex-1">
                          {item.post.title}
                        </p>
                      </div>

                      <textarea
                        value={item.justification}
                        onChange={(e) => handleUpdateJustification(item.post.id, e.target.value)}
                        placeholder="Why this post was chosen as a Top 7 pick..."
                        rows={2}
                        className="w-full rounded-md border border-slate-300 bg-white p-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Card 3: Candidate Picker (Light/Dark + Search + URL Input) */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <span>7-Day Curated Candidates</span>
                {loadingCandidates && (
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 animate-spin" />
                )}
              </h4>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400 font-mono">
                @{team.account} ({onChainCandidates.length} on-chain votes)
              </span>
            </div>

            {/* Search or URL Input Bar */}
            <div className="mb-3 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isUrlInput) {
                      e.preventDefault();
                      handleFetchUrlPost();
                    }
                  }}
                  placeholder="Search by title, @author, or paste Steemit post URL..."
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 py-2 text-xs text-slate-900 placeholder:text-slate-500 focus:border-emerald-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-400"
                />
              </div>

              {isUrlInput && (
                <button
                  type="button"
                  onClick={handleFetchUrlPost}
                  disabled={fetchingUrl}
                  className="shrink-0 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{fetchingUrl ? 'Fetching...' : 'Add URL'}</span>
                </button>
              )}
            </div>

            {urlStatusMessage && (
              <div
                className={`mb-3 p-2 rounded-lg text-xs flex items-center justify-between ${
                  urlStatusMessage.type === 'success'
                    ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'bg-rose-50 text-rose-900 dark:bg-rose-950/60 dark:text-rose-300'
                }`}
              >
                <span>{urlStatusMessage.text}</span>
                <button
                  onClick={() => setUrlStatusMessage(null)}
                  className="underline ml-2 hover:opacity-80 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {loadingCandidates ? (
                <div className="py-8 text-center text-xs text-slate-500">
                  <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin text-emerald-600 dark:text-emerald-400" />
                  <p>Loading 7-day on-chain curation history for @{team.account}...</p>
                </div>
              ) : filteredCandidates.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-500">
                  No matching candidates found. Paste a Steemit post URL above to add it.
                </div>
              ) : (
                filteredCandidates.map((post) => {
                  const isSelected = top7.some((item) => item.post.id === post.id);
                  const isCurator = ALL_CURATOR_MEMBERS.has(post.author.toLowerCase());
                  const communityLabel =
                    post.communityTitle ||
                    (post.category.startsWith('hive-')
                      ? post.category
                      : `#${post.category}`);
                  const images = extractPostImages({
                    body: post.body,
                    json_metadata: post.json_metadata,
                  });
                  const thumb = images[0] || DEFAULT_POST_FALLBACK_IMAGE;
                  const rep = formatSteemReputation(post.authorReputation);

                  return (
                    <div
                      key={post.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 transition-colors hover:border-slate-300 hover:bg-slate-100/80 dark:border-slate-800 dark:bg-slate-800/60 dark:hover:border-slate-700 dark:hover:bg-slate-800"
                    >
                      <img
                        src={thumb}
                        alt="Thumbnail"
                        className="w-10 h-10 object-cover rounded-md border border-slate-200 dark:border-slate-700 shrink-0"
                        onError={(e) => {
                          e.currentTarget.src = DEFAULT_POST_FALLBACK_IMAGE;
                        }}
                      />

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {post.title}
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            @{post.author} ({rep})
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="truncate max-w-[150px]">{communityLabel}</span>
                          {post.clubStatus && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                                {post.clubStatus.tier}
                              </span>
                            </>
                          )}
                          {isCurator && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-indigo-700 dark:text-indigo-300 font-medium">
                                Curator
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleSelectPostForTop7(post)}
                        disabled={isSelected || top7.length >= 7}
                        className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                          isSelected
                            ? 'border border-emerald-600/40 bg-emerald-100 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-950/60 dark:text-emerald-300'
                            : 'border border-emerald-600/30 bg-emerald-50 text-emerald-800 hover:bg-emerald-700 hover:text-white dark:border-emerald-500/40 dark:bg-emerald-950/60 dark:text-emerald-300 dark:hover:bg-emerald-500 dark:hover:text-slate-950'
                        }`}
                      >
                        {isSelected ? 'Selected' : '+ Top 7'}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Primary Action Button */}
          <button
            type="button"
            disabled={!canGenerate || generating}
            onClick={handleGenerate}
            className="w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-600 dark:text-white dark:hover:bg-emerald-500 cursor-pointer flex items-center justify-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            <span>
              {generating
                ? 'Compiling On-Chain Report...'
                : `Generate Steem POD Weekly Report Markdown (${top7.length}/7)`}
            </span>
          </button>
        </div>

        {/* Right Column: Sticky Verified Output with Live Preview vs Raw Toggle */}
        <section className="flex min-h-[620px] flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-xs lg:col-span-6 lg:sticky lg:top-20 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-100 pb-3 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>Verified Report Output</span>
              </h4>

              {/* Preview vs Raw Tabs */}
              {generatedMarkdown && (
                <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-mono dark:bg-slate-800">
                  <button
                    type="button"
                    onClick={() => setOutputTab('preview')}
                    className={`flex items-center gap-1 rounded-md px-2 py-0.5 transition-colors cursor-pointer ${
                      outputTab === 'preview'
                        ? 'bg-white font-bold text-emerald-800 shadow-2xs dark:bg-slate-900 dark:text-emerald-400'
                        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    <span>Preview</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setOutputTab('raw')}
                    className={`flex items-center gap-1 rounded-md px-2 py-0.5 transition-colors cursor-pointer ${
                      outputTab === 'raw'
                        ? 'bg-white font-bold text-emerald-800 shadow-2xs dark:bg-slate-900 dark:text-emerald-400'
                        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                    }`}
                  >
                    <Code className="w-3 h-3" />
                    <span>Markdown</span>
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!generatedMarkdown}
                onClick={handleCopy}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                title="Copy Markdown to Clipboard"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copied ? 'Copied!' : 'Copy'}</span>
              </button>

              <button
                type="button"
                disabled={!generatedMarkdown}
                onClick={handleDownload}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                title="Download .md file"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .md</span>
              </button>
            </div>
          </div>

          {generatedMarkdown ? (
            outputTab === 'preview' ? (
              <div className="flex-1 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950 prose prose-sm prose-slate max-w-none dark:prose-invert prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-slate-900 dark:prose-headings:text-slate-100 prose-img:mx-auto prose-img:rounded-xl prose-img:border prose-img:border-slate-200 dark:prose-img:border-slate-800 prose-a:text-emerald-700 dark:prose-a:text-emerald-400 prose-blockquote:border-l-emerald-600 prose-table:text-xs">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, [rehypeSanitize, reportSanitizeSchema]]}
                  components={{
                    img: ({ src = '', alt = '' }) => (
                      <img
                        src={src}
                        alt={alt}
                        loading="lazy"
                        className="max-h-[360px] w-auto max-w-full rounded-xl object-contain my-3 mx-auto shadow-xs"
                        onError={(e) => {
                          e.currentTarget.src = DEFAULT_POST_FALLBACK_IMAGE;
                        }}
                      />
                    ),
                    table: ({ children }) => (
                      <div className="overflow-x-auto my-3">
                        <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-left text-xs">
                          {children}
                        </table>
                      </div>
                    ),
                  }}
                >
                  {generatedMarkdown}
                </ReactMarkdown>
              </div>
            ) : (
              <textarea
                readOnly
                value={generatedMarkdown}
                rows={24}
                className="flex-1 w-full overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 focus:outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200 resize-none select-text"
              />
            )
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-6 text-center dark:border-slate-700 dark:bg-slate-800/30">
              <FileText className="w-8 h-8 text-slate-400 dark:text-slate-500 mb-2.5" />
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                No report compiled yet
              </p>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                Select your Top 7 curated articles (or click &ldquo;Auto-Fill&rdquo;) and click &ldquo;Generate Steem POD Weekly Report Markdown&rdquo;.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
