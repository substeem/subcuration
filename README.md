# Olo Curation Hub
### Next-Generation Peer Review & Creator Advocacy Protocol for Steem

Standalone client-side curation workspace for Steem Community Curators, built with modern React, TypeScript, Tailwind CSS, Steem Keychain, and `@substeem/steem-sdk`.

Zero backend, zero database, zero hosting overhead—100% powered by the Steem blockchain, client-side cryptographic verification, and on-chain `custom_json`.

---

## 🌟 Key Features

### 1. 🛰️ Live Curation Radar
- **Active Window Filtering**: Scans live Steem discussions with smart caching and fast RPC failover.
- **Anti-Overlooked Filters**: Filter specifically for uncurated posts or quality articles sitting at pennies (`< $1.00 STU`).
- **Real-Time Club Status Calculator**: Automatic on-chain 30/60/90-day wallet history analysis (`Club100`, `Club75`, `Club5050`, or `Clubless`), saving curators from manual spreadsheet math.
- **Repeat Curation Detector**: Warnings if an author has already received a vote from official curation accounts in the active 7-day cycle.
- **Banned Content Filtering**: Prohibits and hides `#nsfw` content across all radar views and direct URL lookups.

### 2. 🛡️ Creator Rescue & Loss Watch
- Dedicated view tracking high-effort content sitting under `$1.00 STU` approaching payout close.
- Targets posts expiring within **12h–72h** (maximum age 6d 12h) so overlooked writers get rescued before cashout finishes.
- Includes a **Strict Rescue Mode** toggle (`>3000` characters, 12h–48h to payout).

### 3. 🔒 Real-Time Claim Lock (Anti-Collision Protocol)
- Broadcasts on-chain `custom_json` operations with ID `substeem_curation`.
- When a curator clicks **Claim Post**, a 45-minute exclusive review lock is established and visible to teammates across the network.
- Prevents collision, duplicate reviews, and wasted curator effort.

### 4. 💡 Creator Mentorship Loop ("Needs Revision")
- **Constructive Guidance**: Instead of bypassing creators who make honest oversights (e.g., missing citations, formatting, club alignment), curators click **"Request Revisions"**.
- Standardized, polite guidance comments are published under the post via Keychain, granting authors 24–48 hours to update their work.
- Automatically tracks guided posts in the **Guidance** tab with comment links, notes, and an **Approve to Queue** workflow.

### 5. 📊 Curation Intelligence & Diversity Health
- Evaluates community reach, conversion ratios, and Gini distribution coefficient.
- **Content Diversity Radar**: Live alert if repetitive Diary Game posts exceed 30% of curation volume, prompting curators to balance with Science, Technology, and Literature.
- **Curator Rotation Compliance**: Verifies that votes allocated to curator teammates remain strictly within the $\le 10\%$ Steemit Team policy threshold (max 1 vote/day).

### 6. 📝 1-Click Weekly Report Generator
- Produces publication-ready Steemit markdown reports.
- Allows curators to select **Top 7 Weekly Picks** with custom curator remarks.
- Generates clean markdown tables for performance metrics, Gini coefficient reach, club distribution, and mentor activity.

---

## 🚀 Quick Start

### Installation & Development
```bash
# Clone the repository
git clone https://github.com/substeem/substeem.git
cd substeem

# Install dependencies
npm install

# Start development server
npm run dev
```

Open `http://localhost:5173` in your browser with **Steem Keychain** installed.

### Production Build
```bash
npm run build
npm run preview
```

---

## 🛠️ On-Chain Protocol Specification (`custom_json`)

All protocol actions are signed with the curator's posting key via Keychain using `id: "substeem_curation"`:

```typescript
// 1. Claim a post (45-min exclusive lock)
{ action: "claim", author, permlink, team: "Team 3", account: "booming03", curator: "adeljose", expires_at: timestamp }

// 2. Release a lock
{ action: "release", author, permlink, team: "Team 3", curator: "adeljose" }

// 3. Request revisions
{ action: "needs_revision", author, permlink, team: "Team 3", curator: "adeljose", reasons: ["source_attribution"], notes: "..." }

// 4. Approve for queue
{ action: "approve", author, permlink, team: "Team 3", quality_score: 85, suggested_weight: 5000 }
```

---

## 📜 License
MIT - Created by Substeem ([@substeem.app](https://steemit.com/@substeem.app)).
