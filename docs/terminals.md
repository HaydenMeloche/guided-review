# Terminals

Guided Review runs in any terminal with a full-screen mode. A few features depend on what the terminal supports. This page says what each one needs, and how gr behaves without it.

## What gr asks of the terminal

| Feature | Needs | Without it |
| --- | --- | --- |
| 24-bit color | Truecolor support (`COLORTERM=truecolor`) | Theme colors are rounded to the nearest of 256, and diff, popup, and selection backgrounds switch to hand-picked 256-color shades that still read. The theme picker says when this is happening. |
| Its background color | An answer to OSC 11 | The default palette assumes a dark terminal unless `COLORFGBG` says it is light. |
| Shift+Enter for a new line | The kitty keyboard protocol | Use `Ctrl+J`, which every terminal sends. The composer always shows it. |
| An unambiguous Esc | The kitty keyboard protocol | gr waits a moment after Esc to tell it from an Alt chord. |
| Window title and restoring yours on exit | XTWINOPS 22/23 (title stack) | The title is set but not restored. |
| Progress in the tab or taskbar | OSC 9;4 | No progress indicator. gr only sends it to terminals known to read it. |
| Copy (`Y`) over SSH | OSC 52 | Nothing is copied, and gr can't tell: it says it asked the terminal to copy. |

When it starts, gr asks the terminal for its background color, so the default palette's diff tints and popups are light on a light terminal and dark on a dark one. Set `NO_COLOR` to turn colors off entirely: gr keeps bold, dim, and inverse, and ignores any theme.

gr asks the terminal whether it speaks the kitty keyboard protocol when it starts, and turns it on when the terminal says yes. If a terminal answers wrongly, set `GR_KITTY_KEYBOARD=disabled` (or `enabled`) to override the detection.

gr repaints only the rows that change on each key press, which keeps tmux and SSH sessions from flickering.

## Known terminals

The matrix below is what each terminal is documented to support. Rows marked *to verify* have not been checked by hand against gr yet; if you try one, the notes are where a difference would show.

| Terminal | Truecolor | Kitty keyboard (Shift+Enter) | Title stack | Progress (OSC 9;4) | Clipboard (OSC 52) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Ghostty | yes | yes | yes | yes | yes | *to verify:* progress shows on the tab. |
| iTerm2 3.6+ | yes | yes (3.5+) | yes | yes | yes, once allowed in Preferences | Before 3.6, OSC 9 is a notification, so gr sends no progress there. |
| WezTerm | yes | yes | yes | yes | yes | *to verify* |
| kitty | yes | yes | yes | not sent | yes | *to verify:* whether kitty reads OSC 9;4. |
| Terminal.app | no (256 colors) | no | ignored | no | no | Use `Ctrl+J` for new lines. A light profile gets light diff tints. |
| VS Code terminal | yes | no | ignored | no | yes | Use `Ctrl+J` for new lines. |
| Windows Terminal | yes | no | partial | yes | yes | *to verify* |
| tmux | needs `set -as terminal-features ',*:RGB'` | passes through when the outer terminal supports it | needs `set -g set-titles on` | not sent | needs `set -g set-clipboard on` | *to verify:* no flicker with large screens. |
| SSH to Linux | as the client | as the client | as the client | not sent | the only way to copy; `Y` says so | `o` can't open a browser on the remote machine. |

## tmux

Add these lines to `~/.tmux.conf` so gr's colors, titles, and copy work inside tmux:

```tmux
set -as terminal-features ',*:RGB'
set -g set-titles on
set -g set-clipboard on
```
