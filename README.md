# North Pole Control

The family Christmas manager. A Raspberry Pi sits by the tree and the TV and runs everything:
the tree lights, the TV, Alexa, and the party games. The iPad is the remote; everyone's phone is a game buzzer.

```
iPad (control center)  ─┐                         ┌─> tree lights (pixel string on the Pi's SPI pin)
family phones (/play)  ─┼─> Raspberry Pi server ──┼─> TV over HDMI (kiosk at /tv, turned on with HDMI-CEC)
Alexa (voice)          ─┘   ws + http :47925      └─> Echo (music, announcements, pause for games)
```

## What it does

**The tree**
- 16 hand-built light effects (Classic Warm, Retro C9, Candy Cane, Snowfall, Fireplace, Aurora, Comets…), one-colour fills, brightness, on/off schedule.
- **Light shows:** 13 public-domain carols played by a live synth on the TV while every note lights the tree: low notes at the bottom, high notes at the top, chords change the colour, karaoke lyrics on the TV.
- **Music mode:** the tree dances to Christmas radio on the TV (SomaFM's five Christmas channels), or to anything in the room through the iPad's microphone (including the Echo).
- **Paint the tree:** draw on the tree on the iPad with the Pencil and the real lights follow.
- **Camera mapping:** the iPad lights each bulb one at a time and finds it, so every effect follows your real tree.
- Works with: addressable pixel strings on the Pi (best), a WLED controller, or your existing plain string lights through the beat-lights Arduino (dimming only). See `docs/HARDWARE.md`.

**The TV**
- Home screen with the sleeps-until-Christmas count and the tree, a real-time Yule log with crackle, a giant countdown,
  the **Santa tracker** (a night globe; on Christmas Eve Santa visits 180 cities as midnight crosses the world; preview it any time),
  today's advent door, now playing, messages ("Cookies are out of the oven!").
- The Pi turns the TV on and switches to itself (HDMI-CEC).

**Games (board on the TV, everyone plays on the iPad: no phones needed)**
- Add the family once in Games → Players (name + team colour); they're remembered.
- **Trivia Showdown:** 200 questions. The iPad goes around: "Grandma's turn", she taps her answer in secret, it says who's next. The tree flashes the winning team's colour.
- **Name That Song:** Alexa plays a real Christmas hit (93 songs). Everyone's name is a big buzzer on the iPad; first to slap theirs pauses Alexa and picks the title. Without Alexa it uses the carols.
- **Would You Rather:** 70 dilemmas; tap A or B for each person; the tree splits red and green to show the room.
- **Pictionary:** take turns drawing on the iPad with the Pencil (only the drawer sees the word), the TV shows the drawing live, everyone guesses out loud, tap who got it.
- **Charades:** iPad or phone on your forehead, tap or tilt.
- Phones are optional: flip "Let people with phones play on their own phone too" and they scan the QR code.

**Fun**
- Joke machine (180 jokes, drumroll, rimshot, Alexa can read them), Nice List Scanner (iPad camera, the tree sweeps green, the TV stamps them NICE with their elf name), elf names, a 25-day advent calendar with a light show per day, private Secret Santa draw revealed on each phone.

**Alexa**
- Control your Echo from the iPad: play any music by typed command, pause/next/volume, announcements ("Santa says hi").
- **"Alexa, turn the Christmas Tree red" / "turn on Light Show" / "turn on Yule Log"**: the Pi shows up as smart lights, no setup.
- **The North Pole skill:** "Alexa, ask North Pole for a joke", "…where is Santa", "…start trivia". Setup in `docs/ALEXA.md`.
- Scenes: Showtime, Party, Cozy, Goodnight (Alexa says goodnight, the tree glows, then turns off).

## Use it
1. Open the control center on the iPad: `http://<pi-address>:47925/` (or your Tailscale HTTPS address, needed for the camera and mic) → Share → Add to Home Screen. The TV's "iPad setup code" screen shows a QR code for it.
2. Lights tab: tap an effect or a scene. Music tab: Light shows / radio / Alexa. Games tab: start a game, everyone scans the code on the TV.
3. Setup tab: number of lights, which output (Pi pixels / WLED / plain lights), camera mapping, schedule, home city for Santa.

## Run it
- PC (testing): `start-christmas-manager.cmd` → http://localhost:47925
- Pi (for real): `pi\trust-pc.ps1` once, then `pi\deploy.ps1`. It installs Node, the LED driver, the TV kiosk and the services.
- Everything is plain Node 18+ and browser JavaScript with no build step. Dependencies: `alexa-remote2` (Echo control) and `qrcode-generator`.
