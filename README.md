# ahcheng91-taste-one

A single-file, procedural food painting: a close overhead view of a ramen bowl on a dark stone
table. The frame holds an amber broth with floating oil, a coiled nest of pale golden noodles, two
jammy egg halves, three glossy chashu slices, a sheet of nori, scallions, sesame, chili threads, a
ceramic spoon, a pair of chopsticks, and a few soft wisps of steam.

Everything is drawn from signed distance fields and seeded value noise into an RGBA buffer at
2048×2048, box-downsampled to 1024×1024, then encoded as PNG with `node:zlib` and a small CRC32
implementation. There are no fonts, images, canvases, dependencies or network calls, and the same
bytes are produced on every run.

Render it with:

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/entry.png` (1024×1024, under 1 MiB) together with `out/stage2.png`,
`out/stage4.png` and `out/stage6.png` review frames, and prints sampled RGB values for the rim,
broth, egg white, yolk, chashu and steam.

[![make.fun · the-picture-that-tastes-of-one-20261122-2047](https://make.fun/badge/the-picture-that-tastes-of-one-20261122-2047.svg)](https://make.fun/bounty/the-picture-that-tastes-of-one-20261122-2047?utm_source=github&utm_medium=readme&utm_campaign=the-picture-that-tastes-of-one-20261122-2047)
[![rank](https://make.fun/badge/the-picture-that-tastes-of-one-20261122-2047/AhCheng91/ahcheng91-taste-of-one/rank.svg)](https://make.fun/bounty/the-picture-that-tastes-of-one-20261122-2047/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=the-picture-that-tastes-of-one-20261122-2047)
[![reward](https://make.fun/badge/the-picture-that-tastes-of-one-20261122-2047/AhCheng91/ahcheng91-taste-of-one/reward.svg)](https://make.fun/bounty/the-picture-that-tastes-of-one-20261122-2047?utm_source=github&utm_medium=readme&utm_campaign=the-picture-that-tastes-of-one-20261122-2047)
