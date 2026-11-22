const CJK_REGEX =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

const DAPP_BOILERPLATE_REGEXES = [
  // Steemhunt boilerplate patterns
  /^Screenshots\s+Hunter'?s\s+comment:?\s*/i,
  /^Hunter'?s\s+comment:?\s*/i,
  /^Hunter'?s\s+Comments:?\s*/i,
  // Actifit boilerplate
  /^Today'?s\s+Activity:\s*/i,
  /^Activity\s+Count:\s*/i,
  // Generic dApp automated disclaimers
  /^Posted\s+using\s+[a-zA-Z0-9_-]+\s*/i,
  /^This\s+post\s+was\s+written\s+via\s+[a-zA-Z0-9_-]+\s*/i,
];

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–');
}

/**
 * Strips HTML tags, Markdown image syntax, raw URLs, code fences, and dividers
 * so card excerpts contain only readable prose. Optionally strips leading duplicate title
 * and common dApp boilerplate prefixes (e.g. Steemhunt).
 */
export function stripMarkdownAndHtml(rawBody: string, title?: string): string {
  if (!rawBody) return '';

  let text = rawBody
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Remove fenced code blocks
    .replace(/```[\s\S]*?```/g, ' ')
    // Remove standard & broken Markdown image tags: ![alt](url) or !filename.jpg[url]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/!\S+\.(?:jpg|jpeg|png|webp|gif)(?:\[[^\]]*\]|\([^)]*\))?/gi, ' ')
    // Convert Markdown links [label](url) to label (drop if label itself is a URL)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string) =>
      /^https?:\/\//i.test(label.trim()) ? ' ' : ` ${label} `
    )
    // Remove reference-style link definitions: [1]: https://...
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    // Strip all HTML tags (including multi-line tags like <div class="text-justify">)
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    // Strip bare URLs
    .replace(/https?:\/\/[^\s)>"']+/gi, ' ')
    .replace(/\bwww\.[^\s)>"']+/gi, ' ')
    // Remove horizontal rules and table separator rows
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ')
    // Remove Markdown headings, blockquotes, pipes, and emphasis symbols
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[|`*_~]+/g, ' ');

  text = decodeHtmlEntities(text);
  text = text.replace(/\s+/g, ' ').trim();

  // Strip common dApp boilerplate intros
  for (const regex of DAPP_BOILERPLATE_REGEXES) {
    text = text.replace(regex, '').trim();
  }

  // Strip leading duplicate title if present (e.g. on Steemhunt posts)
  if (title) {
    const cleanTitle = title.replace(/[#*`_[\]()]/g, '').trim().toLowerCase();
    if (cleanTitle.length > 5 && text.toLowerCase().startsWith(cleanTitle)) {
      text = text.slice(cleanTitle.length).replace(/^[:\s\-—]+/, '').trim();
    }
  }

  return text;
}

/**
 * Produces a clean, word-boundary-safe excerpt.
 */
export function extractPlainExcerpt(rawBody: string, maxLength = 220, title?: string): string {
  const clean = stripMarkdownAndHtml(rawBody, title);
  if (!clean || clean.trim().length === 0) {
    if (detectVideoPost(rawBody)) {
      return title ? `Video post: ${title}` : 'Video embed preview.';
    }
    return '';
  }
  if (clean.length <= maxLength) return clean;

  const sliced = clean.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(' ');
  const cutoff = lastSpace > maxLength * 0.65 ? lastSpace : maxLength;
  return `${sliced.slice(0, cutoff).trim()}…`;
}

/**
 * Counts words accurately for both whitespace-delimited languages and CJK scripts
 * (Chinese, Japanese, Korean) after stripping markup and URLs.
 */
export function countWordsMultilingual(rawBody: string): number {
  const clean = stripMarkdownAndHtml(rawBody);
  if (!clean) return 0;

  const cjkMatches = clean.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Remove CJK characters before splitting remaining scripts on whitespace
  const withoutCjk = clean.replace(CJK_REGEX, ' ').trim();
  const nonCjkWords = withoutCjk
    ? withoutCjk.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length
    : 0;

  return cjkCount + nonCjkWords;
}

/**
 * Formats a post's age into clean, human-readable elapsed time.
 * Avoids fractional hours (0.1h, 0.3h) or confusing 0h.
 * Examples: 'Just now', '6m', '42m', '1h 15m', '3h', '1d 4h'.
 */
export function formatRelativeSteemTime(created?: string, ageHours?: number): string {
  let minutes = 0;
  if (created) {
    const normalized = created.endsWith('Z') ? created : `${created}Z`;
    const parsed = Date.parse(normalized);
    if (!Number.isNaN(parsed)) {
      minutes = Math.max(0, Math.floor((Date.now() - parsed) / 60000));
    }
  } else if (typeof ageHours === 'number') {
    minutes = Math.max(0, Math.round(ageHours * 60));
  }

  if (minutes < 2) return 'Just now';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;

  if (hours < 24) {
    if (hours < 3 && remainingMins > 0) {
      return `${hours}h ${remainingMins}m`;
    }
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days < 3 && remainingHours > 0) {
    return `${days}d ${remainingHours}h`;
  }
  return `${days}d`;
}

/**
 * Extracts all candidate images from both json_metadata and raw post.body.
 * Handles stringified JSON from condenser_api, object metadata from bridge,
 * Markdown images, HTML <img>, bare image URLs, extensionless CDN links
 * (e.g. cdn.steemitimages.com/DQm...), and uppercase/queried extensions.
 */
export function extractPostImages(post: {
  body?: string;
  json_metadata?: string | { image?: unknown; images?: unknown };
}): string[] {
  const candidates: string[] = [];

  // 1. Parse json_metadata safely (handles both condenser_api strings & bridge objects)
  let meta: { image?: unknown; images?: unknown } = {};
  if (typeof post.json_metadata === 'string') {
    try {
      meta = JSON.parse(post.json_metadata || '{}');
    } catch {
      meta = {};
    }
  } else if (post.json_metadata && typeof post.json_metadata === 'object') {
    meta = post.json_metadata as { image?: unknown; images?: unknown };
  }

  const metaImages = Array.isArray(meta.image)
    ? meta.image
    : Array.isArray(meta.images)
    ? meta.images
    : [];

  for (const item of metaImages) {
    if (typeof item === 'string' && /^https?:\/\//i.test(item.trim())) {
      candidates.push(item.trim());
    }
  }

  // 2. Scan post.body across Markdown, HTML <img>, bare image URLs, and Steem/Hive CDNs
  const body = post.body ?? '';
  const patterns = [
    /!\[[^\]]*\]\((https?:\/\/[^\s)"']+)\)/gi,
    /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi,
    /https?:\/\/[^\s"'<>()]+?\.(?:jpe?g|png|gif|webp|avif)(?:\?[^\s"'<>()]*)?/gi,
    /https?:\/\/(?:cdn\.steemitimages\.com|steemitimages\.com|images\.ecency\.com|images\.hive\.blog)\/(?:DQm|p\/)[^\s"'<>()]+/gi,
  ];

  for (const regex of patterns) {
    for (const match of body.matchAll(regex)) {
      const url = (match[1] ?? match[0]).trim();
      if (url) candidates.push(url);
    }
  }

  // 3. Scan for YouTube & video links and extract video poster thumbnails
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi;
  for (const match of body.matchAll(ytRegex)) {
    if (match[1]) {
      candidates.push(`https://img.youtube.com/vi/${match[1]}/hqdefault.jpg`);
    }
  }

  // Deduplicate while preserving order
  return [...new Set(candidates)];
}

/**
 * Checks whether the post body is primarily or contains video embeds.
 */
export function detectVideoPost(body?: string): boolean {
  if (!body) return false;
  return /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/|vimeo\.com\/|3speak\.tv\/|d\.tube\/)/i.test(body);
}

/**
 * Returns thumbnail image URLs cleanly and directly.
 * Skips broken proxy wrappers (such as obsolete steemitimages.com/640x0/ endpoints that return 404 JSON).
 * Local assets (/...) are served directly from edge CDN cache.
 */
export function getProxiedThumbnail(url: string, _width = 640): string {
  if (!url) return '';
  return url;
}

/**
 * Normalizes raw author reputation from Steem APIs.
 * Supports both pre-formatted scores from bridge API (-100 to 100)
 * and raw log10 integers from condenser_api.
 */
export function formatSteemReputation(raw?: number | string | null): number {
  if (raw == null || raw === '') return 25;
  const num = Number(raw);
  if (!Number.isFinite(num) || num === 0) return 25;
  // Already formatted by bridge API (typically -100 to 100)
  if (Math.abs(num) <= 100) return Math.floor(num);
  // Raw condenser_api log10 integer
  const neg = num < 0;
  let score = Math.max(Math.log10(Math.abs(num)) - 9, 0);
  if (neg) score = -score;
  return Math.floor(score * 9 + 25);
}

/**
 * Detects the primary language of a Steem post based on metadata, tags, and Unicode scripts.
 */
export function detectPostLanguage(post: {
  body?: string;
  title?: string;
  category?: string;
  tags?: string[];
  json_metadata?: unknown;
}): 'en' | 'ko' | 'es' | 'bn' | 'uk' | 'id' | 'other' {
  let metaLang = '';
  if (typeof post.json_metadata === 'string') {
    try {
      const meta = JSON.parse(post.json_metadata);
      if (typeof meta.lang === 'string') metaLang = meta.lang.toLowerCase();
    } catch {}
  } else if (post.json_metadata && typeof post.json_metadata === 'object') {
    const meta = post.json_metadata as Record<string, unknown>;
    if (typeof meta.lang === 'string') metaLang = String(meta.lang).toLowerCase();
  }

  if (metaLang.startsWith('ko')) return 'ko';
  if (metaLang.startsWith('es')) return 'es';
  if (metaLang.startsWith('bn')) return 'bn';
  if (metaLang.startsWith('uk') || metaLang.startsWith('ru')) return 'uk';
  if (metaLang.startsWith('id')) return 'id';
  if (metaLang.startsWith('en')) return 'en';

  const tagsList = (Array.isArray(post.tags) ? post.tags : []).map((t) => String(t).toLowerCase());
  const category = (post.category || '').toLowerCase();
  const title = post.title || '';
  const body = post.body || '';

  // 1. Korean
  if (
    tagsList.some((t) => ['kr', 'korea', 'zzan', 'atomy', 'kr-success', 'steemitkorea'].includes(t)) ||
    category === 'kr' ||
    category === 'korea' ||
    /[\uac00-\ud7af]/.test(title) ||
    /[\uac00-\ud7af]{3,}/.test(body)
  ) {
    return 'ko';
  }

  // 2. Bengali
  if (
    tagsList.some((t) => ['bangla', 'bengali', 'amarbanglablog', 'abb', 'bd'].includes(t)) ||
    /[\u0980-\u09ff]/.test(title) ||
    /[\u0980-\u09ff]{3,}/.test(body)
  ) {
    return 'bn';
  }

  // 3. Ukrainian / Russian (Cyrillic)
  if (
    tagsList.some((t) => ['ukraine', 'ua', 'russia', 'ru'].includes(t)) ||
    /[\u0400-\u04ff]/.test(title) ||
    /[\u0400-\u04ff]{5,}/.test(body)
  ) {
    return 'uk';
  }

  // 4. Spanish
  if (
    tagsList.some((t) =>
      ['spanish', 'cervantes', 'es', 'venezuela', 'colombia', 'argentina', 'steemexclusive-es'].includes(t)
    ) ||
    /\b(hoy|amigos|este|esta|vida|diario|saludos|semana)\b/i.test(title)
  ) {
    return 'es';
  }

  // 5. Indonesian
  if (
    tagsList.some((t) => ['indonesia', 'id', 'steemsea', 'promo-steem-id', 'aceh'].includes(t)) ||
    /\b(hari\s+ini|sahabat|saya|pada|dalam)\b/i.test(title)
  ) {
    return 'id';
  }

  return 'en';
}
