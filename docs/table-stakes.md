# Table stakes for Capture Kit

This file lists what every capture tool for AI review needs before anyone takes it seriously. A feature PR checks itself against this list and names any item it skips, with the reason.

The list was built on 2026-11-27 from the feature pages of CleanShot X, Polypane and Jam. Chrome DevTools MCP and Playwright MCP were added for the agent side. An item is here when at least two of them have it, or when Capture Kit's job needs it.

Status: **Have** = shipped. A ticket number means planned. **n/a** = left out on purpose.

## Capture

| A person or agent can... | Status |
|---|---|
| Capture the whole page, including panels that scroll inside the page | Have |
| Capture only what is on screen | Not verified - check the popup's image-only mode in NOBC-363 |
| Capture one element or a dragged area | Later - NOBC-369 |
| Capture several widths in one go | Have (375, 768, 1440). iPhone 390 in NOBC-304 |
| Capture in light and dark, and with reduced motion | NOBC-304 |
| Open every collapsed section before capturing | NOBC-304 |
| Set a delay before the capture, to catch hover menus | NOBC-367 |
| Record a short clip of a tab | Have |
| Keep the last minute or two, to catch a bug after it happened | Later - NOBC-369 |
| Capture many tabs into one folder with an index | Have |

## Context with the image

| A person or agent can... | Status |
|---|---|
| See console errors and failed network calls, mapped to source | Have |
| See the URL, size, zoom, and whether it is local or live | Have |
| See the clicks and key presses that led up to it | NOBC-365 |
| See sideways scroll, contrast failures and missing labels | NOBC-365 |

## Privacy

| A person or agent can... | Status |
|---|---|
| Trust that secrets in the report are hidden | Have |
| Trust that password fields and secrets on the image are blurred | NOBC-363 |
| Use it with no account and no server | Have |

## Hand-off

| A person or agent can... | Status |
|---|---|
| Copy the image, the report, or both | Have |
| Save to a chosen folder, with a stable latest file | Have |
| Pick PNG or JPEG | Have |
| Change the shortcuts | Have |
| Fire a capture from code and get the result back | Have (in-page event). Proper connector in NOBC-364 |
| Mark up a capture with arrows, boxes and text | Later - NOBC-369 |
| Browse earlier captures | Later - NOBC-368 (gallery) |
| Compare two captures with the differences marked | NOBC-366 |
| Share a link to a capture | NOBC-368 builds a report page. No Capture Kit server, by design |
| Send a capture to Linear, GitHub or Slack | Later - NOBC-369 |
| Read the text in an image (OCR) | n/a - the AI reads the image itself |
