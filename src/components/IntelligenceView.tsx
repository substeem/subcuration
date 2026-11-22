import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  BarChart3,
  PieChart,
  ShieldAlert,
  RefreshCw,
  Users,
  Scale,
} from 'lucide-react';
import type { PostItem, CurationTeam, CurationClaim } from '../types';
import {
  ALL_CURATOR_MEMBERS,
  DIARY_KEYWORDS,
  isLowQualityOrBotPost,
} from '../lib/constants';
import {
  fetchCurationIntelligence,
  type CurationIntelligenceSnapshot,
  type TeamCurationAudit,
} from '../lib/steem';
import { formatRelativeSteemTime } from '../lib/textUtils';

interface IntelligenceViewProps {
  posts: PostItem[];
  teamAccounts: CurationTeam[];
  curationClaims: CurationClaim[];
  theme?: 'dark' | 'light';
}

export const IntelligenceView: React.FC<IntelligenceViewProps> = ({
  posts,
  teamAccounts,
  curationClaims: _curationClaims,
}) => {
  const [windowDays, setWindowDays] = useState<7 | 14>(7);
  const [snapshot, setSnapshot] = useState<CurationIntelligenceSnapshot | null>(null);
  const [loadingAudit, setLoadingAudit] = useState(true);

  const loadAudit = useCallback(async (days: 7 | 14) => {
    setLoadingAudit(true);
    try {
      const data = await fetchCurationIntelligence(days);
      setSnapshot(data);
    } catch (err) {
      console.error('Failed to load on-chain curation intelligence:', err);
    } finally {
      setLoadingAudit(false);
    }
  }, []);

  useEffect(() => {
    loadAudit(windowDays);
  }, [windowDays, loadAudit]);

  // Combined curator set (static 31 + live accounts)
  const curatorSet = useMemo(() => {
    const s = new Set<string>(ALL_CURATOR_MEMBERS);
    for (const t of teamAccounts) {
      if (t.account) s.add(t.account.toLowerCase());
      for (const m of t.members) s.add(m.toLowerCase());
    }
    return s;
  }, [teamAccounts]);

  // Map category IDs (e.g. hive-183369) to human-readable names
  const communityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of posts) {
      if (p.communityTitle && !map.has(p.category)) {
        map.set(p.category, p.communityTitle);
      }
    }
    return map;
  }, [posts]);

  // Live window metrics
  const totalPosts = posts.length;
  const curatedPosts = useMemo(() => posts.filter((p) => p.curatorVoted), [posts]);
  const uncuratedPosts = useMemo(() => posts.filter((p) => !p.curatorVoted), [posts]);
  const windowConversionRate =
    totalPosts > 0 ? ((curatedPosts.length / totalPosts) * 100).toFixed(1) : '0.0';

  // Category & Diary diversity
  const { categoryEntries, diaryCount, diaryRatio } = useMemo(() => {
    const map: Record<string, number> = {};
    let diaries = 0;
    for (const p of posts) {
      map[p.category] = (map[p.category] || 0) + 1;
      const haystack = `${p.category} ${p.title}`.toLowerCase();
      if (DIARY_KEYWORDS.some((kw) => haystack.includes(kw))) {
        diaries++;
      }
    }
    return {
      categoryEntries: Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 7),
      diaryCount: diaries,
      diaryRatio: totalPosts > 0 ? Math.round((diaries / totalPosts) * 100) : 0,
    };
  }, [posts, totalPosts]);

  // High-effort non-curator posts at risk (filtered for spam / profit-schemes / bots)
  const atRiskCreators = useMemo(
    () =>
      uncuratedPosts.filter(
        (p) =>
          !curatorSet.has(p.author.toLowerCase()) &&
          !isLowQualityOrBotPost(p) &&
          p.wordCount >= 250 &&
          p.pendingPayout < 0.5
      ),
    [uncuratedPosts, curatorSet]
  );

  // Derived chain audit badges
  const ownTeamSelfVotes = snapshot?.ownTeamSelfVotes ?? snapshot?.curatorSelfVotes ?? 0;
  const ownTeamSelfVotePercent = snapshot?.ownTeamSelfVotePercent ?? snapshot?.curatorSelfVotePercent ?? 0;
  const fellowCuratorVotes = snapshot?.fellowCuratorVotes ?? 0;
  const fellowCuratorVotePercent = snapshot?.fellowCuratorVotePercent ?? 0;
  const crossTeamCuratorVotes =
    snapshot?.crossTeamCuratorVotes ?? Math.max(0, fellowCuratorVotes - ownTeamSelfVotes);
  const crossTeamCuratorVotePercent =
    snapshot?.crossTeamCuratorVotePercent ??
    (snapshot?.totalVotes && snapshot.totalVotes > 0
      ? Math.round((crossTeamCuratorVotes / snapshot.totalVotes) * 1000) / 10
      : 0);

  // Steemit Policy:
  // Active curator gets 1 vote of 100% per 24h on duty (10.0% of team VP).
  // Solo curators (Team 4 / @weisser-rabe) curate 7 days -> max 7 votes/7d (10.0%).
  // 3-member teams curate 2-3 days each -> max 2-3 votes per member (team total <= 7 votes / 10%).
  // Cross-team votes represent organic community curation of fellow creators.
  const isCuratorVoteExcessive = ownTeamSelfVotePercent > 10.0;

  // Gini buffer band: <= 0.48 Healthy, 0.48 - 0.55 Moderate, > 0.55 Concentrated
  const gini = snapshot?.giniCoefficient ?? 0;
  const isGiniHigh = gini > 0.55;
  const isGiniWatch = gini > 0.48 && gini <= 0.55;

  // Post vs Comment vote breakdown with 1 decimal precision
  const totalVotes = snapshot?.totalVotes ?? 0;
  const postVotes = snapshot?.postVotes ?? 0;
  const commentVotes = snapshot?.commentVotes ?? 0;
  const postVotePct =
    totalVotes > 0 ? ((postVotes / totalVotes) * 100).toFixed(1) : '0.0';
  const commentVotePct =
    totalVotes > 0 ? ((commentVotes / totalVotes) * 100).toFixed(1) : '0.0';
  const timeframeLabel = `${windowDays}D`;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:shadow-none flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <BarChart3 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            <h2 className="text-lg font-bold text-slate-900 dark:text-white [text-wrap:balance]">
              Live Curation Intelligence &amp; Reach Audit
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-2xl [text-wrap:pretty] leading-relaxed">
            On-chain ledger audit across all official Steemcurator &amp; Booming accounts—tracking post vs. comment votes, author reach, Gini inequality, and the 10% curator self-vote threshold.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="inline-flex rounded-xl bg-slate-100 border border-slate-200 p-0.5 text-xs font-mono dark:bg-slate-800 dark:border-slate-700">
            <button
              onClick={() => setWindowDays(7)}
              className={`px-3 py-1 rounded-lg transition-colors ${
                windowDays === 7
                  ? 'bg-white text-emerald-800 font-bold shadow-sm dark:bg-emerald-950/60 dark:text-emerald-300'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              7D Audit
            </button>
            <button
              onClick={() => setWindowDays(14)}
              className={`px-3 py-1 rounded-lg transition-colors ${
                windowDays === 14
                  ? 'bg-white text-emerald-800 font-bold shadow-sm dark:bg-emerald-950/60 dark:text-emerald-300'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              14D Audit
            </button>
          </div>

          <button
            onClick={() => loadAudit(windowDays)}
            disabled={loadingAudit}
            className="p-2 rounded-xl bg-slate-100 border border-slate-200 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:hover:bg-slate-700 dark:text-slate-300 transition-colors"
            title="Refresh On-Chain Audit"
            aria-label="Refresh On-Chain Audit"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${
                loadingAudit ? 'animate-spin text-emerald-600 dark:text-emerald-400' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {/* Primary Ledger Metrics Grid (Consistent 3-Band Anatomy) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* Card 1: Official Votes */}
        <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <h4 className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
              {timeframeLabel} Official Votes
            </h4>
            {!loadingAudit && (
              <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-300">
                Active Ledger
              </span>
            )}
          </div>

          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold tracking-tight tabular-nums text-emerald-700 dark:text-emerald-400">
              {loadingAudit ? '—' : totalVotes.toLocaleString()}
            </span>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              total cast
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs tabular-nums">
            <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
              {loadingAudit ? '—' : `${postVotes.toLocaleString()} posts (${postVotePct}%)`}
            </span>
            <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
              {loadingAudit ? '—' : `${commentVotes.toLocaleString()} comments (${commentVotePct}%)`}
            </span>
          </div>

          <p className="mt-auto border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
            Balanced post &amp; comment distribution.
          </p>
        </div>

        {/* Card 2: Unique Authors */}
        <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <h4 className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
              Unique Authors
            </h4>
            {!loadingAudit && (
              <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {timeframeLabel} Window
              </span>
            )}
          </div>

          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold tracking-tight tabular-nums text-emerald-700 dark:text-emerald-400">
              {loadingAudit ? '—' : (snapshot?.uniqueAuthorsSupported ?? 0).toLocaleString()}
            </span>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              creators reached
            </span>
          </div>

          <div className="mt-2.5 flex items-center gap-1.5 text-xs tabular-nums">
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {loadingAudit ? '—' : `${snapshot?.repeatVoteRate ?? 0}x avg votes / author`}
            </span>
          </div>

          <p className="mt-auto border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
            Average curation frequency per author.
          </p>
        </div>

        {/* Card 3: Vote Gini Index */}
        <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <h4 className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
              Vote Gini Index
            </h4>
            {!loadingAudit && (
              <span
                className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                  isGiniHigh
                    ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/60 dark:text-rose-200'
                    : isGiniWatch
                    ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/60 dark:text-amber-200'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-300'
                }`}
              >
                {isGiniHigh ? 'Concentrated' : isGiniWatch ? 'Watch' : 'Healthy'}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-baseline gap-2">
            <span
              className={`text-3xl font-bold tracking-tight tabular-nums ${
                isGiniHigh
                  ? 'text-rose-700 dark:text-rose-400'
                  : isGiniWatch
                  ? 'text-amber-800 dark:text-amber-300'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {loadingAudit ? '—' : gini.toFixed(3)}
            </span>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              / 1.00 scale
            </span>
          </div>

          <div className="mt-2.5 flex items-center gap-1.5 text-xs tabular-nums">
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              Target &le; 0.48 · 0.00 = equal
            </span>
          </div>

          <p className="mt-auto border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
            Lower scores mean broader author spread.
          </p>
        </div>

        {/* Card 4: Curator Self-Vote Policy */}
        <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <h4 className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
              Curator Self-Vote Policy
            </h4>
            {!loadingAudit && (
              <span
                className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                  isCuratorVoteExcessive
                    ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/60 dark:text-rose-200'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-300'
                }`}
              >
                {isCuratorVoteExcessive ? '> 10% Alert' : 'Compliant (≤ 10%)'}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-baseline gap-2">
            <span
              className={`text-3xl font-bold tracking-tight tabular-nums ${
                isCuratorVoteExcessive
                  ? 'text-rose-700 dark:text-rose-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {loadingAudit ? '—' : `${ownTeamSelfVotePercent.toFixed(1)}%`}
            </span>
            <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">
              ({ownTeamSelfVotes}/{totalVotes}) · &le; 10% limit
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs tabular-nums">
            <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
              Own-Team: {ownTeamSelfVotes} ({ownTeamSelfVotePercent.toFixed(1)}%)
            </span>
            <span className="rounded-md bg-indigo-50 px-2 py-0.5 font-medium text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300">
              Cross-Team: {crossTeamCuratorVotes} ({crossTeamCuratorVotePercent.toFixed(1)}%)
            </span>
          </div>

          <p className="mt-auto border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
            Cap: 1 vote/day (&le; 10% VP) per team.
          </p>
        </div>
      </div>

      {/* Curation Team Shift & Self-Reward Policy Breakdown Ledger */}
      {snapshot?.teamAudits && snapshot.teamAudits.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3.5">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Scale className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>Curation Team Self-Reward &amp; Shift Compliance ({windowDays}-Day Ledger)</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Steemit policy permits on-duty curators 1 vote of 100% per 24 hours (10% VP). Solo curators receive up to 7 votes/week; 3-member teams receive 2&ndash;3 votes per member.
              </p>
            </div>
            <span className="text-[11px] text-slate-600 dark:text-slate-400 font-mono rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-0.5 dark:border-slate-800 dark:bg-slate-800/60">
              Policy Cap: &le; 10% / team
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {snapshot.teamAudits.map((audit: TeamCurationAudit) => {
              const isSolo = audit.members.length === 1;
              const maxAllowed = windowDays === 7 ? 7 : 14;
              return (
                <div
                  key={audit.teamId}
                  className={`p-3.5 rounded-xl border text-xs flex flex-col justify-between transition-colors ${
                    audit.compliant
                      ? 'border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-800/50'
                      : 'border-rose-200 bg-rose-50/70 dark:border-rose-900/60 dark:bg-rose-950/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div>
                      <span className="font-bold text-slate-900 dark:text-slate-100">
                        {audit.teamName}
                      </span>
                      <span className="font-mono text-slate-500 dark:text-slate-400 text-[11px] ml-1.5">
                        @{audit.account}
                      </span>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono border ${
                        audit.compliant
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                          : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200'
                      }`}
                    >
                      {audit.compliant ? 'Compliant' : '> 10% Alert'}
                    </span>
                  </div>

                  <div className="space-y-1 mb-2 font-mono text-[11px]">
                    <div className="flex justify-between text-slate-600 dark:text-slate-400">
                      <span>Own-Team Self-Reward:</span>
                      <strong className="text-slate-900 dark:text-slate-200 tabular-nums">
                        {audit.ownTeamSelfVotes} / {maxAllowed} ({audit.ownTeamSelfVotePercent.toFixed(1)}%)
                      </strong>
                    </div>
                    <div className="flex justify-between text-slate-600 dark:text-slate-400">
                      <span>Cross-Team Support:</span>
                      <span className="text-slate-700 dark:text-slate-300 tabular-nums">
                        {audit.crossTeamVotes} votes
                      </span>
                    </div>
                  </div>

                  <div className="border-t border-slate-200/80 pt-2 dark:border-slate-700/60 text-[11px] font-mono">
                    <span className="text-slate-500 dark:text-slate-400 block mb-1">
                      {isSolo ? 'Solo Curator Shift:' : 'Member Shift Breakdown:'}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {audit.memberVotes.map((mv: { member: string; votes: number }) => (
                        <span
                          key={mv.member}
                          className="rounded-md bg-white px-1.5 py-0.5 border border-slate-200 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                        >
                          @{mv.member}: <strong className="text-emerald-700 dark:text-emerald-400">{mv.votes}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Supported Authors Concentration Table */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3.5">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>Top Supported Accounts ({windowDays}-Day Ledger)</span>
          </h3>
          <span className="text-[11px] text-slate-600 dark:text-slate-400 font-mono rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-0.5 dark:border-slate-800 dark:bg-slate-800/60">
            Source: On-Chain {windowDays}D Ledger
          </span>
        </div>

        {loadingAudit ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
            {Array.from({ length: 10 }).map((_, idx) => (
              <div key={idx} className="h-12 rounded-xl shimmer-mask" />
            ))}
          </div>
        ) : snapshot && snapshot.topSupportedAuthors.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
            {snapshot.topSupportedAuthors.map((entry, idx) => (
              <div
                key={entry.author}
                className={`p-3 rounded-xl border text-xs flex items-center justify-between transition-colors ${
                  entry.isCurator
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-950 dark:border-indigo-800/60 dark:bg-indigo-950/40 dark:text-indigo-200'
                    : 'border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-100'
                }`}
              >
                <div className="min-w-0 pr-2">
                  <span
                    className={`font-mono font-semibold truncate block ${
                      entry.isCurator
                        ? 'text-indigo-950 dark:text-indigo-200'
                        : 'text-slate-900 dark:text-slate-200'
                    }`}
                  >
                    {idx + 1}. @{entry.author}
                  </span>
                  {entry.isCurator && (
                    <span className="text-[10px] font-mono font-bold text-indigo-700 dark:text-indigo-300">
                      Curator
                    </span>
                  )}
                </div>
                <span
                  className={`px-2 py-0.5 rounded-lg border font-mono font-bold tabular-nums shrink-0 ${
                    entry.isCurator
                      ? 'border-indigo-300 bg-indigo-100 text-indigo-900 dark:border-indigo-700/80 dark:bg-indigo-900/60 dark:text-indigo-200'
                      : 'border-slate-200 bg-white text-emerald-700 dark:border-slate-700 dark:bg-slate-900 dark:text-emerald-400'
                  }`}
                >
                  {entry.votes}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500 text-center py-6">
            No vote records found in the selected {windowDays}-day window.
          </p>
        )}
      </div>

      {/* Category Diversity & Live Rescue Radar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Category & Community Distribution */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3.5">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <PieChart className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>Category & Community Distribution</span>
            </h3>
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
                Live Feed · {totalPosts} posts
              </span>
              <span className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
                <Scale className="w-3.5 h-3.5 text-slate-500" />
                Diary Share:{' '}
                <strong
                  className={
                    diaryRatio > 30
                      ? 'text-amber-800 dark:text-amber-300'
                      : 'text-emerald-700 dark:text-emerald-300'
                  }
                >
                  {diaryRatio}%
                </strong>{' '}
                ({diaryCount}/{totalPosts})
              </span>
            </div>
          </div>

          <div className="space-y-2.5">
            {categoryEntries.map(([cat, count]) => {
              const pct = totalPosts > 0 ? Math.round((count / totalPosts) * 100) : 0;
              const resolvedLabel = communityTitleMap.get(cat) || `#${cat}`;
              return (
                <div key={cat} className="space-y-1">
                  <div className="flex justify-between text-xs font-mono">
                    <span
                      className="text-slate-700 dark:text-slate-300 font-medium truncate max-w-[220px]"
                      title={resolvedLabel}
                    >
                      {resolvedLabel}
                    </span>
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                      {count} posts ({pct}%)
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-600 dark:bg-emerald-500 rounded-full transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Priority Rescue Radar */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3.5">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-500" />
              <span>Priority Rescue Radar</span>
            </h3>
            <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-mono text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
              Live Feed · &gt;250w, &lt;$0.50
            </span>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {atRiskCreators.slice(0, 6).map((p) => (
              <div
                key={p.id}
                className="p-3 rounded-xl border border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-800/60 dark:hover:border-slate-700 flex items-center justify-between text-xs transition-colors"
              >
                <div className="flex-1 min-w-0 pr-3">
                  <span className="font-semibold text-slate-900 dark:text-white truncate block [text-wrap:balance]">
                    {p.title}
                  </span>
                  <div className="flex items-center gap-2 text-[10px] text-slate-600 dark:text-slate-400 mt-0.5 font-mono">
                    <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                      @{p.author}
                    </span>
                    <span>•</span>
                    <span className="tabular-nums">{p.wordCount} words</span>
                    <span>•</span>
                    <span className="text-emerald-700 dark:text-emerald-400 font-bold tabular-nums">
                      ${p.pendingPayout.toFixed(2)}
                    </span>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded-full border border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/60 dark:text-rose-200 text-[10px] font-bold font-mono tabular-nums shrink-0">
                  {formatRelativeSteemTime(p.created, p.ageHours)}
                </span>
              </div>
            ))}
            {atRiskCreators.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-8">
                No high-effort posts currently in jeopardy!
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
