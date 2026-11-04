# The keystrokes for the demo of a gr tutor tour. Run scripts/demo.sh (pnpm demo:record),
# which renders this and turns it into the README GIF and the website WebP.
# It runs this checkout with pnpm dev, so it records the current code, not the installed gr.

Output docs/images/demo.gif
# A video that scripts/demo.sh turns into docs/images/demo.webp for the website,
# and the Screenshot stills below, which it turns into docs/images/briefing.webp and ask.webp
Output .scratch/demo.mp4

# 2240x1260 at font size 20 keeps the same ~150-column layout as 1600x900 at 14,
# but with sharper text when the README scales it down.
Set Shell zsh
Set FontSize 20
Set Width 2240
Set Height 1260
Set Padding 24
Set Framerate 30
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

# Open the sample tour from this checkout and skip the lessons
Hide
Type "pnpm -s dev tutor"
Enter
Sleep 6s
Escape
Sleep 1s
Show

# The briefing, also the website's still of it
Sleep 2500ms
Screenshot .scratch/briefing.png

# Read through the first hunks to the pricing one
Type "n"
Sleep 2500ms
Type "n"
Sleep 2500ms
Type "n"
Sleep 2s

# Ask "Who can use STAFF50?", one of the demo's prepared questions
Type "a"
Sleep 1500ms
Type "1"
Sleep 7s
Screenshot .scratch/ask.png
Escape
Sleep 1s

# Comment on the STAFF50 line, referencing discountAmount with @
Type "jjjjjjjjj"
Sleep 1s
Type "c"
Sleep 1s
Type@35ms "Anyone can use STAFF50 for 50% off, since "
Type "@discountAm"
Sleep 1500ms
Enter
Sleep 500ms
Type@35ms " never checks who the customer is."
Sleep 1s
Enter
Sleep 2s

# Open submit, request changes, and write a summary, stopping before posting
Type "s"
Sleep 2s
Type "r"
Sleep 1500ms
Type "w"
Sleep 1s
Type@35ms "One blocker: the staff code is public."
Sleep 4s

Hide
Escape
Escape
Type "Q"
