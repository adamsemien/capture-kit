# capture-kit

Chrome extension for one-shot full-page captures plus console & network failure bundles, built for AI-assisted coding. All output lands in `~/Downloads/capture-kit/`.

## AI agent bridge

Every bundle capture also overwrites two stable-name files: `capture-kit/latest.md` (the bundle markdown, whose `Image:` line names the archived timestamped screenshot) and `capture-kit/latest.jpg` or `latest.png`. Tell your coding agent once — for example: *"When I say 'check my capture', read `~/Downloads/capture-kit/latest.md` and the image file sitting next to it in that folder, then act on what you see."* — and it will always get the newest capture without you pasting anything.
