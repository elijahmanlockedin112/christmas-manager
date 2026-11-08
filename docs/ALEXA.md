# Alexa setup

Two ways to talk to the North Pole. Part 1 needs no accounts. Part 2 adds jokes, Santa tracking, games and more.

## Part 1: Voice control with no setup

The Pi pretends to be a Philips Hue bridge. Your Echo finds it on your home Wi-Fi. Nothing leaves your house.

You get 7 devices: Christmas Tree, Light Show, Yule Log, Party Mode, Christmas Radio, Showtime, Goodnight Tree.

### Before you start

1. The Pi and the Echo must be on the same home Wi-Fi or network. Not Tailscale, not a guest network.
2. The Hue emulator must use port 80. On the Pi, run the app as root, or give Node permission once:
   `sudo setcap cap_net_bind_service=+ep $(which node)`
3. On the Pi the emulator turns on by itself. On Windows it is off unless you set `XM_HUE_PORT=80`.

### Discover the devices

1. Make sure the Christmas Manager is running on the Pi.
2. Say: "Alexa, discover devices".
3. Wait about 45 seconds. Alexa says it found 7 new devices.
4. If you prefer the app: Alexa app, Devices, plus icon, Add Device, Light, Philips Hue, then follow the prompts. No button press needed.

### Phrases that work

1. "Alexa, turn on the Christmas Tree"
2. "Alexa, turn off the Christmas Tree"
3. "Alexa, set the Christmas Tree to red" (any color)
4. "Alexa, set the Christmas Tree to 40 percent"
5. "Alexa, turn on Light Show" (plays a random song show)
6. "Alexa, turn off Light Show" (stops it)
7. "Alexa, turn on Yule Log"
8. "Alexa, turn on Party Mode"
9. "Alexa, turn on Christmas Radio" / "turn off Christmas Radio"
10. "Alexa, turn on Showtime"
11. "Alexa, turn on Goodnight Tree"

### Make an Alexa routine ("Alexa, it's Christmas")

1. Open the Alexa app. Tap More, then Routines, then the plus icon.
2. Tap "Enter routine name" and type: It's Christmas.
3. Tap "When this happens", then Voice, then type: it's Christmas. Tap Next.
4. Tap "Add action", then Smart Home, then All Devices.
5. Pick Showtime, choose Power On, tap Next.
6. Optionally add a second action: Christmas Tree, Power On.
7. Tap Save.
8. Say "Alexa, it's Christmas".

You can also use Showtime or Goodnight Tree as a routine action at a set time (for example, Goodnight Tree at 10 pm).

### If Alexa cannot find the devices

1. Check the Pi log for a line starting with `[hue] bridge`. If it says disabled, set `XM_HUE_PORT=80`.
2. If it says EACCES, redo the `setcap` step above and restart the app.
3. Open `http://<pi-ip>/description.xml` in a phone browser on the same Wi-Fi. You should see XML.
4. Some routers block device-to-device traffic ("client isolation" or "AP isolation"). Turn that off.
5. Echo devices cache the old list. In the Alexa app, remove the old devices, then say "Alexa, discover devices" again.
6. Say "Alexa, discover devices" once more. It sometimes takes two tries.

## Part 2: The North Pole skill

A custom skill lets you ask for jokes, Santa's location, the countdown, games, the advent calendar, and elf names. It is private to your Amazon account. You do not publish it to the Alexa store.

### How it connects

Amazon's servers call your Pi, so the Pi needs one public HTTPS address. Tailscale Funnel gives you that.

- Funnel exposes only the path `/alexa/skill`. The rest of the app stays private on your tailnet.
- Every request is checked: Amazon's certificate, Amazon's signature, a timestamp within 150 seconds, and your skill's own ID. Fake requests get rejected before anything runs.
- The skill stays in Development stage. Only the Amazon account that created it, and Echo devices on that account, can use it.

### Turn on Funnel on the Pi

1. In the Tailscale admin page, make sure HTTPS Certificates and Funnel are enabled for your tailnet.
2. On the Pi, run:
   `sudo tailscale funnel --bg --set-path /alexa/skill http://127.0.0.1:47925/alexa/skill`
3. Run `tailscale funnel status` and copy the address. It looks like `https://pi-name.tailnet-name.ts.net`.
4. Your skill URL is that address plus `/alexa/skill`.

### Create the skill

1. Go to developer.amazon.com/alexa/console/ask and sign in with the same Amazon account your Echo uses.
2. Tap Create Skill.
3. Skill name: North Pole. Primary locale: English (US). Tap Next.
4. Choose type of experience: Other. Model: Custom. Hosting: Provision your own. Tap Next.
5. Template: Start from scratch. Tap Next, then Create Skill.
6. In the left menu open Interaction Model, then JSON Editor.
7. Open `skill/interaction-model.json` from this project, select all, and paste it in.
8. Tap Save, then Build Skill. Wait for "Build Successful".
9. In the left menu open Endpoint.
10. Choose HTTPS.
11. Default Region: paste `https://<pi-tailnet-name>.ts.net/alexa/skill`.
12. In the dropdown under it choose: "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority".
13. Tap Save Endpoints.
14. Open the Test tab. Set "Skill testing is enabled in" to Development.
15. Type or say: "open north pole".

The first request tells the Pi your skill ID, and the Pi remembers it. After that only your skill is accepted.

To pin the ID yourself, copy it from the Endpoint page ("Your Skill ID") and put it in `data/config.json` as `alexaSkill.appId`.

### Phrases

Start every phrase with "Alexa, ask North Pole to ..." or open it with "Alexa, open North Pole" and then say them.

1. "tell me a joke"
2. "how many sleeps until Christmas"
3. "where is Santa"
4. "make the tree gold" (red, green, blue, ice blue, warm white, and about 20 more)
5. "set the tree to twinkle" (candy cane, snowfall, fireplace, aurora, rainbow, and more)
6. "turn on the tree" / "turn off the tree"
7. "start a light show" / "play Silent Night"
8. "stop the show"
9. "let's play trivia" (name that song, would you rather, pictionary)
10. "what's today's advent"
11. "what's my elf name" / "my name is Sam, what is my elf name"
12. "party mode"
13. "goodnight"
14. "light the yule log"
15. "play christmas radio"

### Troubleshooting

1. "There was a problem with the requested skill's response": open `https://<pi-tailnet-name>.ts.net/alexa/skill` in a browser. A 404 or "method not allowed" means Funnel works. A timeout means Funnel is off, so rerun the funnel command.
2. Check the Pi log for `[alexa] rejected:`. The reason after it says what failed.
3. "applicationId mismatch": you rebuilt the skill and got a new ID. Delete `alexaSkill.appId` from `data/config.json` and restart.
4. "timestamp outside window": the Pi clock is wrong. Run `timedatectl` and enable NTP.
5. "cert download failed": the Pi cannot reach s3.amazonaws.com. Check its internet.
6. "certificate chain does not end at a trusted root": the Pi's CA list is old. Run `sudo apt update && sudo apt install --reinstall ca-certificates`, or update Node.
7. Alexa does not understand a phrase: use the exact wording above, or say "open North Pole" first and then the phrase.
8. After editing `interaction-model.json`, paste it again and tap Build Skill. Regenerate it with `node skill/build-model.mjs`.

### Local testing without Amazon

Start the app with `XM_SKILL_INSECURE=1`. This skips signature checks, so use it only on your own machine and never with Funnel on.
