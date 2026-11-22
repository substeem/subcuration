export interface MentorshipReason {
  id: string;
  label: string;
  description: string;
  defaultCommentSnippet: string;
}

export const REVISION_REASONS: MentorshipReason[] = [
  {
    id: 'club_alignment',
    label: 'Club Status / Power Down',
    description: 'Author transferred out > 50% or has an active power down enabled.',
    defaultCommentSnippet:
      'We noticed you currently do not meet the minimum Club5050 threshold (or have an active power down). If you power up your recent earnings to align with community curation guidelines, please let us know so we can review this post again!',
  },
  {
    id: 'source_attribution',
    label: 'Image / Data Attribution',
    description: 'Images, diagrams, or references lack clear free-to-use licensing or source citations.',
    defaultCommentSnippet:
      'Your content is very interesting! To qualify for Tier 1 community curation, please provide the direct source links or attribution licenses for the images/diagrams used.',
  },
  {
    id: 'formatting_readability',
    label: 'Formatting & Layout',
    description: 'Text block walls, broken markdown images, or low readability.',
    defaultCommentSnippet:
      'Great topic! For a better reader experience, consider breaking large text blocks into subheadings and centering your images. You have 24 hours to revise before our final queue pass.',
  },
  {
    id: 'proof_of_work',
    label: 'Proof of Originality / Work',
    description: 'Creative or technical work lacks step-by-step documentation or proof of authorship.',
    defaultCommentSnippet:
      'We would love to support your work! Please add a brief behind-the-scenes explanation, working screenshots, or proof of process to verify authenticity.',
  },
  {
    id: 'language_tagging',
    label: 'Tagging & Community Context',
    description: 'Wrong language tag or mismatched community category.',
    defaultCommentSnippet:
      'Please ensure you use the appropriate primary language and topic tags so interested readers can discover your post easily.',
  },
];

function formatBlockquote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

export function buildGuidanceComment(
  curatorUsername: string,
  teamName: string,
  selectedReasonIds: string[],
  customNotes?: string
): string {
  const snippets = selectedReasonIds
    .map((id) => REVISION_REASONS.find((r) => r.id === id)?.defaultCommentSnippet)
    .filter((s): s is string => Boolean(s));

  const checklistSection =
    snippets.length > 0
      ? snippets.map((s, idx) => `${idx + 1}. ${s}`).join('\n\n')
      : '1. Please review the curator note below for specific suggestions.';

  const notesBlock = customNotes?.trim()
    ? `\n**Curator Note:**\n${formatBlockquote(customNotes)}\n`
    : '';

  return `### 💡 Substeem Community Curation Review
**Reviewed by:** @${curatorUsername} (${teamName})
**Status:** ⏳ **Needs Revisions / Guided Feedback**

Hello! We reviewed your post for our community curation queue. We really value your participation on Steem, and we want to help you qualify for the best possible upvote from our curation accounts.

Before we finalize our queue, here are a few suggestions to help your post meet our standards:

${checklistSection}
${notesBlock}
---
*You have **24 to 48 hours** to make these edits. Once updated, simply reply to this comment so our team can re-inspect and approve your post for curation!*`;
}
