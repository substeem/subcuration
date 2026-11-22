import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Send,
  ThumbsUp,
  Lock,
  Unlock,
  ExternalLink,
  ShieldAlert,
  MessageCircle,
  FileText,
  Code,
  LogIn,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { PostItem, ClubStatusResult, CurationClaim } from '../types';
import { calculateClubStatus } from '../lib/clubCalculator';
import { REVISION_REASONS, buildGuidanceComment } from '../lib/mentorshipTemplates';
import {
  broadcastCustomJson,
  executeVote,
  publishGuidanceComment,
  loginWithKeychain,
} from '../lib/keychain';
import { ALL_CURATOR_MEMBERS, SUBSTEEM_PROTOCOL_ID } from '../lib/constants';
import { saveLocalClaim } from '../lib/steem';
import { buildCleanSteemUrl } from '../lib/reportGenerator';
import {
  formatRelativeSteemTime,
  formatSteemReputation,
} from '../lib/textUtils';

const steemSanitizeSchema = {
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
    div: [...(defaultSchema.attributes?.div ?? []), 'className', 'class', 'align'],
    p: [...(defaultSchema.attributes?.p ?? []), 'className', 'class', 'align'],
    center: ['className', 'class'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'className', 'class'],
    a: ['href', 'title', 'target', 'rel', 'className', 'class'],
    iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align', 'valign'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align', 'valign'],
  },
};

function normalizeSteemBody(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/\r\n/g, '\n')
    // Collapse 3+ consecutive newlines so raw Steem spacing doesn't create empty voids
    .replace(/\n{3,}/g, '\n\n')
    // Convert bare image URL inside <center>...</center> into HTML images
    .replace(
      /<center>\s*(https?:\/\/[^\s<>]+\.(?:jpe?g|png|gif|webp|avif)(?:\?[^\s<>]*)?)\s*<\/center>/gi,
      '<center><img src="$1" /></center>'
    )
    .replace(
      /<center>\s*(https?:\/\/(?:cdn\.steemitimages\.com|steemitimages\.com|images\.hive\.blog|images\.ecency\.com)\/[^\s<>]+)\s*<\/center>/gi,
      '<center><img src="$1" /></center>'
    )
    // Convert bare standalone image URLs on their own line into Markdown images
    .replace(
      /^(https?:\/\/\S+\.(?:jpe?g|png|gif|webp|avif))(?:\?\S*)?$/gim,
      '![]($1)'
    )
    // Convert bare Steem/Hive CDN image URLs on their own line into Markdown images
    .replace(
      /^(https?:\/\/(?:cdn\.steemitimages\.com|steemitimages\.com|images\.hive\.blog|images\.ecency\.com)\/\S+)$/gim,
      '![]($1)'
    )
    .trim();
}

// -------------------- Error Boundary for Resilience --------------------
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught unhandled render error:', error, errorInfo);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error || new Error('Unknown error'), this.reset);
      }
      return (
        <div className="p-4 text-center rounded-xl border border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
          <p className="text-xs font-semibold mb-1">Failed to render this component.</p>
          <pre className="text-[11px] font-mono text-slate-600 dark:text-slate-400 max-h-24 overflow-auto">
            {this.state.error?.message}
          </pre>
          <button
            onClick={this.reset}
            className="mt-2 px-3 py-1 bg-emerald-700 text-white rounded text-xs font-semibold hover:bg-emerald-800"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function SteemPostBody({ body }: { body?: string }) {
  const safeBody = body || '';
  const cleaned = useMemo(() => normalizeSteemBody(safeBody), [safeBody]);

  if (!cleaned) {
    return (
      <div className="py-12 text-center text-xs text-slate-400 italic">
        No post body content available.
      </div>
    );
  }

  return (
    <ErrorBoundary
      fallback={(err) => (
        <div className="space-y-3">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-300">
            <strong>Formatting Notice:</strong> Complex HTML/markdown could not be fully rendered ({err.message}). Displaying raw post source below.
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 whitespace-pre-wrap select-text dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200 break-words">
            {safeBody}
          </div>
        </div>
      )}
    >
      <div className="prose prose-sm prose-slate max-w-none dark:prose-invert prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-slate-900 dark:prose-headings:text-slate-100 prose-p:leading-relaxed prose-p:text-slate-700 dark:prose-p:text-slate-300 prose-img:mx-auto prose-img:rounded-xl prose-img:border prose-img:border-slate-200 dark:prose-img:border-slate-800 prose-a:text-emerald-700 dark:prose-a:text-emerald-400 prose-a:underline hover:prose-a:opacity-80 prose-blockquote:border-l-emerald-600 prose-blockquote:text-slate-600 dark:prose-blockquote:text-slate-400 prose-code:text-emerald-700 dark:prose-code:text-emerald-300 break-words">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, steemSanitizeSchema]]}
          components={{
            img: ({ src = '', alt = '' }) => {
              return (
                <img
                  src={src}
                  alt={alt}
                  loading="lazy"
                  decoding="async"
                  onClick={() => {
                    if (src) window.open(src, '_blank', 'noopener,noreferrer');
                  }}
                  title="Click to view full-resolution image in new tab"
                  className="max-h-[500px] w-auto max-w-full rounded-xl object-contain my-3 mx-auto shadow-xs cursor-zoom-in hover:opacity-95 transition-opacity"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              );
            },
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
              >
                {children}
              </a>
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
          {cleaned}
        </ReactMarkdown>
      </div>
    </ErrorBoundary>
  );
}

export interface PostModalProps {
  post: PostItem | null;
  onClose: () => void;
  currentUser: string | null;
  teamAccount: string;
  teamName: string;
  onClaimUpdated: (post: PostItem, claim: CurationClaim | null) => void;
  initialShowRevision?: boolean;
  theme?: 'dark' | 'light';
  isAuthorizedCurator?: boolean;
  onLogin?: (username: string) => void;
  onConnectKeychain?: () => void;
}

export const PostModal: React.FC<PostModalProps> = (props) => {
  if (!props.post) return null;
  return (
    <ErrorBoundary
      onReset={props.onClose}
      fallback={(err, reset) => (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs animate-in fade-in duration-150"
        >
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-bold text-rose-600 mb-2">Error Loading Post Inspector</h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 mb-3">
              An unexpected error occurred while displaying post @{props.post?.author}/{props.post?.permlink}:
            </p>
            <div className="text-xs font-mono p-3 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg mb-4 overflow-auto max-h-32">
              {err.message}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={props.onClose}
                className="px-3.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                onClick={reset}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
    >
      <PostModalContent
        key={`${props.post.author || 'author'}/${props.post.permlink || 'post'}`}
        {...props}
        post={props.post}
      />
    </ErrorBoundary>
  );
};

type PostModalContentProps = Omit<PostModalProps, 'post'> & { post: PostItem };

const PostModalContent: React.FC<PostModalContentProps> = ({
  post,
  onClose,
  currentUser,
  teamAccount,
  teamName,
  onClaimUpdated,
  initialShowRevision = false,
  isAuthorizedCurator = false,
  onLogin,
  onConnectKeychain,
}) => {
  const isSignedIn = Boolean(currentUser);
  const isReadOnly = !isAuthorizedCurator || !teamAccount || !currentUser;
  const authorClean = (post?.author || '').toLowerCase();
  const isFellowCurator = authorClean ? ALL_CURATOR_MEMBERS.has(authorClean) : false;

  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered');
  const [clubStatus, setClubStatus] = useState<ClubStatusResult | null>(
    post.clubStatus || null
  );
  const [loadingClub, setLoadingClub] = useState(!post.clubStatus);

  // Revision Form state
  const [showRevisionForm, setShowRevisionForm] = useState(initialShowRevision);
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);
  const [customNotes, setCustomNotes] = useState('');
  const [submittingRevision, setSubmittingRevision] = useState(false);

  // Approval / Voting state
  const [voteWeight, setVoteWeight] = useState(50);
  const [qualityScore, setQualityScore] = useState(85);
  const [broadcastingVote, setBroadcastingVote] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    type: 'success' | 'error';
  } | null>(null);

  // Inline Keychain login state
  const [showInlineLogin, setShowInlineLogin] = useState(false);
  const [inlineUsername, setInlineUsername] = useState('');
  const [verifyingLogin, setVerifyingLogin] = useState(false);
  const [inlineLoginError, setInlineLoginError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    if (post?.author && !post.clubStatus) {
      setLoadingClub(true);
      calculateClubStatus(post.author)
        .then((res) => {
          if (active) {
            setClubStatus(res);
            setLoadingClub(false);
          }
        })
        .catch(() => {
          if (active) setLoadingClub(false);
        });
    } else {
      setLoadingClub(false);
    }
    return () => {
      active = false;
    };
  }, [post?.author, post?.clubStatus]);

  const toggleReason = (id: string) => {
    setSelectedReasons((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
    );
  };

  const handleInlineLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = inlineUsername.trim().toLowerCase().replace(/^@/, '');
    if (!clean) return;

    setVerifyingLogin(true);
    setInlineLoginError(null);
    const res = await loginWithKeychain(clean);
    setVerifyingLogin(false);

    if (res.success) {
      if (onLogin) onLogin(clean);
      setShowInlineLogin(false);
      setStatusMessage({
        text: `Connected as @${clean} via Keychain!`,
        type: 'success',
      });
    } else {
      setInlineLoginError(res.error || 'Keychain verification failed.');
    }
  };

  // 1. Claim or Release Post via on-chain custom_json
  const handleToggleClaim = useCallback(async () => {
    if (isReadOnly || !currentUser) {
      setStatusMessage({
        text: 'Curator role required: sign in with an official curator account to lock or claim posts.',
        type: 'error',
      });
      return;
    }

    if (post.claim) {
      const res = await broadcastCustomJson(currentUser, SUBSTEEM_PROTOCOL_ID, {
        action: 'release',
        author: post.author,
        permlink: post.permlink,
        team: teamName,
        curator: currentUser,
        timestamp: Date.now(),
      });
      if (res.success) {
        saveLocalClaim(null, post.author, post.permlink);
        onClaimUpdated(post, null);
        setStatusMessage({ text: 'Claim released successfully.', type: 'success' });
      } else {
        setStatusMessage({ text: res.error || 'Failed to release claim.', type: 'error' });
      }
    } else {
      const now = Date.now();
      const expiresAt = now + 45 * 60 * 1000;
      const res = await broadcastCustomJson(currentUser, SUBSTEEM_PROTOCOL_ID, {
        action: 'claim',
        author: post.author,
        permlink: post.permlink,
        team: teamName,
        account: teamAccount,
        curator: currentUser,
        timestamp: now,
        expires_at: expiresAt,
      });

      if (res.success) {
        const newClaim: CurationClaim = {
          id: `${post.author}/${post.permlink}`,
          author: post.author,
          permlink: post.permlink,
          team: teamName,
          account: teamAccount,
          curator: currentUser,
          timestamp: now,
          expiresAt,
          status: 'claimed',
        };
        saveLocalClaim(newClaim, post.author, post.permlink);
        onClaimUpdated(post, newClaim);
        setStatusMessage({
          text: `Post claimed! You hold a 45-minute exclusive lock.${
            res.txId ? ` (tx: ${res.txId.slice(0, 8)})` : ''
          }`,
          type: 'success',
        });
      } else {
        setStatusMessage({ text: res.error || 'Claim failed.', type: 'error' });
      }
    }
  }, [isReadOnly, currentUser, post, teamName, teamAccount, onClaimUpdated]);

  // 2. Publish Creator Guidance Comment & Log Needs Revision
  const handleSubmitRevision = async () => {
    if (isReadOnly || !currentUser) {
      setStatusMessage({
        text: 'Curator role required: sign in with an official curator account to request revisions.',
        type: 'error',
      });
      return;
    }
    if (selectedReasons.length === 0) {
      setStatusMessage({ text: 'Please select at least one guidance reason.', type: 'error' });
      return;
    }

    setSubmittingRevision(true);
    const commentBody = buildGuidanceComment(
      currentUser,
      teamName,
      selectedReasons,
      customNotes
    );

    const commentRes = await publishGuidanceComment(
      currentUser,
      post.author,
      post.permlink,
      commentBody
    );
    if (!commentRes.success) {
      setStatusMessage({
        text: commentRes.error || 'Failed to post guidance comment.',
        type: 'error',
      });
      setSubmittingRevision(false);
      return;
    }

    await broadcastCustomJson(currentUser, SUBSTEEM_PROTOCOL_ID, {
      action: 'needs_revision',
      author: post.author,
      permlink: post.permlink,
      team: teamName,
      curator: currentUser,
      reasons: selectedReasons,
      notes: customNotes,
      comment_permlink: commentRes.permlink,
      timestamp: Date.now(),
    });

    const updatedClaim: CurationClaim = {
      id: `${post.author}/${post.permlink}`,
      author: post.author,
      permlink: post.permlink,
      team: teamName,
      account: teamAccount,
      curator: currentUser,
      timestamp: Date.now(),
      expiresAt: Date.now() + 48 * 3600 * 1000,
      status: 'needs_revision',
      reasons: selectedReasons,
      notes: customNotes,
      guidanceCommentPermlink: commentRes.permlink,
    };

    saveLocalClaim(updatedClaim, post.author, post.permlink);
    onClaimUpdated(post, updatedClaim);
    setSubmittingRevision(false);
    setShowRevisionForm(false);
    setStatusMessage({
      text: `Guidance comment published! Author granted 48h to revise.${
        commentRes.txId ? ` (tx: ${commentRes.txId.slice(0, 8)})` : ''
      }`,
      type: 'success',
    });
  };

  // 3. Approve for Team Vote Queue
  const handleApproveQueue = async () => {
    if (isReadOnly || !currentUser) {
      setStatusMessage({
        text: 'Curator role required: sign in with an official curator account to approve posts.',
        type: 'error',
      });
      return;
    }

    const res = await broadcastCustomJson(currentUser, SUBSTEEM_PROTOCOL_ID, {
      action: 'approve',
      author: post.author,
      permlink: post.permlink,
      team: teamName,
      account: teamAccount,
      curator: currentUser,
      suggested_weight: voteWeight * 100,
      quality_score: qualityScore,
      timestamp: Date.now(),
    });

    if (res.success) {
      const approvedClaim: CurationClaim = {
        id: `${post.author}/${post.permlink}`,
        author: post.author,
        permlink: post.permlink,
        team: teamName,
        account: teamAccount,
        curator: currentUser,
        timestamp: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        status: 'approved',
        qualityScore,
        suggestedWeight: voteWeight * 100,
        reasons: post.claim?.reasons,
        notes: post.claim?.notes,
        guidanceCommentPermlink: post.claim?.guidanceCommentPermlink,
      };
      saveLocalClaim(approvedClaim, post.author, post.permlink);
      onClaimUpdated(post, approvedClaim);
      setStatusMessage({
        text: `Approved at ${qualityScore}% quality score and added to ${teamName} queue!`,
        type: 'success',
      });
    } else {
      setStatusMessage({ text: res.error || 'Approval failed.', type: 'error' });
    }
  };

  // 4. Direct vote
  const handleDirectVote = async () => {
    if (isReadOnly) {
      setStatusMessage({
        text: 'Read-only mode: only assigned curator teams can cast votes.',
        type: 'error',
      });
      return;
    }

    setBroadcastingVote(true);
    const res = await executeVote(teamAccount, post.author, post.permlink, voteWeight * 100);
    setBroadcastingVote(false);

    if (res.success) {
      setStatusMessage({
        text: `Vote of ${voteWeight}% broadcasted from @${teamAccount}!${
          res.txId ? ` (tx: ${res.txId.slice(0, 8)})` : ''
        }`,
        type: 'success',
      });
    } else {
      setStatusMessage({ text: res.error || 'Vote cancelled or failed.', type: 'error' });
    }
  };

  const cleanSteemitUrl = buildCleanSteemUrl(post);
  const repScore = formatSteemReputation(post.authorReputation);
  const relativeTime = formatRelativeSteemTime(post.created, post.ageHours);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 sm:p-4 backdrop-blur-xs animate-in fade-in duration-150"
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900 transition-colors">
        {/* Sticky Header */}
        <header className="sticky top-0 z-20 flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50/95 px-5 py-3.5 sm:px-6 sm:py-4 backdrop-blur-xs dark:border-slate-800 dark:bg-slate-900/95">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <a
                href={`https://steemit.com/@${post.author}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
              >
                @{post.author}
              </a>
              <span className="rounded bg-slate-200/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {repScore}
              </span>
              <span aria-hidden="true" className="text-slate-400">·</span>
              <span className="font-medium text-slate-700 dark:text-slate-300 truncate max-w-[200px]" title={post.communityTitle || `#${post.category}`}>
                {post.communityTitle || `#${post.category}`}
              </span>
              <span aria-hidden="true" className="text-slate-400">·</span>
              <span className="tabular-nums flex items-center gap-1 font-mono text-slate-600 dark:text-slate-400">
                <Clock className="w-3 h-3 text-slate-400" />
                {relativeTime}
              </span>
              <span aria-hidden="true" className="text-slate-400">·</span>
              <span className="tabular-nums flex items-center gap-1 font-mono text-slate-600 dark:text-slate-400">
                <MessageCircle className="w-3 h-3 text-slate-400" />
                {post.commentCount ?? 0}
              </span>
              {isFellowCurator && (
                <>
                  <span aria-hidden="true" className="text-slate-400">·</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-semibold font-mono dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800/60">
                    <ShieldAlert className="w-3 h-3" />
                    Curator
                  </span>
                </>
              )}
            </div>
            <h2 className="text-base sm:text-lg font-bold leading-snug text-slate-900 dark:text-slate-100 [text-wrap:balance] line-clamp-2">
              {post.title}
            </h2>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* View Mode Toggle (Rendered vs Raw) */}
            <div className="inline-flex rounded-lg bg-slate-200/80 p-0.5 text-[11px] font-mono dark:bg-slate-800 dark:border dark:border-slate-700">
              <button
                type="button"
                onClick={() => setViewMode('rendered')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                  viewMode === 'rendered'
                    ? 'bg-white text-emerald-800 font-bold shadow-xs dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
                title="Show formatted Markdown & images"
              >
                <FileText className="w-3 h-3" />
                <span className="hidden sm:inline">Rendered</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('raw')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                  viewMode === 'raw'
                    ? 'bg-white text-emerald-800 font-bold shadow-xs dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
                title="Inspect raw Markdown source, links & tags"
              >
                <Code className="w-3 h-3" />
                <span className="hidden sm:inline">Raw</span>
              </button>
            </div>

            {/* External Post Link */}
            <a
              href={cleanSteemitUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open original post on Steemit"
              className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 dark:hover:text-white"
            >
              <span>Open</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close modal"
              className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Status Alert Banner */}
        {statusMessage && (
          <div
            className={`px-6 py-2.5 text-xs font-semibold flex items-center justify-between ${
              statusMessage.type === 'success'
                ? 'bg-emerald-50 text-emerald-900 border-b border-emerald-200 dark:bg-emerald-950/90 dark:text-emerald-200 dark:border-emerald-800/70'
                : 'bg-rose-50 text-rose-900 border-b border-rose-200 dark:bg-rose-950/90 dark:text-rose-200 dark:border-rose-800/70'
            }`}
          >
            <span>{statusMessage.text}</span>
            <button
              onClick={() => setStatusMessage(null)}
              className="underline ml-4 hover:opacity-80 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Fellow Curator Policy Guardrail */}
        {isFellowCurator && (
          <div className="px-6 py-2.5 bg-indigo-50 border-b border-indigo-200 text-xs text-indigo-900 flex items-center gap-2 dark:bg-indigo-950/70 dark:border-indigo-800/60 dark:text-indigo-200">
            <ShieldAlert className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span>
              <strong>Steemit Team Policy:</strong> @{post.author} is an active Community Curator. Keep all curator-to-curator votes under the 10% cap and avoid nominating fellow curators for Weekly Top 7 picks.
            </span>
          </div>
        )}

        {/* Compact Theme-Aware Metrics Strip */}
        <section className="grid grid-cols-1 gap-3 border-b border-slate-200 bg-white px-5 py-3 sm:px-6 sm:py-3.5 sm:grid-cols-3 dark:border-slate-800 dark:bg-slate-900">
          {/* Club Eligibility */}
          <div className="rounded-lg border border-slate-200/80 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/50">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Club Eligibility
            </div>
            {loadingClub ? (
              <div className="mt-1 text-xs text-slate-500 font-mono">Auditing ledger...</div>
            ) : clubStatus ? (
              <>
                <div
                  className={`mt-1 flex items-center gap-1.5 text-xs font-semibold tabular-nums ${
                    clubStatus.tier === 'Club100'
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : clubStatus.tier === 'Club75'
                      ? 'text-sky-700 dark:text-sky-300'
                      : clubStatus.tier === 'Club5050'
                      ? 'text-amber-800 dark:text-amber-300'
                      : 'text-rose-700 dark:text-rose-300'
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      clubStatus.tier === 'Club100'
                        ? 'bg-emerald-500'
                        : clubStatus.tier === 'Club75'
                        ? 'bg-sky-500'
                        : clubStatus.tier === 'Club5050'
                        ? 'bg-amber-500'
                        : 'bg-rose-500'
                    }`}
                  />
                  {clubStatus.tier} ({clubStatus.ratio}%)
                </div>
                <div className="mt-0.5 text-[11px] tabular-nums text-slate-600 dark:text-slate-400 font-mono">
                  Powered: {clubStatus.poweredUp} · Out: {clubStatus.transferredOut} STEEM
                </div>
              </>
            ) : (
              <div className="mt-1 text-xs text-slate-500 font-mono">Unverified</div>
            )}
          </div>

          {/* Content Metrics */}
          <div className="rounded-lg border border-slate-200/80 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/50">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Content Metrics
            </div>
            <div className="mt-1 text-xs font-semibold tabular-nums text-slate-900 dark:text-slate-100 font-mono">
              <span className="text-emerald-700 dark:text-emerald-400 font-bold">
                ${(post.pendingPayout ?? 0).toFixed(2)} STU
              </span>{' '}
              · {post.wordCount ?? 0}w · {post.imageCount ?? 0} imgs
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums text-slate-600 dark:text-slate-400 font-mono">
              {post.totalVotes ?? 0} votes ({post.curationVotesCount ?? 0} curator) ·{' '}
              {post.commentCount ?? 0} comments
            </div>
          </div>

          {/* Review Status */}
          <div className="rounded-lg border border-slate-200/80 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/50">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Review Status
            </div>
            {post.claim ? (
              <div
                className={`mt-1 flex items-center gap-1.5 text-xs font-semibold font-mono ${
                  post.claim.status === 'needs_revision'
                    ? 'text-amber-800 dark:text-amber-300'
                    : post.claim.status === 'approved'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-indigo-800 dark:text-indigo-300'
                }`}
              >
                {post.claim.status === 'needs_revision' ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                ) : post.claim.status === 'approved' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Lock className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                )}
                <span>
                  {post.claim.status === 'needs_revision'
                    ? `Awaiting Revisions (@${post.claim.curator})`
                    : post.claim.status === 'approved'
                    ? `Approved (@${post.claim.curator})`
                    : `Claimed by @${post.claim.curator}`}
                </span>
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                <Unlock className="w-3.5 h-3.5" />
                <span>Open for Review</span>
              </div>
            )}
            <div className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">
              {!isReadOnly
                ? post.claim
                  ? post.claim.status === 'needs_revision'
                    ? '48h creator window active · Guidance published'
                    : post.claim.status === 'approved'
                    ? 'Ready in team queue for curation vote'
                    : '45m lock active'
                  : 'Ready to claim'
                : 'Observer Mode (Read-Only)'}
            </div>
          </div>
        </section>

        {/* Scrollable Rendered Post Body with generous padding */}
        <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5 bg-white dark:bg-slate-900">
          {/* Active Guidance Summary Card */}
          {post.claim?.status === 'needs_revision' && !showRevisionForm && (
            <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800/70 dark:bg-amber-950/40">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <h4 className="text-xs font-bold text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span>Awaiting Creator Revision (Guidance Sent by @{post.claim.curator})</span>
                  </h4>
                  {post.claim.reasons && post.claim.reasons.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {post.claim.reasons.map((rId) => {
                        const rObj = REVISION_REASONS.find((x) => x.id === rId);
                        return (
                          <span
                            key={rId}
                            className="rounded-md bg-amber-100 border border-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/60 dark:border-amber-700/60 dark:text-amber-200"
                          >
                            {rObj ? rObj.label : rId}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {post.claim.notes && (
                    <p className="text-xs italic text-amber-800 dark:text-amber-300 pt-1">
                      &quot;{post.claim.notes}&quot;
                    </p>
                  )}
                </div>
                {post.claim.guidanceCommentPermlink && (
                  <a
                    href={`https://steemit.com/@${post.claim.curator}/${post.claim.guidanceCommentPermlink}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 flex items-center gap-1 text-xs font-medium text-amber-800 hover:text-amber-950 underline dark:text-amber-300 dark:hover:text-amber-100 self-start sm:self-auto"
                  >
                    <span>Guidance Comment</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>
          )}

          {viewMode === 'rendered' ? (
            <SteemPostBody body={post.body} />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 whitespace-pre-wrap select-text dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200 break-words">
              {post.body}
            </div>
          )}

          {/* Creator Guidance Drawer (When opened by curator) */}
          {!isReadOnly && showRevisionForm && (
            <div className="mt-6 rounded-2xl border border-amber-300 bg-amber-50/70 p-5 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/30 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  Request Creator Revision (Quality Guidance Loop)
                </h4>
                <button
                  onClick={() => setShowRevisionForm(false)}
                  className="text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
                >
                  Cancel
                </button>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-300 [text-wrap:pretty]">
                Select the items needing attention. A polite, standardized guidance comment will be published under the post via Keychain, and the creator will receive 24–48 hours to make the update.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {REVISION_REASONS.map((reason) => {
                  const isSelected = selectedReasons.includes(reason.id);
                  return (
                    <button
                      key={reason.id}
                      type="button"
                      onClick={() => toggleReason(reason.id)}
                      className={`text-left p-3 rounded-xl border text-xs transition-all ${
                        isSelected
                          ? 'border-amber-500 bg-amber-100 text-amber-950 shadow-xs dark:border-amber-500/80 dark:bg-amber-500/20 dark:text-amber-200'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <span className="font-semibold block">{reason.label}</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">
                        {reason.description}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div>
                <label className="text-[11px] text-slate-700 dark:text-slate-300 block mb-1 font-medium">
                  Additional Note for Creator (Optional)
                </label>
                <textarea
                  value={customNotes}
                  onChange={(e) => setCustomNotes(e.target.value)}
                  placeholder="e.g. Please check diagram #2 source citation and reply here when fixed."
                  rows={2}
                  className="w-full rounded-xl border border-slate-300 bg-white p-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-amber-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleSubmitRevision}
                  disabled={submittingRevision}
                  className="rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-4 py-2 text-xs flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>
                    {submittingRevision ? 'Broadcasting...' : 'Publish Guidance Comment'}
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Sticky Actionable Footer */}
        <footer className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3 sm:px-6 sm:py-3.5 dark:border-slate-800 dark:bg-slate-950/90 transition-colors">
          {!isReadOnly ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleToggleClaim}
                  className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors flex items-center gap-1.5 border shadow-xs cursor-pointer ${
                    post.claim
                      ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200'
                      : 'border-emerald-600 bg-emerald-700 text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500'
                  }`}
                >
                  {post.claim ? (
                    <Unlock className="w-3.5 h-3.5" />
                  ) : (
                    <Lock className="w-3.5 h-3.5" />
                  )}
                  <span>{post.claim ? 'Release Lock' : 'Claim Post (45m)'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowRevisionForm((prev) => !prev)}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800/80 dark:bg-amber-950/50 dark:text-amber-200 flex items-center gap-1.5 cursor-pointer"
                >
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  <span>
                    {showRevisionForm ? 'Hide Revision Form' : 'Request Revisions'}
                  </span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs font-mono">
                  <span className="text-slate-600 dark:text-slate-400 font-sans">
                    Score:
                  </span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={qualityScore}
                    onChange={(e) => setQualityScore(Number(e.target.value))}
                    className="w-12 rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-center text-xs font-bold text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  />
                  <span className="text-slate-500">%</span>
                </div>

                <div className="flex items-center gap-1.5 text-xs font-mono">
                  <span className="text-slate-600 dark:text-slate-400 font-sans">
                    Vote:
                  </span>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    step="5"
                    value={voteWeight}
                    onChange={(e) => setVoteWeight(Number(e.target.value))}
                    className="w-20 accent-emerald-600 cursor-pointer"
                  />
                  <span className="font-bold text-emerald-700 dark:text-emerald-400 w-8 tabular-nums">
                    {voteWeight}%
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleApproveQueue}
                  className="rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 flex items-center gap-1.5 shadow-xs cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Approve to Queue</span>
                </button>

                <button
                  type="button"
                  onClick={handleDirectVote}
                  disabled={broadcastingVote}
                  className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center gap-1.5 border border-slate-700 shadow-xs cursor-pointer"
                  title={`Vote directly with @${teamAccount} key via Keychain`}
                >
                  <ThumbsUp className="w-3.5 h-3.5 text-emerald-400" />
                  <span>
                    {broadcastingVote ? 'Voting...' : `Vote @${teamAccount}`}
                  </span>
                </button>
              </div>
            </>
          ) : (
            <div className="w-full">
              {showInlineLogin ? (
                <form
                  onSubmit={handleInlineLoginSubmit}
                  className="flex flex-wrap items-center gap-2.5 w-full"
                >
                  <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
                    <span className="text-xs font-mono font-bold text-slate-500">@</span>
                    <input
                      type="text"
                      value={inlineUsername}
                      onChange={(e) => setInlineUsername(e.target.value)}
                      placeholder="curator account name"
                      disabled={verifyingLogin}
                      className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                      autoFocus
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={verifyingLogin}
                    className="rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 cursor-pointer"
                  >
                    {verifyingLogin ? 'Signing via Keychain...' : 'Authorize Keychain'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowInlineLogin(false);
                      setInlineLoginError(null);
                    }}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 cursor-pointer"
                  >
                    Cancel
                  </button>
                  {inlineLoginError && (
                    <span className="text-xs text-rose-600 dark:text-rose-400 font-mono w-full">
                      {inlineLoginError}
                    </span>
                  )}
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 w-full">
                  <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
                    <span className="inline-flex items-center gap-1 rounded-md bg-slate-200/80 px-2 py-0.5 text-[11px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-mono">
                      Observer Mode
                    </span>
                    <span>
                      {currentUser ? (
                        <>
                          Viewing as <strong className="font-semibold text-slate-800 dark:text-slate-200">@{currentUser}</strong> (Observer). Only active Steemit Community Curators and authorized team accounts can claim posts, request revisions, or cast votes.
                        </>
                      ) : (
                        <>
                          Guest view. Connect an assigned curator account via Keychain to claim posts or cast official curation votes.
                        </>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (onConnectKeychain) {
                        onConnectKeychain();
                      } else {
                        setShowInlineLogin(true);
                      }
                    }}
                    className="shrink-0 rounded-lg border border-emerald-600 bg-white px-3.5 py-1.5 text-xs font-semibold text-emerald-800 transition-colors hover:bg-emerald-700 hover:text-white dark:border-emerald-500/60 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-500 dark:hover:text-slate-950 flex items-center gap-1.5 shadow-xs cursor-pointer"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    <span>{currentUser ? 'Switch Curator Account' : 'Connect Keychain'}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </footer>
      </div>
    </div>
  );
};
