# Reaction sounds for Bing voices

Drop audio files in this folder and the bot plays them when the text has a scream, screech, scratch, etc.
(Edge/Bing voices can't make these sounds — ElevenLabs voices already do and aren't touched.)

## File names
The name before the first `-`, `_` or space picks the sound. Add numbers to have several variants — one is picked at random.

| File name starts with | Plays for text like |
|---|---|
| `scream` | `AAAAAH`, `Kyaaaa`, `Eeeek`, `Aargh`, `*screams*`, `[shrieks]` |
| `screech` | `Skreeeee`, `Screeeech`, `*screeching*` |
| `scratch` | `Skritch skritch`, `*scratches*`, `*claws*` |
| `gasp` | `*gasps*`, `[gasp]` |
| `laugh` | `*laughs*`, `*giggles*`, `*cackles*` |
| `sob` | `*sobs*`, `*weeping*`, `(crying)` |
| `growl` | `*growls*`, `*snarls*` |
| `thud` / `bang` | `*thud*`, `*slams*`, `*crash*` |

Examples: `scream.mp3`, `scream-2.wav`, `screech_long.ogg`. Formats: mp3, wav, ogg, m4a, flac. Clips are trimmed to 4 seconds and faded out.

Only action words in `*asterisks*`, `[brackets]` or `(parentheses)` count — normal sentences like "the tires screeched" are read as usual.

## Where to get sounds
Use sounds you have the right to use (royalty-free / CC0 libraries such as Freesound or Pixabay — check each file's license).

## No files? Two fallbacks
1. **ElevenLabs-generated sounds:** set `SFX_ELEVENLABS=1` and `ELEVENLABS_API_KEY`. Each sound is generated once (~50 credits) and then cached.
2. **Nothing set up:** the voice says a short spoken version ("Aaaah!") instead of spelling out letters; silent for sounds like scratches.

Set `SFX=off` to turn all of this off.
