import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  BookmarkCheck,
  Clock,
  Image as ImageIcon,
  EyeOff,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import type { PostItem, ClubStatusResult } from '../types';
import { calculateClubStatus, getCachedClubStatus } from '../lib/clubCalculator';
import {
  ALL_CURATOR_MEMBERS,
  DEFAULT_POST_FALLBACK_IMAGE,
  OPPORTUNITY_MAX_PAYOUT,
  OPPORTUNITY_MIN_WORDS,
  isLowQualityOrBotPost,
} from '../lib/constants';
import {
  extractPlainExcerpt,
  formatRelativeSteemTime,
  extractPostImages,
  formatSteemReputation,
} from '../lib/textUtils';
import { buildCleanSteemUrl } from '../lib/reportGenerator';

interface PostCardProps {
  post: PostItem;
  onInspect: (post: PostItem) => void;
  onClaim: (post: PostItem) => void;
  onQuickMentorship: (post: PostItem) => void;
  onDismiss?: (post: PostItem) => void;
  currentUser: string | null;
  isAuthorizedCurator?: boolean;
  theme?: 'dark' | 'light';
}

export const PostCard: React.FC<PostCardProps> = ({
  post,
  onInspect: _onInspect,
  onClaim,
  onQuickMentorship,
  onDismiss,
  currentUser,
  isAuthorizedCurator = false,
}) => {
  // Auto-populate immediately from 24h author cache if previously checked
  const [clubStatus, setClubStatus] = useState<ClubStatusResult | null>(
    () => post.clubStatus || getCachedClubStatus(post.author)
  );
  const [checkingClub, setCheckingClub] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setClubStatus(post.clubStatus || getCachedClubStatus(post.author));
  }, [post.author, post.clubStatus]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const fetchClubIfNeeded = async () => {
    if (checkingClub || clubStatus) return;
    setCheckingClub(true);
    const res = await calculateClubStatus(post.author);
    setClubStatus(res);
    setCheckingClub(false);
  };

  const handleMouseEnter = () => {
    if (clubStatus || checkingClub) return;
    // Debounce 250ms so fast mouse sweeps don't flood RPC nodes
    hoverTimerRef.current = window.setTimeout(() => {
      fetchClubIfNeeded();
    }, 250);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleCheckClubClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await fetchClubIfNeeded();
  };

  const isCurator = ALL_CURATOR_MEMBERS.has(post.author.toLowerCase());
  const isClaimedByMe = Boolean(
    post.claim &&
      currentUser &&
      post.claim.curator.toLowerCase() === currentUser.toLowerCase()
  );

  // Author reputation score formatted for condenser_api and bridge
  const rep = formatSteemReputation(post.authorReputation);

  // Clean plain-text excerpt with dApp boilerplate and duplicate title stripped
  const cleanExcerpt =
    post.plainExcerpt || extractPlainExcerpt(post.body, 260, post.title);
  const cleanSteemitUrl = buildCleanSteemUrl(post);
  const formattedTime = formatRelativeSteemTime(post.created, post.ageHours);

  const cashoutMs = post.cashoutTime
    ? Date.parse(post.cashoutTime.endsWith('Z') ? post.cashoutTime : `${post.cashoutTime}Z`)
    : NaN;
  const hoursToCashout = !Number.isNaN(cashoutMs)
    ? Math.max(0, (cashoutMs - Date.now()) / 3600000)
    : null;
  const isExpiringSoon = !post.curatorVoted && hoursToCashout !== null && hoursToCashout <= 72;

  // Extract all candidate images (uses pre-parsed array from post if available)
  const images = useMemo(
    () => (post.images && post.images.length > 0 ? post.images : extractPostImages(post)),
    [post]
  );
  const hasAuthorImages = images.length > 0;
  const [imgIndex, setImgIndex] = useState(0);
  const [isFallbackActive, setIsFallbackActive] = useState(!hasAuthorImages);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setImgIndex(0);
    setIsFallbackActive(!hasAuthorImages);
    setIsLoaded(false);
  }, [post.author, post.permlink, hasAuthorImages]);

  useEffect(() => {
    const el = coverRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Guard against hanging external image hosts once the card is visible
  useEffect(() => {
    if (!isInView || isLoaded || isFallbackActive) return;
    const timer = window.setTimeout(() => {
      if (imgIndex < images.length - 1) {
        setImgIndex((prev) => prev + 1);
      } else {
        setIsFallbackActive(true);
      }
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [isInView, isLoaded, isFallbackActive, imgIndex, images.length]);

  const activeImageUrl = useMemo(() => {
    if (isFallbackActive || !hasAuthorImages || imgIndex >= images.length) {
      return DEFAULT_POST_FALLBACK_IMAGE;
    }
    return images[imgIndex];
  }, [isFallbackActive, hasAuthorImages, imgIndex, images]);

  // Human-readable community name with fallback to #category
  const communityLabel = post.communityTitle || `#${post.category}`;

  // Spam, bot, or AI check
  const isBotOrSpam = isLowQualityOrBotPost(post);

  // Accurate curation signals
  const isShortContent = post.wordCount < OPPORTUNITY_MIN_WORDS;
  const isTrueOpportunity =
    !isBotOrSpam &&
    !post.curatorVoted &&
    post.pendingPayout < OPPORTUNITY_MAX_PAYOUT &&
    !isShortContent;
  const isOrganicallyFunded =
    !isBotOrSpam &&
    !post.curatorVoted &&
    post.pendingPayout >= OPPORTUNITY_MAX_PAYOUT;
  const zone1ShowsExpiry =
    !isBotOrSpam &&
    post.claim?.status !== 'needs_revision' &&
    post.claim?.status !== 'approved' &&
    isExpiringSoon;

  return (
    <article
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-slate-200/90 bg-white transition-all duration-150 hover:border-slate-300 hover:shadow-md focus-within:ring-2 focus-within:ring-emerald-600 focus-within:ring-offset-2 focus-within:ring-offset-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:focus-within:ring-emerald-400 dark:focus-within:ring-offset-slate-950"
    >
      {/* Cover Image Slot — Uniform height across all cards */}
      <div
        ref={coverRef}
        role="button"
        tabIndex={0}
        onClick={() => _onInspect(post)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            _onInspect(post);
          }
        }}
        title="Inspect post in Curation Hub"
        className="relative h-44 w-full shrink-0 overflow-hidden bg-slate-100 dark:bg-slate-800 cursor-pointer"
      >
        {!isLoaded && (
          <div className="absolute inset-0 bg-slate-200/60 dark:bg-slate-800/60 animate-pulse" />
        )}
        <img
          key={activeImageUrl}
          src={activeImageUrl}
          alt={post.title}
          loading="lazy"
          decoding="async"
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            // Skip tiny divider lines, tracking pixels, or corrupt 0-byte images
            if (
              !isFallbackActive &&
              (naturalWidth === 0 ||
                naturalHeight < 16 ||
                (naturalWidth < 32 && naturalHeight < 32))
            ) {
              if (imgIndex < images.length - 1) {
                setImgIndex((prev) => prev + 1);
              } else {
                setIsFallbackActive(true);
                e.currentTarget.src = DEFAULT_POST_FALLBACK_IMAGE;
              }
              return;
            }
            setIsLoaded(true);
          }}
          onError={(e) => {
            if (isFallbackActive) return;
            // Advance to next candidate if available, else switch to guaranteed mascot fallback
            if (imgIndex < images.length - 1) {
              setImgIndex((prev) => prev + 1);
            } else {
              setIsFallbackActive(true);
              e.currentTarget.src = DEFAULT_POST_FALLBACK_IMAGE;
            }
          }}
          className={`h-full w-full object-cover transition-all duration-300 group-hover:scale-[1.03] ${
            isLoaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
        {!isFallbackActive && images.length > 1 && (
          <span className="absolute right-2.5 bottom-2.5 rounded-md bg-slate-950/75 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur-xs">
            {images.length} photos
          </span>
        )}
      </div>

      {/* Card Body */}
      <div className="flex flex-1 flex-col p-4">
        {/* Zone 1: Overline — Community + Curation Tags + Status Cue */}
        <div className="mb-1.5 flex items-center justify-between gap-2 text-xs min-w-0">
          <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
            <span
              className="truncate min-w-[60px] font-medium text-slate-500 dark:text-slate-400"
              title={`#${post.category}`}
            >
              {communityLabel}
            </span>
            {post.isBurnSteem25 && (
              <span
                title="burnsteem25 verified (25% null beneficiary)"
                className="shrink-0 rounded bg-orange-50 px-1 py-0.2 text-[10px] font-semibold text-orange-700 dark:bg-orange-950/60 dark:text-orange-300"
              >
                🔥 25% Burn
              </span>
            )}
            {post.isSteemExclusive && (
              <span
                title="steemexclusive tagged"
                className="shrink-0 rounded bg-emerald-50 px-1 py-0.2 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
              >
                ⭐ Exclusive
              </span>
            )}
            {post.isVideoPost && (
              <span
                title="Video embed post"
                className="shrink-0 rounded bg-sky-50 px-1 py-0.2 text-[10px] font-semibold text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"
              >
                ▶ Video
              </span>
            )}
            {!hasAuthorImages && (
              <span
                title="Text-only post (no images included in source)"
                className="shrink-0 rounded bg-slate-100 px-1 py-0.2 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-400"
              >
                Text-Only
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {post.claim?.status === 'needs_revision' ? (
              <span
                title="Awaiting creator revisions based on curator guidance"
                className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900 dark:border-amber-800/80 dark:bg-amber-950/70 dark:text-amber-200 flex items-center gap-1"
              >
                <AlertTriangle className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                <span>Needs Revision</span>
              </span>
            ) : post.claim?.status === 'approved' ? (
              <span
                title="Approved for team curation queue"
                className="shrink-0 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-900 dark:border-emerald-800/80 dark:bg-emerald-950/70 dark:text-emerald-200 flex items-center gap-1"
              >
                <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                <span>Approved</span>
              </span>
            ) : isBotOrSpam ? (
              <span className="shrink-0 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                Automated / Bot
              </span>
            ) : isExpiringSoon ? (
              <span
                title={`Cashout closes in ${hoursToCashout?.toFixed(1)} hours`}
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold border flex items-center gap-1 tabular-nums ${
                  hoursToCashout !== null && hoursToCashout <= 24
                    ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/70 dark:bg-rose-950/70 dark:text-rose-200'
                    : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/70 dark:text-amber-200'
                }`}
              >
                <Clock className="w-3 h-3" />
                <span>Expires in {hoursToCashout !== null ? Math.round(hoursToCashout) : '?'}h</span>
              </span>
            ) : isTrueOpportunity ? (
              <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300">
                Opportunity
              </span>
            ) : post.curatorVoted ? (
              <span
                title={`Voted by: ${post.curatorAccountsVoted.join(', ')}`}
                className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 truncate max-w-[130px]"
              >
                Voted · {post.curatorAccountsVoted[0] || 'Curator'}
              </span>
            ) : isOrganicallyFunded ? (
              <span
                title="Organically funded (≥ $1.50)"
                className="shrink-0 text-[11px] font-medium text-slate-500 dark:text-slate-400"
              >
                Funded
              </span>
            ) : null}

            {onDismiss && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDismiss(post);
                }}
                title="Dismiss post from view"
                className="relative z-10 p-0.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors dark:text-slate-500 dark:hover:text-slate-300 dark:hover:bg-slate-800"
              >
                <EyeOff className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Zone 2: Headline & Excerpt */}
        <div className="relative z-10 mb-1.5 flex items-start justify-between gap-1.5">
          <h3 className="text-[15px] font-bold leading-snug text-slate-900 dark:text-slate-100 [text-wrap:balance] flex-1">
            <button
              type="button"
              onClick={() => _onInspect(post)}
              title="Inspect post in Curation Hub"
              className="text-left line-clamp-2 transition-colors hover:text-emerald-700 focus:outline-none cursor-pointer dark:hover:text-emerald-400 font-bold"
            >
              {post.title}
            </button>
          </h3>
          <a
            href={cleanSteemitUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open original post on Steemit in a new tab"
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors shrink-0 dark:text-slate-500 dark:hover:text-slate-200 dark:hover:bg-slate-800"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        <p className="mb-3 line-clamp-2 text-[13px] leading-relaxed text-slate-600 dark:text-slate-400">
          {cleanExcerpt || 'No text preview available.'}
        </p>

        {/* Zone 3: Calm Author Byline (Full handle + Reputation + Curator + Time) */}
        <div className="relative z-10 mb-3 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 min-w-0">
          <a
            href={`https://steemit.com/@${post.author}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="truncate font-semibold text-slate-800 hover:text-emerald-700 hover:underline dark:text-slate-200 dark:hover:text-emerald-400"
          >
            @{post.author}
          </a>
          <span
            title={`Author Reputation: ${rep}`}
            className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            {rep}
          </span>
          {isCurator && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 font-medium text-indigo-600 dark:text-indigo-400">
                Curator
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">{formattedTime}</span>
          {isExpiringSoon && !zone1ShowsExpiry && (
            <>
              <span aria-hidden="true">·</span>
              <span
                className={`shrink-0 tabular-nums font-semibold ${
                  hoursToCashout !== null && hoursToCashout <= 24
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                Expires in {hoursToCashout !== null ? Math.round(hoursToCashout) : '?'}h
              </span>
            </>
          )}
        </div>

        {/* Zone 4: Unified Footer (Borderless Metrics + Soft Primary / Ghost Secondary CTA) */}
        <div className="mt-auto space-y-2.5 border-t border-slate-100 pt-3 dark:border-slate-800">
          {/* Row 1: Metrics & Borderless Club Status */}
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                ${post.pendingPayout.toFixed(2)}
              </span>
              <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                ·
              </span>
              <span
                className={
                  isShortContent
                    ? 'font-medium text-amber-700 dark:text-amber-400'
                    : 'text-slate-600 dark:text-slate-400'
                }
              >
                {isShortContent ? `Short · ${post.wordCount}w` : `${post.wordCount}w`}
              </span>
              <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                ·
              </span>
              <span
                title={`${post.totalVotes} votes, ${post.commentCount} comments`}
                className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]"
              >
                <span title={`${post.commentCount} comments`}>💬 {post.commentCount}</span>
                <span title={`${post.totalVotes} votes`}>👍 {post.totalVotes}</span>
              </span>
              {post.totalVotes <= 1 && post.pendingPayout >= 5.0 && (
                <span
                  title="Whale or self-vote ($5+ STU with 1 vote)"
                  className="rounded bg-rose-50 px-1 py-0.2 text-[10px] font-bold text-rose-700 border border-rose-200 dark:bg-rose-950/60 dark:border-rose-900/60 dark:text-rose-300"
                >
                  Whale 1-Vote
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={handleCheckClubClick}
              disabled={checkingClub}
              title={
                clubStatus
                  ? `Powered up: ${clubStatus.poweredUp} STEEM (${clubStatus.ratio}%) in last ${clubStatus.periodDays}d - Click to refresh`
                  : 'Check author club status'
              }
              className="relative z-10 shrink-0 inline-flex items-center gap-1.5 font-medium text-slate-700 transition-colors hover:text-slate-950 dark:text-slate-300 dark:hover:text-white"
            >
              {checkingClub ? (
                <span className="text-slate-400 animate-pulse text-[11px]">Checking…</span>
              ) : clubStatus ? (
                <>
                  <span
                    className={`h-2 w-2 rounded-full ${
                      clubStatus.tier === 'Club100'
                        ? 'bg-emerald-500'
                        : clubStatus.tier === 'Club75'
                        ? 'bg-teal-500'
                        : clubStatus.tier === 'Club5050'
                        ? 'bg-amber-500'
                        : 'bg-rose-500'
                    }`}
                  />
                  <span>{clubStatus.tier}</span>
                </>
              ) : (
                <span className="text-slate-500 underline-offset-2 hover:underline dark:text-slate-400">
                  Check Club
                </span>
              )}
            </button>
          </div>

          {/* Row 2: Soft Primary CTA + Borderless Ghost Secondary CTA */}
          <div className="relative z-10 flex items-center gap-2">
            {isAuthorizedCurator ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClaim(post);
                }}
                title={
                  post.claim
                    ? 'Manage active review lock'
                    : 'Lock 45-min exclusive curation window for your team'
                }
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                  post.claim
                    ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                    : post.curatorVoted
                    ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                    : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-700 hover:text-white dark:bg-emerald-950/60 dark:text-emerald-300 dark:hover:bg-emerald-500 dark:hover:text-slate-950'
                }`}
              >
                {post.claim ? (
                  <>
                    <BookmarkCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>
                      {post.claim.status === 'needs_revision'
                        ? 'Guidance Active'
                        : post.claim.status === 'approved'
                        ? 'Approved'
                        : isClaimedByMe
                        ? 'Manage (You)'
                        : `@${post.claim.curator}`}
                    </span>
                  </>
                ) : post.curatorVoted ? (
                  <span>Claim Anyway</span>
                ) : (
                  <span>Claim Post</span>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  _onInspect(post);
                }}
                title="Inspect post in Observer Mode"
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {post.claim ? (
                  <>
                    <BookmarkCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>@{post.claim.curator} (Locked)</span>
                  </>
                ) : (
                  <span>Inspect</span>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (isAuthorizedCurator) {
                  onQuickMentorship(post);
                } else {
                  _onInspect(post);
                }
              }}
              title={
                isAuthorizedCurator
                  ? 'Open creator revision guidance modal'
                  : 'View post details'
              }
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 cursor-pointer"
            >
              {isAuthorizedCurator ? 'Guide' : 'View'}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};
