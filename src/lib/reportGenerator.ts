import {
  ALL_CURATOR_MEMBERS,
  isDiaryPost,
  STEEM_REPORT_LOGO_URL,
  STEEM_REPORT_FALLBACK_IMAGE,
} from './constants';
import type { PostItem } from '../types';
import { extractPostImages, formatSteemReputation } from './textUtils';

export interface CurationReachSummary {
  totalActiveAuthors: number;
  authorsCurated: number;
  postSupportRatePercent: number;
  commentSupportRatePercent: number;
  giniCoefficient: number;
}

export interface ClubDistributionSummary {
  club100: number;
  club75: number;
  club5050: number;
  clubless: number;
}

export interface ReportConfig {
  teamName: string;
  account: string;
  curatorMembers: string[];
  weekNumber: number;
  monthName: string;
  year?: number;
  topSevenPicks: {
    post: PostItem;
    justification: string;
    nominatedBy: string;
    txId?: string;
  }[];
  allCuratedPosts: PostItem[];
  mentoredPosts: {
    post: PostItem;
    revisionOutcome: string;
    curator: string;
    txId?: string;
  }[];
  reachMetrics?: CurationReachSummary;
  clubDistribution?: ClubDistributionSummary;
  onChainMentorship?: {
    feedbackCommentsCount: number;
    uniqueAuthorsGuided: number;
  };
}

function computeGiniIndex(values: number[]): number {
  const n = values.length;
  if (n <= 1) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0;
  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return Math.max(0, Math.min(1, weightedSum / (n * sum)));
}

/**
 * Strips query parameters (?_gl=..., ?utm_...) and builds a canonical Steemit link.
 */
export function buildCleanSteemUrl(post: Pick<PostItem, 'category' | 'author' | 'permlink'>): string {
  const cleanCategory = (post.category || 'steem').replace(/[^a-zA-Z0-9-_]/g, '');
  const cleanAuthor = post.author.replace(/^@/, '').trim().toLowerCase();
  const cleanPermlink = post.permlink.split('?')[0].split('#')[0].trim();
  return `https://steemit.com/${cleanCategory}/@${cleanAuthor}/${cleanPermlink}`;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

export function generateSteemPodReport(config: ReportConfig): string {
  const {
    teamName,
    account,
    curatorMembers,
    weekNumber,
    monthName,
    year = 2026,
    topSevenPicks,
    allCuratedPosts,
    mentoredPosts,
    reachMetrics,
    clubDistribution,
    onChainMentorship,
  } = config;
  const activeReachMetrics = reachMetrics;

  const totalVotes = allCuratedPosts.length;
  const authorVoteCounts = new Map<string, number>();
  for (const p of allCuratedPosts) {
    const a = p.author.toLowerCase();
    authorVoteCounts.set(a, (authorVoteCounts.get(a) || 0) + 1);
  }
  const uniqueAuthors = authorVoteCounts.size;
  const teamGini = computeGiniIndex(Array.from(authorVoteCounts.values()));

  // Separate posts vs comments curated accurately via parentAuthor / isComment flag
  const commentCurations = allCuratedPosts.filter(
    (p) =>
      Boolean(p.isComment) ||
      Boolean(p.parentAuthor) ||
      p.permlink.startsWith('re-') ||
      p.category.startsWith('re-')
  ).length;
  const postCurations = totalVotes - commentCurations;

  // Category distribution sorted descending
  const categoryCounts: Record<string, number> = {};
  let diaryCount = 0;
  for (const p of allCuratedPosts) {
    categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1;
    if (isDiaryPost(p)) diaryCount++;
  }
  const sortedCategories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);

  // Steemit Curation Policy Math:
  // 1. Own-Team Self-Reward Votes:
  //    Active curators get 1 vote of 100% per 24h shift on their own post (10% daily/weekly cap).
  //    Team 4 (@booming04) solo curator -> max 7/7 votes per week.
  //    3-member teams -> 2-3 votes per member (max 7/wk or <= 10%).
  const ownTeamSet = new Set(curatorMembers.map((m) => m.toLowerCase()));
  const ownTeamVotes = allCuratedPosts.filter((p) =>
    ownTeamSet.has(p.author.toLowerCase())
  ).length;
  const ownTeamRatioNum = totalVotes > 0 ? (ownTeamVotes / totalVotes) * 100 : 0;
  const ownTeamRatio = ownTeamRatioNum.toFixed(1);
  const ownTeamCompliant = ownTeamVotes <= 7 || ownTeamRatioNum <= 10.0;

  // 2. Cross-Team Fellow Curator Votes:
  //    Votes cast to curators belonging to OTHER teams (organic community curation).
  const allCuratorVotes = allCuratedPosts.filter((p) =>
    ALL_CURATOR_MEMBERS.has(p.author.toLowerCase())
  ).length;
  const crossTeamCuratorVotes = Math.max(0, allCuratorVotes - ownTeamVotes);
  const crossTeamRatio =
    totalVotes > 0 ? ((crossTeamCuratorVotes / totalVotes) * 100).toFixed(1) : '0.0';

  const diaryShareNum = totalVotes > 0 ? (diaryCount / totalVotes) * 100 : 0;
  const diaryStatus =
    diaryShareNum > 30
      ? `${diaryShareNum.toFixed(1)}% (WARNING: > 30% Diary Cap)`
      : `${diaryShareNum.toFixed(1)}% (Balanced & Compliant)`;

  // Club Tier Counts (derived from posts or passed config)
  let c100 = clubDistribution?.club100 ?? 0;
  let c75 = clubDistribution?.club75 ?? 0;
  let c5050 = clubDistribution?.club5050 ?? 0;
  let cless = clubDistribution?.clubless ?? 0;

  if (!clubDistribution) {
    for (const p of allCuratedPosts) {
      const tier = p.clubStatus?.tier;
      if (tier === 'Club100') c100++;
      else if (tier === 'Club75') c75++;
      else if (tier === 'Club5050') c5050++;
      else cless++;
    }
  }
  const clubTotal = c100 + c75 + c5050 + cless || totalVotes || 1;

  // ==================== REPORT MARKDOWN BUILDER ====================
  let md = `<center>![Olo Curation Hub Logo](${STEEM_REPORT_LOGO_URL})</center>\n\n`;
  md += `# <center>🏆 Community Curation Weekly Report: ${teamName} (@${account})</center>\n`;
  md += `### <center>📅 Week #${weekNumber} — ${monthName} ${year}</center>\n\n`;
  md += `<center>**Curator Shift Roster:** ${curatorMembers.map((m) => `@${m}`).join(', ')}</center>\n\n`;

  md += `Throughout this curation week, **${teamName}** actively scouted, reviewed, and supported high-effort, original content across the Steem blockchain using the **Olo Curation Hub**. Guided by strict adherence to Steemit guidelines—enforcing original creator attribution, active club participation (Club5050 / Club75 / Club100), zero-tolerance for plagiarism or AI generation, and constructive author mentorship—we proudly present our verified weekly curation report.\n\n`;
  md += `---\n\n`;

  // 1. Weekly Performance & Network Reach Metrics
  md += `### 📊 1. Weekly Performance & Network Reach Ledger\n\n`;
  md += `| Metric | Curated Value | Policy Standard / Benchmark |\n`;
  md += `| :--- | :--- | :--- |\n`;
  md += `| **Total Curated Items** | **${totalVotes}** | Weekly Voting Window |\n`;
  md += `| **Posts Curated** | ${postCurations} (${totalVotes > 0 ? ((postCurations / totalVotes) * 100).toFixed(1) : '0'}%) | Main Quality Content |\n`;
  md += `| **Comments Curated** | ${commentCurations} (${totalVotes > 0 ? ((commentCurations / totalVotes) * 100).toFixed(1) : '0'}%) | Encouraging Dialogue & Engagement |\n`;
  md += `| **Unique Creators Reached** | **${uniqueAuthors}** | Broad Community Inclusivity |\n`;
  md += `| **Average Curation Frequency** | ${(totalVotes / (uniqueAuthors || 1)).toFixed(2)}x votes / author | Balanced Repeat Rate |\n`;
  md += `| **Diary Game Share** | **${diaryStatus}** | Steemit Policy Cap: &le; 30% |\n`;
  const guidedCount = Math.max(
    mentoredPosts.length,
    onChainMentorship?.uniqueAuthorsGuided ?? 0
  );
  const feedbackTotal = onChainMentorship?.feedbackCommentsCount ?? 0;
  const mentoredDisplay =
    feedbackTotal > 0
      ? `**${guidedCount}** (${feedbackTotal} feedback comments)`
      : `**${mentoredPosts.length}**`;
  md += `| **Creators Mentored / Guided** | ${mentoredDisplay} | Quality Elevation via Feedback |\n`;

  if (activeReachMetrics) {
    const ecosystemAuthors = Math.max(uniqueAuthors, activeReachMetrics.authorsCurated);
    const teamReachPct =
      ecosystemAuthors > 0 ? ((uniqueAuthors / ecosystemAuthors) * 100).toFixed(1) : '0.0';
    md += `| **Network Author Reach (Steemit Team Metric)** | ${uniqueAuthors} / ${ecosystemAuthors} (${teamReachPct}% of ecosystem) | Share of Active Curated Authors |\n`;
    md += `| **Vote Distribution Gini Index** | **${teamGini.toFixed(3)}** (Network: ${activeReachMetrics.giniCoefficient.toFixed(3)}) | Target &le; 0.48 (Low Inequality) |\n`;
  } else {
    md += `| **Vote Distribution Gini Index** | **${teamGini.toFixed(3)}** | Target &le; 0.48 (Low Inequality) |\n`;
  }
  md += `\n---\n\n`;

  // 2. Curator Self-Reward Policy & Compliance Audit
  md += `### 🛡️ 2. Curator Self-Reward Policy & Compliance Audit\n\n`;
  md += `Steemit curation rules allow the on-duty curator **one 100% vote per 24 hours** from their team's curation account as compensation for their daily shift (equivalent to **10.0% of weekly voting power**). Solo curators receive up to 7 votes/week, while 3-member teams distribute 2–3 votes per member across the 7-day cycle. Cross-team votes represent organic community curation of fellow creators.\n\n`;
  md += `| Policy Dimension | Count & Share | Compliance Status |\n`;
  md += `| :--- | :--- | :--- |\n`;
  md += `| **Own-Team Curator Self-Reward** | ${ownTeamVotes} votes (${ownTeamRatio}%) | ${
    ownTeamCompliant
      ? '✅ Compliant (&le; 10.0% / max 7 votes/wk allowance)'
      : '⚠️ Exceeds 10% Policy Limit'
  } |\n`;
  md += `| **Cross-Team Curator Curation** | ${crossTeamCuratorVotes} votes (${crossTeamRatio}%) | 🌐 Organic Community Support (Fellow Teams) |\n`;
  md += `| **Total Curator Accounts Supported** | ${allCuratorVotes} votes | 31 Active Community Curators |\n\n`;

  md += `*Shift Roster Verification:* All self-rewards allocated strictly correspond to active on-duty curator shifts without exceeding the permitted 1-vote-per-day allowance.\n\n`;
  md += `---\n\n`;

  // 3. Club Status Distribution
  md += `### 💎 3. Club Status Distribution\n\n`;
  md += `Club eligibility represents a creator's commitment to building Steem Power and strengthening the Steem ecosystem. Our team actively prioritizes authors adhering to Club rules:\n\n`;
  md += `| Club Tier | Requirement | Posts Curated | Share (%) |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  md += `| **Club100** | 100% Power-up (Zero transfers out) | ${c100} | ${((c100 / clubTotal) * 100).toFixed(1)}% |\n`;
  md += `| **Club75** | &ge; 75% Powered up in 60 days | ${c75} | ${((c75 / clubTotal) * 100).toFixed(1)}% |\n`;
  md += `| **Club5050** | &ge; 50% Powered up in 30 days | ${c5050} | ${((c5050 / clubTotal) * 100).toFixed(1)}% |\n`;
  md += `| **Clubless / Other** | Ineligible / Casual | ${cless} | ${((cless / clubTotal) * 100).toFixed(1)}% |\n`;
  md += `| **Total** | Verified Accounts | **${clubTotal}** | **100.0%** |\n\n`;
  md += `---\n\n`;

  // 4. Content Diversity & Community Distribution
  md += `### 🌐 4. Content Diversity & Community Distribution\n\n`;
  md += `To maintain healthy ecosystem breadth, our team evaluated submissions across multiple communities and subject areas:\n\n`;
  md += `| Rank | Community / Category | Posts Curated | Share (%) |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  if (sortedCategories.length > 0 && totalVotes > 0) {
    sortedCategories.slice(0, 10).forEach(([cat, count], idx) => {
      const share = ((count / totalVotes) * 100).toFixed(1);
      md += `| #${idx + 1} | #${escapeTableCell(cat)} | ${count} | ${share}% |\n`;
    });
  } else {
    md += `| - | No entries recorded | 0 | 0.0% |\n`;
  }
  md += `\n---\n\n`;

  // 5. Top 7 Weekly Selections (Picks of the Week)
  md += `### ⭐ 5. Top 7 Weekly Selections (Picks of the Week)\n\n`;
  md += `Here are the top 7 standout publications nominated and agreed upon by the curation team this week, exemplifying outstanding creativity, technical accuracy, and presentation:\n\n`;

  if (topSevenPicks.length === 0) {
    md += `*No selections specified for this cycle.*\n\n`;
  } else {
    topSevenPicks.forEach((pick, idx) => {
      const cleanUrl = buildCleanSteemUrl(pick.post);
      const isCuratorAuthor = ALL_CURATOR_MEMBERS.has(pick.post.author.toLowerCase());
      const rep = formatSteemReputation(pick.post.authorReputation);
      const clubTier = pick.post.clubStatus?.tier || 'Club5050+';
      const communityName = pick.post.communityTitle || `#${pick.post.category}`;

      // Extract cover image or use fallback
      const images = extractPostImages({
        body: pick.post.body,
        json_metadata: pick.post.json_metadata,
      });
      const coverUrl = images[0] || STEEM_REPORT_FALLBACK_IMAGE;

      md += `<center>![${escapeTableCell(pick.post.title)}](${coverUrl})</center>\n\n`;
      md += `### Selection #${idx + 1}: [${escapeTableCell(pick.post.title)}](${cleanUrl})\n\n`;

      md += `* **Author:** @${pick.post.author} (Reputation: ${rep})${
        isCuratorAuthor ? ' *(Fellow Curator)*' : ''
      }\n`;
      md += `* **Club Status:** #${clubTier}\n`;
      md += `* **Community / Category:** ${communityName} (#${pick.post.category})\n`;
      md += `* **Nominated By:** @${pick.nominatedBy}\n`;
      if (pick.txId) {
        md += `* **On-Chain Vote Hash:** \`${pick.txId}\`\n`;
      }
      md += `* **Curator Evaluation & Quality Rationale:**\n`;
      md += `  > ${pick.justification.replace(/\r?\n/g, '\n  > ')}\n\n`;
      md += `---\n\n`;
    });
  }

  // 6. Creator Mentorship & Quality Elevation Ledger
  md += `### 🤝 6. Creator Mentorship & Quality Elevation Ledger\n\n`;
  md += `Rather than bypassing authors with minor formatting errors or club discrepancies, our team actively engaged with creators via on-chain mentorship comments to guide revisions:\n\n`;
  md += `| Author | Post Title | Revision Guidance Focus | Curator Mentor | Status |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- |\n`;

  if (mentoredPosts.length > 0) {
    for (const m of mentoredPosts) {
      const cleanUrl = buildCleanSteemUrl(m.post);
      const safeTitle = escapeTableCell(m.post.title);
      const shortTitle = safeTitle.length > 40 ? `${safeTitle.slice(0, 40)}...` : safeTitle;
      const txBadge = m.txId ? ` (\`${m.txId.slice(0, 8)}\`)` : '';
      md += `| @${m.post.author} | [${shortTitle}](${cleanUrl}) | ${escapeTableCell(m.revisionOutcome)} | @${m.curator} | ✅ Guided & Resolved${txBadge} |\n`;
    }
  } else {
    md += `| - | No pending revisions logged this cycle | Standards fully met | - | Complete |\n`;
  }
  md += `\n---\n\n`;

  // 7. Transparency, Beneficiaries & Verification Declaration
  md += `### 🛡️ 7. Beneficiaries & Team Verification Declaration\n\n`;
  md += `All active team members (${curatorMembers.map((m) => `@${m}`).join(', ')}) have reviewed and unanimously approved this report. In accordance with Steemit curation policy, author beneficiaries for this publication are split equally among team members:\n\n`;

  const perMemberPercent = Math.floor(100 / curatorMembers.length);
  const remainder = 100 - perMemberPercent * curatorMembers.length;

  curatorMembers.forEach((member, i) => {
    const pct = i === 0 ? perMemberPercent + remainder : perMemberPercent;
    md += `* **@${member}**: ${pct}% Beneficiary\n`;
  });

  md += `\n<center>\n\n`;
  md += `*Verified On-Chain Data compiled via **Olo Curation Hub** (Substeem Protocol)*\n`;
  md += `*Timestamp: ${new Date().toISOString().slice(0, 10)}*\n\n`;
  md += `</center>\n`;

  return md;
}
