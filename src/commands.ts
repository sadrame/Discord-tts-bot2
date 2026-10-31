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
  new SlashCommandBuilder().setName("skip").setDescription("Skip to the next paragraph"),
  new SlashCommandBuilder()
    .setName("find")
    .setDescription("Search the chapter (typo-tolerant) and jump to the match")
    .addStringOption((o) =>
      o.setName("keyword").setDescription("Word or phrase to jump to").setRequired(true)),
  new SlashCommandBuilder()
    .setName("chapter")
    .setDescription("Jump to chapter/section N")
    .addIntegerOption((o) => o.setName("number").setDescription("Chapter number").setMinValue(1).setRequired(true)),
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
