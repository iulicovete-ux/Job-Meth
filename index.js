require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  Events,
  EmbedBuilder,
} = require("discord.js");

const { Pool } = require("pg");

// ====== CONFIG ======
const SLOT_COUNT = 24;
const RESERVE_HOURS = 8;
const REFRESH_EVERY_MS = 60_000; // 1 minute

function mustEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const TOKEN = mustEnv("TOKEN");
const CLIENT_ID = mustEnv("CLIENT_ID");
const GUILD_ID = mustEnv("GUILD_ID");
const PANEL_CHANNEL_ID = mustEnv("PANEL_CHANNEL_ID");
const DATABASE_URL = mustEnv("DATABASE_URL");

// ====== DB ======
const pool = new Pool({ connectionString: DATABASE_URL });

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fridge_slots (
      slot_no INT PRIMARY KEY,
      reserved_by_id TEXT,
      reserved_by_name TEXT,
      reserved_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fridge_meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);

  // Ensure 1..SLOT_COUNT exist
  for (let i = 1; i <= SLOT_COUNT; i++) {
    await pool.query(
      `INSERT INTO fridge_slots(slot_no) VALUES($1) ON CONFLICT (slot_no) DO NOTHING`,
      [i]
    );
  }
}

async function getMeta(key) {
  const r = await pool.query(`SELECT v FROM fridge_meta WHERE k=$1`, [key]);
  return r.rows[0]?.v ?? null;
}

async function setMeta(key, value) {
  await pool.query(
    `INSERT INTO fridge_meta(k, v) VALUES($1, $2)
     ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`,
    [key, value]
  );
}

async function freeExpiredSlots() {
  await pool.query(`
    UPDATE fridge_slots
    SET reserved_by_id=NULL, reserved_by_name=NULL, reserved_at=NULL, ends_at=NULL
    WHERE ends_at IS NOT NULL AND ends_at <= NOW();
  `);
}

async function getSlots() {
  const r = await pool.query(`
    SELECT slot_no, reserved_by_id, reserved_by_name, reserved_at, ends_at
    FROM fridge_slots
    ORDER BY slot_no ASC
  `);
  return r.rows;
}

async function reserveSlot(slotNo, userId, userName) {
  // Only reserve if currently free or expired (we also free expired before calling)
  const endsAt = new Date(Date.now() + RESERVE_HOURS * 60 * 60 * 1000);

  const r = await pool.query(
    `
    UPDATE fridge_slots
    SET reserved_by_id=$1, reserved_by_name=$2, reserved_at=NOW(), ends_at=$3
    WHERE slot_no=$4
      AND reserved_by_id IS NULL
    RETURNING slot_no
    `,
    [userId, userName, endsAt, slotNo]
  );

  return r.rowCount === 1;
}

// ====== DISCORD ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function pad2(n) {
  return String(n).padStart(2, "0");
}

function humanRemaining(ms) {
  if (ms <= 0) return "expirat";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;

  if (h <= 0) return `peste ${m} minute`;
  if (m === 0) return `peste ${h} ore`;
  return `peste ${h} ore ${m} minute`;
}

function buildPanelEmbed(slots) {
  const lines = [];
  lines.push("📱 Selectează frigiderele pe care le folosesti.");
  lines.push("");
  lines.push("🧊 Status Frigidere");
  lines.push("");

  const now = Date.now();

  for (const s of slots) {
    const label = `[${pad2(s.slot_no)}]`;
    if (!s.reserved_by_id || !s.ends_at) {
      lines.push(`${label} 🟢 Liber`);
    } else {
      const ends = new Date(s.ends_at).getTime();
      const remaining = humanRemaining(ends - now);
      const name = s.reserved_by_name ? s.reserved_by_name : "Necunoscut";
      lines.push(`${label} 🔴 ${name}  ⏳ ${remaining}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("Garaj Operations Panel")
    .setDescription("```" + lines.join("\n") + "```");

  return embed;
}

function buildControlsRow() {
  const reserveBtn = new ButtonBuilder()
    .setCustomId("fridge_reserve")
    .setLabel("Rezervă (8h)")
    .setStyle(ButtonStyle.Primary);

  const releaseBtn = new ButtonBuilder()
    .setCustomId("fridge_release")
    .setLabel("Eliberează (al meu)")
    .setStyle(ButtonStyle.Danger);

  const refreshBtn = new ButtonBuilder()
    .setCustomId("fridge_refresh")
    .setLabel("Refresh")
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(reserveBtn, releaseBtn, refreshBtn);
}


async function upsertPanelMessage() {
  const channel = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error("❌ PANEL_CHANNEL_ID invalid or not text channel.");
    return;
  }

  await freeExpiredSlots();
  const slots = await getSlots();
  const embed = buildPanelEmbed(slots);
  const components = [buildControlsRow()];

  const messageId = await getMeta("panel_message_id");

  if (messageId) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components });
      return;
    }
  }

  // create new panel
  const sent = await channel.send({ embeds: [embed], components });
  await setMeta("panel_message_id", sent.id);
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setup-frigidere")
      .setDescription("Postează/actualizează panelul de frigidere în canalul setat.")
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered.");
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await dbInit();
  await registerCommands();

  // initial panel + auto refresh
  await upsertPanelMessage();
  setInterval(async () => {
    try {
      await upsertPanelMessage();
    } catch (e) {
      console.error("❌ Refresh error:", e);
    }
  }, REFRESH_EVERY_MS);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // /setup-frigidere
    if (interaction.isChatInputCommand() && interaction.commandName === "setup-frigidere") {
      await upsertPanelMessage();
      return interaction.reply({ content: "✅ Panel actualizat.", ephemeral: true });
    }

    // Buttons
   // Buttons
if (interaction.isButton()) {
  if (interaction.customId === "fridge_refresh") {
    // ✅ No alert message at all
    await interaction.deferUpdate();
    await upsertPanelMessage();
    return;
  }

  if (interaction.customId === "fridge_release") {
    // ✅ No "Only you can see" spam: use deferReply + editReply
    await interaction.deferReply({ ephemeral: true });

    await freeExpiredSlots();
    const releasedSlot = await releaseUserSlot(interaction.user.id);

    if (!releasedSlot) {
      await interaction.editReply("❌ Nu ai niciun frigider rezervat.");
      return;
    }

    await upsertPanelMessage();
    await interaction.editReply(`✅ Ai eliberat frigiderul **${pad2(releasedSlot)}**.`);
    return;
  }

  if (interaction.customId === "fridge_reserve") {
    await freeExpiredSlots();
    const slots = await getSlots();
    const freeSlots = slots.filter((s) => !s.reserved_by_id);

    if (freeSlots.length === 0) {
      await interaction.reply({ content: "❌ Nu există frigidere libere acum.", ephemeral: true });
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("fridge_pick_slot")
      .setPlaceholder("Alege un frigider liber…")
      .addOptions(
        freeSlots.slice(0, 25).map((s) => ({
          label: `Frigider ${pad2(s.slot_no)}`,
          value: String(s.slot_no),
          description: `Rezervare pentru ${RESERVE_HOURS} ore`,
        }))
      );

    const row = new ActionRowBuilder().addComponents(menu);

    // ✅ This message is ephemeral, but it's necessary for the dropdown.
    // We'll keep it, but we can auto-clear it by editing it after selection (next step).
    await interaction.reply({
      content: "Selectează frigiderul pe care vrei să-l rezervi (8 ore):",
      components: [row],
      ephemeral: true,
    });
    return;
  }
}


    // Select menu: pick slot
    if (interaction.isStringSelectMenu() && interaction.customId === "fridge_pick_slot") {
      const slotNo = Number(interaction.values[0]);
      if (!Number.isInteger(slotNo) || slotNo < 1 || slotNo > SLOT_COUNT) {
        return interaction.reply({ content: "❌ Slot invalid.", ephemeral: true });
      }

      await freeExpiredSlots();

      const displayName = interaction.member?.displayName || interaction.user.username;

      const ok = await reserveSlot(slotNo, interaction.user.id, displayName);
      if (!ok) {
        return interaction.reply({
          content: `❌ Frigiderul ${pad2(slotNo)} a fost rezervat deja de altcineva. Dă refresh și alege altul.`,
          ephemeral: true,
        });
      }

      await upsertPanelMessage();

      return interaction.reply({
        content: `✅ Ai rezervat frigiderul **${pad2(slotNo)}** pentru **${RESERVE_HOURS} ore**.`,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
    try {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "❌ A apărut o eroare.", ephemeral: true });
      }
    } catch {}
  }
});

client.login(TOKEN);
