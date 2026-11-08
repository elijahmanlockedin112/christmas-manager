# North Pole Control: Fun Ideas

30 ideas, then a ranked Top 8. All work with ONE iPad + TV + tree + Alexa. No phones.
Effort: S = under a day, M = 1-3 days, L = a week+. Photos stay on the Pi, never sent out (AI gets text only, unless noted).

---

## Top 8 to build next

1. **Elf Report Card** (#1): Haiku roasts and toasts each person from a quick quiz; Alexa reads it. Instant laughs, tiny build.
2. **Santa's Mad Libs** (#2): the iPad hands out blanks, Haiku writes a wild Christmas story, the TV and tree perform it. Every age can play.
3. **Midnight Santa Cam** (#14): Christmas Eve ritual. Tree, TV and Alexa react as Santa "arrives". Builds on the existing tracker.
4. **Photo Ornament Tree** (#21): the Nice List photos become ornaments on a TV tree, kept as a yearly family record. Local only.
5. **Draw It, The Tree Plays It** (#8): after each Pictionary round, the drawing's strokes replay as a light show on the tree. Reuses Pencil and paint-the-tree, tiny build.
6. **Stocking Stumper** (#5): grandparents and kids write clues about family history; Haiku makes a trivia round about THEM. Personal beats generic.
7. **Light Duel** (#11): two teams each "conduct" half the tree with iPad taps to a carol; best rhythm wins. Pure tree magic, no AI risk.
8. **Present Opening Director** (#16): Christmas morning mode. Tap "Next gift", the tree flashes, Alexa announces, a cheer meter and TV caption tracks the pile.

---

## A. Pass-the-iPad party games

**1. Elf Report Card** (AI, S)
Everyone answers 5 silly taps ("Pick: cocoa or cider", "Sock or slipper") plus one typed or Pencil-written line. Haiku writes a one-paragraph "report card from the North Pole" per person, with grades like "Cookie Theft: A-". The TV shows the card, the tree sweeps their team colour, Alexa reads it aloud. Fun: gentle roasting, grandparents love hearing theirs. Tech: Haiku, TV scene, Alexa announce, overlay sweep. Risk: keep roasts kind, add a "gentle mode" prompt, block anything about weight, age or appearance.

**2. Santa's Mad Libs** (AI, S)
iPad asks each player for one word ("a smelly noun", "a verb ending in -ing"). Haiku writes a 60-second Christmas story using them. TV types it out karaoke style, tree flashes on each ridiculous word, Alexa reads the finale. Fun: it's always funny, zero skill needed. Tech: Haiku, TV text scene, karaoke highlighter, overlay burst. Risk: AI can slip in edgy words; use a content filter on input and output.

**3. Reindeer Rodeo / Sleigh Tilt** (M)
Tilt-to-steer on the iPad: pass it, each person flies Santa's sleigh through a TV obstacle course for 20 seconds. Tree shows speed as chasing comets; crash flashes red. Fun: quick turns, high score board, kids vs grandparents. Tech: device motion, TV canvas, effects engine. Risk: iOS needs a motion permission tap; keep a touch-slider fallback.

**4. Snowball Showdown** (M)
Flick-to-throw on the iPad at targets on the TV (a snowman, Uncle's face-less cutout, a cookie). Hits splash white on the tree. Turn timer, passing the iPad. Fun: physical, loud, quick. Tech: touch flick, TV canvas, overlays. Risk: balancing swipe speed; keep it forgiving.

**5. Stocking Stumper** (AI, M)
Before dinner each person types or Pencil-writes 2 facts about themselves ("I once broke my arm on a trampoline"). Later Haiku builds a "Who said it?" round: the TV shows the fact, the iPad passes around, everyone taps a name. Fun: reveals family stories, grandparents' lore becomes game content. Tech: Haiku (to rewrite facts anonymously and add decoys), games engine, tree flashes. Risk: data stays on Pi; embarrassing facts, add a "veto" tap.

**6. Wrong Gift Wrap** (AI, S)
The iPad shows a random household object name (Haiku-generated, e.g. "a garden gnome"). The player has 15 seconds to describe it as the world's greatest Christmas gift in a pitch, spoken into the iPad mic. Transcript goes to Haiku, which scores it for "salesman energy" with a ridiculous verdict. Fun: improv comedy. Tech: iPad mic (browser speech recognition), Haiku, TV. Risk: speech recognition on Safari is flaky; allow typing fallback.

**7. Carol Karaoke Duel** (M)
Two players sing a karaoke show; the iPad mic measures pitch match on the vocal line, the TV shows a score and the tree grows brighter with accuracy. Fun: grandparents who sing, teens who pretend not to. Tech: existing karaoke shows, WebAudio pitch detection. Risk: noisy room, Echo speaker bleed; mute the synth melody on the vocalist round.

**8. Draw It, The Tree Plays It** (S-M)
Pictionary round ends with a replay: the drawing's strokes play back on the tree (mapped to vertical position and stroke colour). Fun: everyone's squiggle becomes a mini light show. Tech: Pencil strokes, paint-the-tree engine, camera mapping. Risk: low.

**9. Gift Swap Chaos Dice** (S)
Run the classic "pass the present right/left" gift-swap game with a TV narrator: Haiku writes the story ("Everyone pass left, except anyone wearing red"), Alexa reads it, tree flashes on each swap. Fun: fixes the awkward host-reads-the-story problem. Tech: Haiku, Alexa, tree overlays. Risk: low.

**10. Cookie Judge** (AI + camera, M)
Photograph each plate of cookies with the iPad. Haiku-vision rates them with absurd categories ("Structural integrity", "Sprinkle diplomacy") and crowns a champion. Fun: bakers get roasted lovingly, grandma wins. Tech: iPad camera, Haiku vision (photo sent to API). Risk: this sends photos of food externally; only food photos, never people, with a clear "no faces" prompt and a toggle. Alternatively do local-only rating with random jokes.

## B. Light-show and tree magic

**11. Light Duel** (M)
Two teams split the tree (left/right or top/bottom). During a carol, notes are marked on the iPad as big tap pads; each team taps in rhythm to light their half. Best streak wins; the tree finale explodes in the winner's colour. Fun: obvious feedback, physical. Tech: karaoke note timeline, split overlay, iPad touch. Risk: touch latency; use generous timing windows.

**12. Name the Lights** (S)
Say "Alexa, ask North Pole to sparkle for [name]" and the tree does a signature animation for each family member (stored). Fun: kids love their own colour. Tech: Alexa skill, effect presets per player. Risk: low.

**13. Weather Tree** (S)
Tree matches Georgia weather: snow for cold nights, rain pulses, a lightning flash when the forecast says storm, Alexa says "It's 34 and Santa-friendly". Fun: practical magic. Tech: weather API, effects engine, Alexa announce. Risk: needs an API; free ones exist.

**14. Midnight Santa Cam** (M)
Christmas Eve ritual. At a family-chosen time, the TV goes dark, the tree dims, sleigh bells play on the Echo ("Alexa announces: Santa has entered Georgia"). The globe zooms, the tree flickers like a rooftop landing, the TV shows a "cookies detected" check mark with a note. Fun: kids go bananas. Tech: Santa tracker, Alexa announce, tree effects, advent scene. Risk: timing and Alexa volume; test early with a dry-run button.

**15. Wish Wall** (S)
Each person writes a wish with the Pencil, it floats up the TV like a star and the matching tree height lights up. Fun: sweet, shareable. Tech: Pencil, TV scene, tree sweeps. Risk: low.

## C. Christmas Eve and Christmas morning rituals

**16. Present Opening Director** (S)
Christmas morning scene: big "Next gift" button on the iPad. Each tap fires a burst on the tree, a jingle on the TV, a counter ("Gift 14 of 37"), and Alexa cheers. A "chaos" button throws confetti. Fun: turns a messy morning into a show. Tech: TV scene, overlays, Alexa. Risk: low.

**17. Reindeer Food Ceremony** (S)
Kids drop "reindeer food" on the iPad (tap-sprinkle); the tree sparkles for each tap and by 10 taps "Rudolph's nose" glows red on the top pixel. Fun: kid rite of passage. Tech: touch, tree top pixels. Risk: low.

**18. Cookies and Milk Checklist** (S)
Little kids tap a checklist on the TV (milk poured, carrots out, tree lit). When all done, bells play and the tree goes to a calm "sleep" glow. Fun: structure for bedtime excitement. Tech: TV scene, Alexa lullaby request. Risk: low.

**19. Letter to Santa, Delivered** (AI, M)
A kid writes or draws on the iPad with the Pencil; the TV "sends" it up the globe to the North Pole with a tree swoosh; Santa replies the next morning with a Haiku-written kid-safe note read aloud by Alexa. Fun: magic. Tech: Pencil, Haiku, Alexa, scheduled morning scene. Risk: Haiku tone must be kind and non-promising about presents; prompt guardrails, parent review option.

**20. Elf Scouting Report on Parents** (AI, S)
Kids tell the iPad two things a parent did all year. Haiku writes a funny "nice list review" with a verdict. Alexa reads it. Fun: kids get to roast parents safely. Tech: Haiku, TV, Alexa. Risk: use gentle mode, parent can preview.

## D. Photos and camera (local only)

**21. Photo Ornament Tree** (M)
Nice List Scanner photos become circular ornaments on a big TV tree, one per person per year. Tapping an ornament shows the year. Keep it as a yearly archive. Fun: sentimental, grandparents will love it. Tech: existing scanner, local file storage, TV scene. Risk: privacy; stay on-device, add delete-all.

**22. Santa Hat Booth** (S-M)
iPad camera with fun overlays (hat, beard, antlers) placed with simple face detection (browser FaceDetector is Safari-limited, use draggable overlays). Photo flashes the tree. Fun: family photos. Tech: camera, canvas, local save. Risk: low.

**23. Ugly Sweater Judging** (AI/local, S-M)
Photograph each sweater, then everyone votes via iPad passing with a "judging panel" voice from Alexa. No AI vision needed; Haiku writes the award categories text only. Fun: contest with trophies. Tech: camera, Haiku text, Alexa. Risk: none for faces.

**24. Family Time Capsule** (S-M)
Each person says a one-liner into the mic: "My wish for next year." Saved as local audio; replays next Christmas on the TV. Fun: emotional payoff. Tech: iPad mic, local storage, TV. Risk: storage; keep files small, back up.

## E. Alexa voice and AI

**25. Ask Santa** (AI, M)
Press-and-hold on the iPad, ask Santa anything; Haiku answers in character as Santa, Alexa reads it in a booming voice, tree flickers while "he" talks. Fun: kids can ask forever. Tech: mic, speech-to-text, Haiku, Alexa announce. Risk: must stay kid-safe, no real promises about presents, strict system prompt, log locally.

**26. Alexa Carol Roulette** (S)
Say "Alexa, ask North Pole to spin the wheel": tree wheel spins on pixels, lands on a pixel colour that picks a carol or activity (karaoke, trivia, joke). Fun: decides what to do next. Tech: Alexa skill, effects engine. Risk: low.

**27. Grandma's Story Hour** (AI, M)
Pick a theme; Haiku writes a short bedtime story with the family's names as characters; Alexa reads it while the tree and TV do mood lighting for each scene (storm, forest, snow). Fun: kids fall asleep happy. Tech: Haiku, Alexa announce chunks, TV, tree scenes. Risk: Alexa's text-to-speech length limits; chunk into short parts.

## F. Competition and long-running

**28. Family Points Leaderboard** (S)
Every game adds points to each person; a yearly leaderboard sits on the home TV. Final night: trophy ceremony with tree fireworks. Fun: bragging rights. Tech: existing player storage, TV. Risk: hurt feelings; add a "kids' bonus" handicap toggle.

**29. Secret Mission Cards** (AI, M)
iPad hands each person a secret silly mission ("Get Dad to say 'fa la la' three times"). Haiku generates them and tracks via honor-system taps; reveal at the end on the TV with the tree flashing for completed ones. Fun: spreads through the whole evening. Tech: Haiku, games engine, TV. Risk: keep missions harmless and non-embarrassing.

**30. Countdown Chaos Hour** (S)
A 60-minute automatic party mode: the system cycles games, light shows, Alexa jokes and short dance breaks, with the iPad prompting "Everyone freeze!" and the tree lights going dark. Fun: a host in a box. Tech: scenes scheduler, tree, Alexa, games. Risk: needs a clean pause/skip control on the iPad.

---

## Notes on risk
- **AI safety**: all Haiku prompts need a kid-safe system prompt, input and output filter, and a "gentle mode" default.
- **Photos**: stored on the Pi only. Only #10 would send images out, and only food; default it to off.
- **Alexa**: speech length and volume limits; always include a dry-run button.
- **Cost**: Haiku calls are tiny. Cache stories and cap daily calls.
