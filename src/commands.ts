import { SlashCommandBuilder, ChannelType } from "discord.js";

export const slashCommands = [
  new SlashCommandBuilder()
    .setName("read")
    .setDescription("Fetch a chapter or Google Doc and read it aloud in voice")
    .addStringOption((o) => o.setName("url").setDescription("Chapter, AO3 or Google Docs link").setRequired(true))
    .addChannelOption((o) =>
      o.setName("channel").setDescription("Voice channel to join (defaults to yours)")
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)),
  new SlashCommandBuilder().setName("stop").setDescription("Stop reading and leave voice (saves your position)"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip current paragraph"),
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
  new SlashCommandBuilder().setName("voice").setDescription("Pick a TTS voice"),
  new SlashCommandBuilder().setName("invite").setDescription("Get a link to add this bot to your server"),
  new SlashCommandBuilder().setName("help").setDescription("Show the command list"),
  new SlashCommandBuilder().setName("join").setDescription("Makes the bot join your current voice channel"),
].map((c) => c.toJSON());
