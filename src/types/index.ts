export type CurationAction = 'claim' | 'release' | 'needs_revision' | 'approve' | 'reject';

export interface CurationClaim {
  id: string; // author/permlink
  author: string;
  permlink: string;
  team: string;
  account: string; // e.g. steemcurator05 or booming03
  curator: string; // e.g. adeljose
  timestamp: number | string;
  expiresAt?: number;
  status: 'claimed' | 'in_review' | 'needs_revision' | 'approved' | 'rejected' | 'voted';
  action?: string;
  txId?: string;
  qualityScore?: number;
  suggestedWeight?: number;
  reasons?: string[];
  notes?: string;
  guidanceCommentPermlink?: string;
}

export interface ClubStatusResult {
  username: string;
  tier: 'Club100' | 'Club75' | 'Club5050' | 'Clubless';
  poweredUp: number;
  transferredOut: number;
  ratio: number; // percentage powered up (e.g. 75.5)
  isPoweringDown: boolean;
  eligible: boolean;
  periodDays: number;
}

export interface CurationTeam {
  id: string;
  name: string;
  account: string;
  members: string[];
  currentVP: number;
  voteValue100: number; // in USD / STU
}

export interface PostItem {
  id: number;
  author: string;
  authorReputation?: number | string | null;
  permlink: string;
  title: string;
  body: string;
  category: string;
  created: string;
  cashoutTime?: string;
  bodyLength?: number;
  tags?: string[];
  ageHours: number;
  pendingPayout: number;
  totalVotes: number;
  commentCount: number;
  curationVotesCount: number;
  curatorVoted: boolean; // whether an sc0x / booming voted
  curatorAccountsVoted: string[];
  wordCount: number;
  imageCount: number;
  images?: string[];
  json_metadata?: string | Record<string, unknown>;
  communityTitle?: string;
  plainExcerpt?: string;
  clubStatus?: ClubStatusResult;
  claim?: CurationClaim;
  txId?: string;
  beneficiaries?: { account: string; weight: number }[];
  isBurnSteem25?: boolean;
  isSteemExclusive?: boolean;
  isVideoPost?: boolean;
  language?: string;
}

export interface CurationReachSummary {
  totalActiveAuthors: number;
  authorsCurated: number;
  postSupportRatePercent: number;
  commentSupportRatePercent: number;
  giniCoefficient: number;
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

export interface CurationStats {
  totalActiveAuthors: number;
  totalPostsInWindow: number;
  postsCurated: number;
  conversionRate: number;
  curatorSelfVoteRate: number;
  diaryRatio: number;
  topCategories: { category: string; count: number; percentage: number }[];
  mentoredCount: number;
}
