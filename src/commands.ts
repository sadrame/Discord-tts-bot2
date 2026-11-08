import { SlashCommandBuilder, ChannelType } from "discord.js";

export const slashCommands = [
  new SlashCommandBuilder()
    .setName("read")
    .setDescription("Fetch a chapter or Google Doc and read it aloud in voice")
    .addStringOption((o) => o.setName("url").setDescription("Chapter, AO3 or Google Docs link").setRequired(true))
    .addChannelOption((o) =>
      o.setName("channel").setDescription("Voice channel to join (defaults to yours)")
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)),
  new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel and wait"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop reading and leave voice (saves your position)"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current link and play the next one in the queue"),
  new SlashCommandBuilder().setName("skipparagraph").setDescription("Skip to the next paragraph of the current link"),
  new SlashCommandBuilder().setName("previous").setDescription("Go back to the previous link"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the queue of links")
    .addIntegerOption((o) => o.setName("page").setDescription("Page to open").setMinValue(1)),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a link from the queue")
    .addIntegerOption((o) => o.setName("position").setDescription("Its number in /queue").setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName("clear").setDescription("Clear the whole queue (keeps the current link playing)"),
  new SlashCommandBuilder()
    .setName("controls")
    .setDescription("Who can skip/pause/seek: the queue owner and requester, or everyone")
    .addStringOption((o) =>
      o.setName("mode").setDescription("Control mode")
        .addChoices(
          { name: "Restricted (owner, requester, Manage Server)", value: "restricted" },
          { name: "Open (everyone)",                              value: "open" },
        )),
  new SlashCommandBuilder()
    .setName("find")
    .setDescription("Search the chapter (typo-tolerant) and jump to the match")
    .addStringOption((o) =>
      o.setName("keyword").setDescription("Word or phrase to jump to").setRequired(true)),
  new SlashCommandBuilder()
    .setName("chapter")
    .setDescription("Jump to chapter/section N")
    .addIntegerOption((o) => o.setName("number").setDescription("Chapter number").setMinValue(1).setRequired(true)),
  new SlashCommandBuilder()
    .setName("speed")
    .setDescription("Show or change reading speed (0.5× – 3×)")
    .addNumberOption((o) => o.setName("value").setDescription("Speed multiplier, e.g. 1.25").setMinValue(0.5).setMaxValue(3))
    .addNumberOption((o) => o.setName("step").setDescription("How much the Slower/Faster buttons change it (0.05 – 1)").setMinValue(0.05).setMaxValue(1)),
  new SlashCommandBuilder()
    .setName("rewind")
    .setDescription("Go back (default: your skip step). Examples: 30, 1m, 1m30s")
    .addStringOption((o) => o.setName("amount").setDescription("How far back, e.g. 30 or 1m30s")),
  new SlashCommandBuilder()
    .setName("forward")
    .setDescription("Fast-forward (default: your skip step). Examples: 30, 1m, 1m30s")
    .addStringOption((o) => o.setName("amount").setDescription("How far ahead, e.g. 30 or 1m30s")),
  new SlashCommandBuilder()
    .setName("skipstep")
    .setDescription("Set how many seconds ⏪/⏩ and /rewind /forward move by default")
    .addIntegerOption((o) => o.setName("seconds").setDescription("3 – 300").setMinValue(3).setMaxValue(300).setRequired(true)),
  new SlashCommandBuilder()
    .setName("markers")
    .setDescription("How scene breaks (△▼△▼) and ※ ※ ※ dividers are announced, and whether to skip translator's notes")
    .addStringOption((o) =>
      o.setName("style").setDescription("How dividers are announced")
        .addChoices(
          { name: "Chime (a short sound)",     value: "chime" },
          { name: "Voice (say it out loud)",   value: "voice" },
          { name: "Both",                      value: "both" },
          { name: "Off (silent)",              value: "off" },
        ))
    .addStringOption((o) =>
      o.setName("notes").setDescription("Translator's notes between ※ rows")
        .addChoices(
          { name: "Read them",  value: "read" },
          { name: "Skip them",  value: "skip" },
        )),
  new SlashCommandBuilder()
    .setName("expression")
    .setDescription("Bing voices: how much CAPS, ! and ? change the delivery (louder, higher, slower)")
    .addStringOption((o) =>
      o.setName("level").setDescription("Expression level").setRequired(true)
        .addChoices(
          { name: "Off (flat)",                value: "off" },
          { name: "Normal",                    value: "normal" },
          { name: "Strong (more dramatic)",    value: "strong" },
        )),
  new SlashCommandBuilder().setName("chapters").setDescription("List detected chapters in the current reading"),
  new SlashCommandBuilder().setName("restart").setDescription("Restart from the beginning"),
  new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Jump to a timestamp in seconds")
    .addIntegerOption((o) => o.setName("seconds").setDescription("Seconds from the start").setMinValue(0).setRequired(true)),
  new SlashCommandBuilder().setName("progress").setDescription("Show current progress"),
  new SlashCommandBuilder().setName("voice").setDescription("Pick a TTS voice (Bing, ElevenLabs or Reader) — test before applying"),
  new SlashCommandBuilder()
    .setName("voicesearch")
    .setDescription("Search voices by name, accent or style, test one, then apply it")
    .addStringOption((o) => o.setName("query").setDescription("e.g. sarah, british narrator, deep male").setRequired(true))
    .addStringOption((o) =>
      o.setName("service").setDescription("Where to search (default: all)")
        .addChoices(
          { name: "All services",       value: "all" },
          { name: "Bing (Edge)",        value: "edge" },
          { name: "ElevenLabs",         value: "eleven" },
          { name: "Reader-app voices",  value: "reader" },
        )),
  new SlashCommandBuilder().setName("invite").setDescription("Get a link to add this bot to your server"),
  new SlashCommandBuilder().setName("help").setDescription("Show the command list"),
].map((c) => c.toJSON());
