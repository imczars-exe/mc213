require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const mcping = require('mcping-js');

const required = ['DISCORD_TOKEN', 'DISCORD_CHANNEL_ID', 'MC_HOST'];
for (const key of required) {
  if (!process.env[key] || process.env[key].includes('PEGA_')) {
    console.error(`❌ Falta configurar "${key}" en el archivo .env`);
    process.exit(1);
  }
}

const CONFIG = {
  token:     process.env.DISCORD_TOKEN,
  channelId: process.env.DISCORD_CHANNEL_ID,
  mc: {
    host: process.env.MC_HOST,
    port: parseInt(process.env.MC_PORT || '25565', 10),
  },
  server: {
    name:        process.env.SERVER_NAME        || 'Minecraft Server',
    version:     process.env.SERVER_VERSION     || '',
    modloader:   process.env.SERVER_MODLOADER   || 'Vanilla',
    iconUrl:     process.env.SERVER_ICON_URL    || '',
    modpackUrl:  process.env.MODPACK_URL        || '',
    modpackName: process.env.MODPACK_NAME       || 'Descargar Modpack',
    extraModsUrl:  process.env.EXTRA_MODS_URL   || '',
    extraModsName: process.env.EXTRA_MODS_NAME  || 'Mods adicionales',
  },
  interval: parseInt(process.env.CHECK_INTERVAL_SECONDS || '30', 10) * 1000,
};

const STATE = { OFFLINE: 'offline', STARTING: 'starting', ONLINE: 'online' };
let currentState    = STATE.OFFLINE;
let statusMessageId = null;
let startingTimer   = null;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Ping al servidor Minecraft ─────────────────────────────
function pingServer() {
  return new Promise((resolve) => {
    const server = new mcping.MinecraftServer(CONFIG.mc.host, CONFIG.mc.port);
    server.ping(5000, 765, (err, res) => {
      if (err || !res) {
        resolve(null);
      } else {
        resolve(res);
      }
    });
  });
}

function stateAssets(state) {
  switch (state) {
    case STATE.ONLINE:   return { color: 0x57F287, emoji: '🟢', label: 'EN LÍNEA'  };
    case STATE.STARTING: return { color: 0xFEE75C, emoji: '🟡', label: 'INICIANDO' };
    default:             return { color: 0xED4245, emoji: '🔴', label: 'OFFLINE'    };
  }
}

function modloaderIcon(ml) {
  const icons = { Forge: '⚒️', Fabric: '🧵', Quilt: '🪡', NeoForge: '🔧', Vanilla: '🎮' };
  return icons[ml] || '🎮';
}

function stripColors(str) {
  return (str || '').replace(/§./g, '').trim();
}

function buildEmbed(state, res) {
  const { color, emoji, label } = stateAssets(state);
  const mlIcon  = modloaderIcon(CONFIG.server.modloader);

  // Extraer datos del ping
  const online  = res?.players?.online ?? 0;
  const max     = res?.players?.max    ?? 0;
  const version = stripColors(res?.version?.name) || CONFIG.server.version || '?';
  const motd    = typeof res?.description === 'string'
    ? stripColors(res.description)
    : stripColors(res?.description?.text);

  // Ícono: solo usar URL configurada en .env (Discord no acepta base64)
  const favicon = CONFIG.server.iconUrl || null;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji}  ${CONFIG.server.name}`)
    .setFooter({ text: 'Última actualización' })
    .setTimestamp();

  if (favicon) embed.setThumbnail(favicon);

  if (state === STATE.ONLINE) {
    embed.addFields(
      { name: '📡 Estado',            value: `\`${label}\``,           inline: true },
      { name: '👥 Jugadores',         value: `\`${online} / ${max}\``, inline: true },
      { name: '\u200B',               value: '\u200B',                  inline: true },
      { name: `${mlIcon} Plataforma`, value: `\`${CONFIG.server.modloader}\``,      inline: true },
      { name: '🔖 Versión',           value: `\`${version}\``,         inline: true },
      { name: '🌐 Dirección',         value: `\`${CONFIG.mc.host}:${CONFIG.mc.port}\``, inline: true },
    );
  } else if (state === STATE.STARTING) {
    embed.setDescription('⏳ El servidor está arrancando, espera un momento…');
    embed.addFields(
      { name: '📡 Estado',            value: `\`${label}\``,                        inline: true },
      { name: `${mlIcon} Plataforma`, value: `\`${CONFIG.server.modloader}\``,      inline: true },
      { name: '🔖 Versión',           value: `\`${CONFIG.server.version || '?'}\``, inline: true },
      { name: '🌐 Dirección',         value: `\`${CONFIG.mc.host}:${CONFIG.mc.port}\``, inline: true },
    );
  } else {
    embed.setDescription('El servidor está apagado o inaccesible.');
    embed.addFields(
      { name: '📡 Estado',            value: `\`${label}\``,                        inline: true },
      { name: `${mlIcon} Plataforma`, value: `\`${CONFIG.server.modloader}\``,      inline: true },
      { name: '🔖 Versión',           value: `\`${CONFIG.server.version || '?'}\``, inline: true },
      { name: '🌐 Dirección',         value: `\`${CONFIG.mc.host}:${CONFIG.mc.port}\``, inline: true },
    );
  }

  if (CONFIG.server.modpackUrl) {
    embed.addFields({
      name: '📦 Modpack',
      value: `[${CONFIG.server.modpackName}](${CONFIG.server.modpackUrl})`,
      inline: false,
    });
  }

  if (CONFIG.server.extraModsUrl) {
    embed.addFields({
      name: '🧩 Mods adicionales',
      value: `[${CONFIG.server.extraModsName}](${CONFIG.server.extraModsUrl})`,
      inline: false,
    });
  }

  return embed;
}

function updatePresence(state, res) {
  const { emoji, label } = stateAssets(state);
  const online = res?.players?.online ?? 0;
  const max    = res?.players?.max    ?? 0;
  const text   = state === STATE.ONLINE
    ? `${emoji} ${label} · ${online}/${max} jugadores`
    : `${emoji} ${label}`;
  client.user.setPresence({
    status: state === STATE.ONLINE ? 'online' : state === STATE.STARTING ? 'idle' : 'dnd',
    activities: [{ name: text, type: ActivityType.Watching }],
  });
}

async function getOrCreateMessage(channel, embed) {
  if (statusMessageId) {
    try { return await channel.messages.fetch(statusMessageId); }
    catch { statusMessageId = null; }
  }
  const recent = await channel.messages.fetch({ limit: 50 });
  const botMsg = recent.find(m => m.author.id === client.user.id && m.embeds.length > 0);
  if (botMsg) { statusMessageId = botMsg.id; return botMsg; }
  const sent = await channel.send({ embeds: [embed] });
  statusMessageId = sent.id;
  return sent;
}

async function updateAndPost(channel, state, res) {
  const embed = buildEmbed(state, res);
  updatePresence(state, res);
  try {
    const msg = await getOrCreateMessage(channel, embed);
    await msg.edit({ embeds: [embed] });
    console.log(`📝 Mensaje actualizado → ${stateAssets(state).label}`);
  } catch (err) {
    console.error('⚠️ Error actualizando mensaje:', err.message);
    statusMessageId = null;
  }
}

async function checkServer() {
  let channel;
  try {
    channel = await client.channels.fetch(CONFIG.channelId);
  } catch (err) {
    console.error(`❌ No se pudo acceder al canal: ${err.message}`);
    return;
  }

  const res      = await pingServer();
  const reachable = res !== null;

  if (reachable) {
    console.log(`🟢 Servidor responde — ${res.players.online}/${res.players.max} jugadores — ${stripColors(res.version?.name)}`);
  } else {
    console.log(`🔴 Servidor no responde`);
  }

  let newState = currentState;

  if (reachable) {
    if (startingTimer) { clearTimeout(startingTimer); startingTimer = null; }
    newState = STATE.ONLINE;
  } else {
    if (currentState === STATE.ONLINE) {
      newState = STATE.STARTING;
      startingTimer = setTimeout(async () => {
        currentState  = STATE.OFFLINE;
        startingTimer = null;
        const ch = await client.channels.fetch(CONFIG.channelId).catch(() => null);
        if (ch) await updateAndPost(ch, STATE.OFFLINE, null);
      }, 2 * 60 * 1000);
    } else if (currentState === STATE.OFFLINE) {
      newState = STATE.OFFLINE;
    }
  }

  const changed = newState !== currentState;
  currentState  = newState;

  if (changed || newState === STATE.ONLINE) {
    await updateAndPost(channel, newState, res);
  }
}

client.once('clientReady', async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
  console.log(`📡 Monitoreando: ${CONFIG.mc.host}:${CONFIG.mc.port}`);
  console.log(`⏱  Chequeo cada ${CONFIG.interval / 1000}s`);

  try {
    const ch = await client.channels.fetch(CONFIG.channelId);
    console.log(`✅ Canal encontrado: #${ch.name}`);
  } catch (err) {
    console.error(`❌ No se puede acceder al canal ID "${CONFIG.channelId}"`);
    console.error('   1. Verifica que el ID del canal en .env sea correcto');
    console.error('   2. El bot debe estar en el servidor de Discord');
    console.error('   3. Permisos: Ver canal + Enviar mensajes + Insertar links');
    process.exit(1);
  }

  await checkServer();
  setInterval(checkServer, CONFIG.interval);
});

client.on('error', err => console.error('⚠️ Error Discord:', err.message));
process.on('unhandledRejection', err => console.error('⚠️ Error:', err?.message));

client.login(CONFIG.token);
