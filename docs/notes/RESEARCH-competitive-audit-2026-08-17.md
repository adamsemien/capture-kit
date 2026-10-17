# capture-kit competitive audit - settings, features, and the $30 question

NOBC-82. Researched 2026-08-17 via three parallel sweeps: macOS professional tools (CleanShot X, Shottr, Xnapper, Snagit, Monosnap, macOS built-in), Chrome capture extensions (GoFullPage, FireShot, Awesome Screenshot, Nimbus, Screenity, DevTools baseline), and dev bug-capture tools (Jam.dev, Bird Eats Bug, Marker.io, BugHerd, Replay.io, plus the OSS MCP field). Pricing verified against current pages, not memory. Source links at bottom.

## TL;DR

capture-kit is two products wearing one trench coat, and the audit says to price and build for the second one. As a *screenshot tool* it is missing four table-stakes settings that even a $12 tool ships (chosen folder, filename template, format/quality control, after-capture actions). As a *debugging-capture tool* it already owns a position nobody occupies: local-first, zero-account, paste-ready markdown for AI assistants, one-time price. Jam.dev - the closest competitor - is hosted-only, subscription, and requires MCP/CLI plumbing; every other bug-capture tool sells to teams at $500+/yr. The $30 one-time price is viable precisely because no competitor sells that transaction shape, but only if the four table-stakes settings exist so it doesn't feel amateur next to CleanShot ($29) sitting on the same receipt.

Three findings that change the morning's PR:

- **The output-folder feature is a first-of-its-kind, not a fix.** No Chrome screenshot extension ships clean save-anywhere. GoFullPage and Awesome Screenshot both document the Downloads-subfolder ceiling as a hard limit. FireShot escapes it only via a Windows-only native .exe. Screenity (recorder, not screenshots) is the lone FSA prior art - and it keeps an extension tab pinned open to hold the permission. Chrome 122+ persistent permissions may remove that hack; the official blog is silent on extension origins, so the spec's spike is exactly right. Added to the spec: if persistence fails, the Screenity pattern is fallback plan B before falling back to Downloads.
- **The agent trigger has shipped prior art.** FireShot exposes a free in-page JavaScript capture API. The spec's CustomEvent design is the same idea, MV3-clean. Build with confidence.
- **Jam.dev is the threat to watch, not the screenshot tools.** Free tier: 30 captures/mo including console+network+hosted MCP, plus a CLI that installs a SKILL.md auto-detecting Claude Code and Cursor. They see the agent market clearly. capture-kit's moat is what Jam structurally can't do: no account, no upload, markdown on your clipboard in one gesture.

## The matrix

ck = capture-kit today. ● yes, ◐ partial, ○ no, n/a not applicable.

| Setting / feature | ck | GoFullPage | FireShot Pro | CleanShot X | Jam.dev | macOS built-in |
|---|---|---|---|---|---|---|
| Arbitrary save folder | ○ (PR-2 spec'd) | ○ Downloads subfolder only | ● Windows-only native host | ● | ○ cloud only | ● |
| Filename template / tokens | ○ fixed slug_timestamp | ○ | ● %date, %e domain, counter | ● date, app, window title | n/a | ○ |
| Format choice + quality slider | ◐ JPEG default, no UI | ◐ PNG/JPEG/PDF | ● + JPEG quality, PDF opts | ● PNG/JPEG/WebP/HEIC | n/a | ○ (defaults-write only) |
| Retina 2x→1x control | ● 1x cap | ○ | ○ | ● | n/a | ○ |
| After-capture actions setting | ○ fixed pipeline | ◐ auto-download toggle | ◐ auto-save, no dialog | ● multiple simultaneous | ◐ 3 capture modes | ◐ thumbnail toggle |
| Custom hotkeys | ◐ one command, chrome://extensions/shortcuts | ◐ | ● | ● full tab | ◐ | ● |
| Console + network capture | ● failures-only, curated | ○ | ○ | ○ | ● full depth, hosted | ○ |
| Markdown / AI-native artifact | ● unique | ○ | ○ | ○ | ◐ via hosted MCP + CLI | ○ |
| Local-first, zero account | ● | ● | ● | ● | ○ | ● |
| Programmatic trigger | ○ (PR-2 spec'd) | ○ | ● free JS API | ● URL scheme | ● CLI | ○ |
| Auto-redact secrets | ○ | ○ | ○ | ○ | ● client-side | ○ |
| History / library | ○ latest.* only | ○ | ● Pro | ◐ cloud | ● cloud | ○ |
| Sticky-header mitigation | ● neutralization, both paths | ◐ | ● with opt-out | n/a | n/a | n/a |
| Price | $29 target, one-time | $12/yr | $39.95/yr or $99.95 lifetime | $29 one-time + opt. renewal | free 30/mo, then $14/seat/mo | free |

## What's missing, tiered

### Tier 1 - table stakes for any $30 capture tool (every audited paid tool has these)

- **Chosen output folder.** Already spec'd (PR-2). The audit confirms it's also the single hardest-to-copy feature in the Chrome extension space - worth marketing, not just shipping.
- **Filename template with tokens.** CleanShot, FireShot, Monosnap all ship it. Nobody offers URL/domain tokens - a browser-native tool should own `%domain`, `%title`, `%date`, `%counter`. One caution from Monosnap's own docs: title/window tokens can leak sensitive data into filenames - ship the warning with the setting.
- **Format + quality controls in the options page.** PNG/JPEG/WebP with a quality slider. WebP at a quality setting is still not table stakes on Mac (only CleanShot) and matters double here: image size is token budget and context weight for AI assistants. Frame it that way in the UI.
- **After-capture actions as an explicit setting.** The category's central preference: what happens after capture (copy markdown / copy image / save files / open result tab - independently toggleable). CleanShot's multi-action model is the premium pattern. capture-kit's pipeline is currently fixed; making it configurable is mostly options-page work over existing seams.

### Tier 2 - differentiators that justify $30 over the $12 tools

- **Auto-redaction of secrets before the AI paste.** Jam replaces tokens/cookies/PII client-side before upload; Xnapper and Snagit do it with AI on images. For a tool whose whole point is pasting bundles into LLMs, redacting API keys, emails, and bearer tokens from the markdown (and optionally blurring them in the image) is a trust feature that markets itself. Nobody local-first does this.
- **Capture history page.** A simple extension-page library over the output folder (it already holds the files) - searchable list, re-copy any bundle. FireShot gates history behind Pro; Snagit's library is a headline feature. Cheap to build once the FSA handle exists.
- **Token-budget shaping settings.** Truncation lengths, failures-only vs full console, body size caps - exposed, not hardcoded. "Pre-shaped for LLM consumption" is a design position no competitor ships; settings make it legible.
- **Agent trigger + completion event.** Already spec'd (PR-2). FireShot's free JS API is the proof this has demand.
- **MCP / CC bridge.** Already on the punch list. Jam's MCP + SKILL.md shows the direction; local-first version of that is the endgame differentiator.

### Skip - anti-features at this price and positioning

Cloud storage and share links (the subscription competitors' whole moat - don't fight there), full annotation suites (CleanShot won that war; a crop + one arrow maybe, later), video capture (category creep), team seats and workspaces (changes the product), background beautification (Xnapper's identity, wrong buyer).

## Pricing read

$29 one-time is the right call and is itself the differentiator - every bug-capture competitor is subscription or credits, and the cheapest real entry points are $96-600/yr. $29 beats $30 psychologically and matches CleanShot's anchor exactly. Keep a free tier (N captures/mo or screenshot-without-recorder) because Jam free and the OSS MCP servers are $0 and every tool with traction has one. "Lifetime updates for v1" framing preserves a paid v2. GoFullPage clears ~$120k ARR at $12/yr on volume - proof the extension channel pays - but the $30 buyer is Jam's refugee, not GoFullPage's: a solo dev in Claude Code or Cursor who won't make another SaaS account and doesn't want bug data leaving the machine. Lead marketing with local-first, no-account, markdown-in-one-gesture - not capture features.

## Spec deltas made tonight

1. Spike section now cites the Screenity fallback: if Chrome 122+ persistent permission doesn't hold on extension origins, a pinned extension page holding the handle is proven fallback plan B before degrading to Downloads.
2. Out-of-scope section now names PR-3 (filename templates, format/quality, after-capture actions) and PR-4 (redaction, history, budget settings) so PR-2 stays tight for the morning run.

## Suggested PR sequence

- PR-2 (morning, spec'd): output folder + agent trigger. First-of-its-kind on both counts.
- PR-3: the Tier 1 settings - filename tokens, format/quality, after-capture actions, all in one options-page overhaul.
- PR-4: redaction + history + budget shaping - the $30-justifying tier.
- Then the MCP/CC bridge as the flagship.

## Sources

Mac tools: cleanshot.com/pricing, cleanshot.com/changelog, shottr.cc/purchase.html, xnapper.com/pricing, techsmith.com/store/snagit, techsmith.com/learn/tutorials/snagit/preferences-mac/, support.monosnap.com (settings + filename template docs), support.apple.com/guide/mac-help/mh26782.
Chrome extensions: blog.gofullpage.com (automation post), getfireshot.com (enable-advanced.php, changelog, manual.pdf, api.php), support.awesomescreenshot.com (download-location article), help.screenity.io (backups/FSA), developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api, WICG/file-system-access#314, mrcoles.com (GoFullPage method), boringcashcow.com (GoFullPage revenue).
Dev tools: jam.dev/pricing, jam.dev/docs (mcp, cli, devtools), birdeatsbug.com/pricing, marker.io/pricing, bugherd.com/pricing + /feature/mcp, replay.io/pricing, github.com/ChromeDevTools/chrome-devtools-mcp, github.com/AgentDeskAI/browser-tools-mcp, bugreel.io, ybug.io/pricing.
