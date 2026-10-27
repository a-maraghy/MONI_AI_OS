# MINT Library

A static site of shared videos in folders, served by nginx at **https://library.mint-stack.com**
from `/var/www/library`. There is no login. Anyone with a link can watch, and every page is `noindex`.
The first folder is **Pre-read**.

The site makes no external requests: no CDN, no web fonts from elsewhere and no analytics. It uses
the MINT OS "Plain label" look: black and white, Atkinson Hyperlegible Next and Mono (copied from
`dashboard/public/fonts`), and it follows the system's light or dark setting. The player is dark in
both themes.

## Where things live

| What | Where |
|---|---|
| Code, templates, the player | this folder (in the repo) |
| Manifest (folders + videos) | `/var/lib/mint-library/library.json`, outside the repo because it is data. A `.bak` of the previous version is kept next to it. |
| Published site | `/var/www/library` (`index.html`, `assets/`, `<folder>/`, `<folder>/<slug>/`, `embed/<slug>/`) |

You can override these with the environment variables `MINT_LIBRARY_MANIFEST`, `MINT_LIBRARY_ROOT`
and `MINT_LIBRARY_URL`, which is useful for testing in a scratch folder.
Video files and generated media never go into the repo.

## Commands

```sh
# Add or update a video. It encodes, makes the poster and thumbnails, updates the manifest and rebuilds the pages.
python3 library/add.py --folder pre-read --title "Title" --desc "One paragraph." \
    [--date YYYY-MM-DD] [--captions captions.vtt] [--poster poster.jpg] [--slug custom-slug] [--force] video.mp4

# Remove a video. This deletes its folder and embed and rebuilds the pages.
python3 library/add.py --remove <slug>

# Rebuild every page from the manifest, for example after changing the player or the templates.
python3 library/build.py

# Captions from a film timeline (the agents-film timeline.json + words.js format).
python3 library/tools/timeline_to_vtt.py timeline.json words.js > captions.en.vtt
```

- **Slug.** The slug comes from the title. If you run the tool again with the same title, it updates
  that entry and does not add a second one.
- **Re-encoding.** The renditions are re-encoded only when the source file's sha256 changes or when
  you pass `--force`.
- **Unique slugs.** Slugs are unique across the whole library, because the embed URL is `/embed/<slug>/`.
- **New folders.** `--folder <slug>` creates the folder if it does not exist yet. `--folder-title`
  names it.
- **Folder order.** `order` in the manifest sets the order on the home page. Pre-read is first.

## What add.py makes for each video

The files go in `/var/www/library/<folder>/<slug>/`.

- **Renditions.** `1080p.mp4`, `720p.mp4` and `480p.mp4`. The top rendition is the source height
  when the source is shorter than 1080, and nothing is ever upscaled. The encoding is H.264 High and
  AAC with `+faststart` and a keyframe every 2 s on the same grid in every rendition, so switching
  quality lands cleanly. The CRF and maxrate per rendition are 21 / 6 Mbit/s, 22 / 3.5 Mbit/s and
  23 / 1.6 Mbit/s.
- **Posters.** `poster.jpg` (up to 1280 wide, also used as og:image) and `poster-640.jpg` (for the
  cards). They come from `--poster`, or from a frame at 10 % of the video.
- **Seek previews.** `thumbs.jpg` is a sprite of up to 100 tiles of 160 px, one every
  max(2 s, duration/100). `thumbs.vtt` maps each time range to a tile with `#xywh`.
- **Captions.** `captions.<lang>.vtt`, when `--captions` is given.
- **Permissions.** Files are 0644 and folders 0755, because nginx runs as www-data.

## Pages (build.py)

- **`/`** lists the folders with a cover and a video count.
- **`/<folder>/`** shows a grid of cards: poster, duration badge, title, date, length and a
  two-line description.
  - The **Sort** control offers Newest first (the default), Oldest first, Title A–Z and Longest.
    The choice is kept in `?sort=` and in localStorage, and the URL wins.
  - **Search** matches title and description words and is kept in `?q=`. There is an empty state
    for no matches and one for an empty folder.
- **`/<folder>/<slug>/`** has the player, title, date, length and description.
  - **Copy link** and **Copy embed code** copy the page URL and an `<iframe>` snippet.
  - **Download** is a menu with one link per quality.
  - **More in <folder>** lists the other videos.
- **`/embed/<slug>/`** shows the player alone, filling its frame. Use it in an iframe.

Every page has a `<title>`, a description, Open Graph tags and `robots` noindex. The Open Graph tags
are og:title, og:description, an absolute og:image with its size and alt text, og:video (the 720p
MP4), video:duration and a twitter card. Every page also has the MINT M monogram as its favicon.
Asset URLs carry a content hash (`?v=`), so a rebuild is picked up at once.

## The player (`player/player.js`, `player/player.css`)

The player is vanilla JS with no dependencies and is shared by the video and embed pages. Without
JS, the browser's own controls stay.

- **Picture.** A big Play button sits over the poster. When there is a saved position, it reads
  "Resume from 1:23", with a "Start from the beginning" chip.
- **Click and tap.** Click or tap to play or pause. Double-click or double-tap the middle for full
  screen. On touch, double-tap the left or right third to skip 10 s back or forward.
- **Seek bar.** It shows the buffered ranges and, on hover or drag, the time with a thumbnail from
  the sprite. It works with the mouse and touch. It is a focusable `role="slider"`: arrows move 5 s,
  PageUp and PageDown move 10 s, and Home and End go to the start and end.
- **Controls.**
  - **Time:** played / total. Click it to show the time left.
  - **Volume:** a slider and a mute button.
  - **Speed:** 0.5 to 2×.
  - **Quality:** Auto, 1080p, 720p and 480p, only the renditions that exist.
  - **Also:** CC, picture in picture (including Safari's `webkitSetPresentationMode`) and full screen
    (the container, with `webkitRequestFullscreen`, and `video.webkitEnterFullscreen()` on iPhone).
- **Settings menu.** The gear opens Speed, Quality and Captions, plus Keyboard shortcuts. Use the
  arrows to move, → or Enter to open a submenu, and ← or Esc to go back.
- **Quality switching.**
  - **Warm-up:** the new file is first warmed in a hidden `<video>`.
  - **Swap:** the same `<video>` then takes the new `src`. Its current frame is held on a canvas
    during the swap.
  - **What carries over:** the position, play or pause state and speed.
  - **Auto:** Auto picks by player width × devicePixelRatio, capped by `navigator.connection`
    (saveData, effectiveType and downlink). It steps down one rendition after 3 stalls in 30 s.
  - **Label:** the label reads "Auto (720p)".
- **Captions.**
  - **Loading:** captions are fetched and given to the `<track>` as a blob, so the server's content
    type does not matter.
  - **Display:** the player draws them itself, above the controls.
  - **iPhone:** in native full screen on iPhone, the track is shown natively.
  - **Default:** captions are off unless you turned them on before.
- **Keyboard.**
  - **Play and seek:** Space or K play / pause. J / L skip −10 / +10 s. ← / → skip −5 / +5 s.
    0–9 jump to 0–90 %.
  - **Sound and speed:** ↑ / ↓ change the volume, M mutes, and < / > change the speed.
  - **Views:** F is full screen, C is captions, I is picture in picture, ? shows the shortcuts and
    Esc closes.
  - **When they are ignored:** keys do nothing while you type in a field. Space and Enter are left
    to a focused link or button elsewhere on the page. The keys act only while the player is on
    screen.
- **Controls auto-hide** after 2.5 s of no mouse movement while playing. They stay while paused,
  while the menu is open and while a control has keyboard focus.
- **Memory.** The position is saved per video every 5 s and on pause or leaving the page, and it is
  cleared at the end. Volume, mute, speed, quality choice and captions are remembered too. The keys
  are `mintlib:*` in localStorage. `?t=83`, `?t=1m23s` or `#t=1:23` start at a time.
- **States.** The player shows a loading spinner, an error panel with "Try again" (it reloads at the
  last good position), and an end panel with "Replay".
- **Accessibility.**
  - **Controls:** controls are real `<button>`s with labels that name their key. The slider has
    aria-valuetext ("1 minute 23 seconds of 3 minutes 13 seconds").
  - **Focus and touch:** there is one visible focus ring, and touch targets are 44 px.
  - **Announcements:** a polite live region announces quality, speed, volume, mute and caption
    changes.
  - **Motion:** `prefers-reduced-motion` turns off the animation.
- **Media Session metadata** gives the lock-screen title and artwork.

## Content so far

| Folder | Slug | Title | Date |
|---|---|---|---|
| pre-read | `allocate-meets-matrix` | AlloCate meets Matrix | 2026-10-27 |

The source was `/root/moni/docs/allocate_film/AlloCate_meets_Matrix_EN.mp4`, the final render of
2026-10-27 06:37. Its captions were made from the film's own `player/timeline.json` + `words.js`.
The film also has its captions burned in, which is why CC starts off.
