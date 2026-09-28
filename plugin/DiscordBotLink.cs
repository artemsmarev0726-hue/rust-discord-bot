using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Oxide.Core;
using Oxide.Core.Libraries;

namespace Oxide.Plugins
{
    [Info("DiscordBotLink", "Claude", "1.1.0")]
    [Description("Связь с Discord-ботом без прямого доступа к Discord: наигранное время, онлайн сервера, консольные команды из Discord")]
    public class DiscordBotLink : RustPlugin
    {
        #region Config

        private Configuration config;

        private class Configuration
        {
            [JsonProperty("Адрес бота (без / в конце)")]
            public string BotUrl = "https://IP_ХОСТИНГА";

            [JsonProperty("Секрет (как api.secret в config.json бота)")]
            public string Secret = "ПРИДУМАЙ_ДЛИННЫЙ_СЕКРЕТ_ДЛЯ_ПЛАГИНА";

            [JsonProperty("Название сервера (для логов бота)")]
            public string ServerName = "Rust";

            [JsonProperty("Интервал отправки наигранного времени, сек")]
            public int SendIntervalSec = 60;

            [JsonProperty("Отправлять онлайн сервера боту (для статуса бота)")]
            public bool SendStatus = true;

            [JsonProperty("Интервал отправки онлайна, сек")]
            public int StatusIntervalSec = 30;

            [JsonProperty("Выполнять консольные команды из Discord (/консоль)")]
            public bool AcceptCommands = true;

            [JsonProperty("Интервал опроса команд, сек")]
            public float CommandPollSec = 3f;

            [JsonProperty("Таймаут запроса, сек")]
            public float TimeoutSec = 15f;

            [JsonProperty("Учитывать только эти SteamID (пусто = всех игроков)")]
            public List<string> OnlySteamIds = new List<string>();

            [JsonProperty("Не учитывать админов")]
            public bool IgnoreAdmins = false;

            [JsonProperty("Подробный лог в консоль")]
            public bool Debug = false;
        }

        protected override void LoadDefaultConfig() => config = new Configuration();

        protected override void LoadConfig()
        {
            base.LoadConfig();
            try
            {
                config = Config.ReadObject<Configuration>();
                if (config == null) throw new Exception("пустой конфиг");
                if (config.OnlySteamIds == null) config.OnlySteamIds = new List<string>();
            }
            catch (Exception e)
            {
                PrintError($"Ошибка конфига, используются значения по умолчанию: {e.Message}");
                LoadDefaultConfig();
            }
            SaveConfig();
        }

        protected override void SaveConfig() => Config.WriteObject(config, true);

        #endregion

        #region Data

        private class Entry
        {
            public string Name;
            public double Seconds;
        }

        private class BatchPlayer
        {
            [JsonProperty("steamId")] public string SteamId;
            [JsonProperty("name")] public string Name;
            [JsonProperty("seconds")] public long Seconds;
        }

        private class Batch
        {
            [JsonProperty("batchId")] public string BatchId;
            [JsonProperty("server")] public string Server;
            [JsonProperty("players")] public List<BatchPlayer> Players = new List<BatchPlayer>();
        }

        private class StoredData
        {
            // Накоплено, но ещё не упаковано в пачку
            public Dictionary<string, Entry> Pending = new Dictionary<string, Entry>();
            // Пачка, отправленная, но не подтверждённая ботом. Повторяется с тем же batchId,
            // поэтому бот не засчитает её дважды, даже если ответ потерялся.
            public Batch InFlight;
        }

        private StoredData data;
        private readonly Dictionary<string, DateTime> sessionMark = new Dictionary<string, DateTime>();
        private HashSet<string> onlyIds;
        private bool sending;
        private bool dirty;
        private int failsInRow;
        private DateTime lastErrorLog = DateTime.MinValue;

        private void LoadData()
        {
            try { data = Interface.Oxide.DataFileSystem.ReadObject<StoredData>(Name); }
            catch { data = null; }
            if (data == null) data = new StoredData();
            if (data.Pending == null) data.Pending = new Dictionary<string, Entry>();
        }

        private void SaveData()
        {
            Interface.Oxide.DataFileSystem.WriteObject(Name, data);
            dirty = false;
        }

        #endregion

        #region Hooks

        private void Init()
        {
            LoadData();
            onlyIds = new HashSet<string>(config.OnlySteamIds.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()));
        }

        private void OnServerInitialized()
        {
            var now = DateTime.UtcNow;
            foreach (var p in BasePlayer.activePlayerList) sessionMark[p.UserIDString] = now;
            timer.Every(Math.Max(15, config.SendIntervalSec), SendTick);
            if (config.SendStatus) { SendStatus(); timer.Every(Math.Max(10, config.StatusIntervalSec), SendStatus); }
            if (config.AcceptCommands) timer.Every(Math.Max(1f, config.CommandPollSec), PollCommands);
            timer.Every(300f, () => { if (dirty) SaveData(); });
        }

        private void OnPlayerConnected(BasePlayer player)
        {
            if (player == null) return;
            sessionMark[player.UserIDString] = DateTime.UtcNow;
        }

        private void OnPlayerDisconnected(BasePlayer player, string reason)
        {
            if (player == null) return;
            Accrue(player, DateTime.UtcNow);
            sessionMark.Remove(player.UserIDString);
        }

        private void OnServerSave()
        {
            AccrueAll();
            SaveData();
        }

        private void Unload()
        {
            AccrueAll();
            SaveData();
        }

        #endregion

        #region Core

        private bool ShouldTrack(BasePlayer p)
        {
            if (p == null || p.UserIDString == null || p.UserIDString.Length != 17 || !p.UserIDString.StartsWith("7656")) return false; // боты/NPC
            if (config.IgnoreAdmins && (p.IsAdmin || permission.UserHasGroup(p.UserIDString, "admin"))) return false;
            if (onlyIds.Count > 0 && !onlyIds.Contains(p.UserIDString)) return false;
            return true;
        }

        private void Accrue(BasePlayer p, DateTime now)
        {
            DateTime mark;
            if (!sessionMark.TryGetValue(p.UserIDString, out mark))
            {
                sessionMark[p.UserIDString] = now;
                return;
            }
            sessionMark[p.UserIDString] = now;
            if (!ShouldTrack(p)) return;

            var delta = (now - mark).TotalSeconds;
            if (delta <= 0 || delta > 6 * 3600) return; // защита от скачков часов

            Entry e;
            if (!data.Pending.TryGetValue(p.UserIDString, out e))
                data.Pending[p.UserIDString] = e = new Entry();
            e.Name = p.displayName;
            e.Seconds += delta;
            dirty = true;
        }

        private void AccrueAll()
        {
            var now = DateTime.UtcNow;
            foreach (var p in BasePlayer.activePlayerList.ToList()) Accrue(p, now);
        }

        private void SendTick()
        {
            AccrueAll();
            TrySend();
        }

        private void TrySend()
        {
            if (sending) return;
            if (!Configured) return;

            if (data.InFlight == null)
            {
                var batch = new Batch { BatchId = Guid.NewGuid().ToString("N"), Server = config.ServerName };
                foreach (var kv in data.Pending)
                {
                    var whole = (long)Math.Floor(kv.Value.Seconds);
                    if (whole < 1) continue;
                    batch.Players.Add(new BatchPlayer { SteamId = kv.Key, Name = kv.Value.Name, Seconds = whole });
                    kv.Value.Seconds -= whole; // дробный остаток остаётся копиться
                }
                if (batch.Players.Count == 0) return;
                foreach (var key in data.Pending.Where(kv => kv.Value.Seconds < 0.001).Select(kv => kv.Key).ToList())
                    data.Pending.Remove(key);
                data.InFlight = batch;
                SaveData(); // пачка зафиксирована на диске до отправки — не потеряется при рестарте
            }

            var toSend = data.InFlight;
            var body = JsonConvert.SerializeObject(toSend);
            var headers = Headers();

            sending = true;
            webrequest.Enqueue(Url("/api/playtime"), body, (code, response) =>
            {
                sending = false;
                if (code == 200)
                {
                    if (data.InFlight != null && data.InFlight.BatchId == toSend.BatchId) data.InFlight = null;
                    failsInRow = 0;
                    SaveData();
                    if (config.Debug) Puts($"Отправлено: {toSend.Players.Count} игрок(ов)");
                    return;
                }

                failsInRow++;
                if (code == 400)
                {
                    // Бот не принял тело — выкидываем пачку, иначе очередь встанет навсегда
                    PrintWarning($"Бот отклонил пачку (400): {Trim(response)}. Пачка отброшена.");
                    data.InFlight = null;
                    SaveData();
                    return;
                }
                if (code == 401)
                {
                    LogThrottled("Бот ответил 401 — не совпадает секрет. Данные копятся, пока не исправишь.");
                    return;
                }
                LogThrottled($"Бот недоступен (код {code}), повтор через {config.SendIntervalSec} с. Неудач подряд: {failsInRow}");
            }, this, RequestMethod.POST, headers, config.TimeoutSec);
        }

        private void LogThrottled(string msg)
        {
            if ((DateTime.UtcNow - lastErrorLog).TotalMinutes < 5 && !config.Debug) return;
            lastErrorLog = DateTime.UtcNow;
            PrintWarning(msg);
        }

        private static string Trim(string s) => string.IsNullOrEmpty(s) ? "" : (s.Length > 200 ? s.Substring(0, 200) : s);

        #endregion

        #region Helpers

        private bool Configured => !string.IsNullOrEmpty(config.BotUrl) && !config.BotUrl.Contains("IP_ХОСТИНГА");

        private string Url(string path)
        {
            var b = config.BotUrl.TrimEnd('/');
            if (b.EndsWith("/api/playtime")) b = b.Substring(0, b.Length - "/api/playtime".Length); // конфиг 1.0.0
            return b + path;
        }

        private Dictionary<string, string> Headers() => new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["Authorization"] = "Bearer " + config.Secret
        };

        #endregion

        #region Status & Commands

        private bool polling;
        private DateTime lastPollOk = DateTime.MinValue;

        private void SendStatus()
        {
            if (!Configured) return;
            var q = ServerMgr.Instance?.connectionQueue;
            var body = JsonConvert.SerializeObject(new Dictionary<string, object>
            {
                ["online"] = BasePlayer.activePlayerList.Count,
                ["max"] = ConVar.Server.maxplayers,
                ["queue"] = q?.Queued ?? 0,
                ["joining"] = q?.Joining ?? 0,
                ["hostname"] = ConVar.Server.hostname
            });
            webrequest.Enqueue(Url("/api/status"), body, (code, resp) =>
            {
                if (code != 200) LogThrottled($"Не удалось отправить онлайн боту (код {code}).");
            }, this, RequestMethod.POST, Headers(), config.TimeoutSec);
        }

        private class BotCommand
        {
            [JsonProperty("id")] public string Id;
            [JsonProperty("command")] public string Command;
        }

        private class CommandsResponse
        {
            [JsonProperty("commands")] public List<BotCommand> Commands;
        }

        private void PollCommands()
        {
            if (polling || !Configured) return;
            polling = true;
            webrequest.Enqueue(Url("/api/commands"), null, (code, resp) =>
            {
                polling = false;
                if (code != 200) { LogThrottled($"Бот недоступен для опроса команд (код {code})."); return; }
                lastPollOk = DateTime.UtcNow;
                CommandsResponse data;
                try { data = JsonConvert.DeserializeObject<CommandsResponse>(resp); }
                catch { return; }
                if (data?.Commands == null) return;
                foreach (var c in data.Commands) RunBotCommand(c);
            }, this, RequestMethod.GET, Headers(), 10f);
        }

        private void RunBotCommand(BotCommand c)
        {
            if (c == null || string.IsNullOrWhiteSpace(c.Command)) return;
            Puts($"Команда из Discord: {c.Command}");
            string output;
            bool ok = true;
            try
            {
                output = ConsoleSystem.Run(ConsoleSystem.Option.Server, c.Command) ?? "";
            }
            catch (Exception e)
            {
                ok = false;
                output = "Ошибка: " + e.Message;
            }
            var body = JsonConvert.SerializeObject(new Dictionary<string, object> { ["id"] = c.Id, ["ok"] = ok, ["output"] = output });
            webrequest.Enqueue(Url("/api/commands/result"), body, (code, resp) => { }, this, RequestMethod.POST, Headers(), config.TimeoutSec);
        }

        #endregion

        #region Console

        [ConsoleCommand("botlink.status")]
        private void CmdStatus(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null && !arg.IsAdmin) return;
            AccrueAll();
            var pendingSec = data.Pending.Values.Sum(e => e.Seconds);
            arg.ReplyWith(
                $"[DiscordBotLink] Бот: {config.BotUrl}\n" +
                $"Опрос команд: {(config.AcceptCommands ? (lastPollOk == DateTime.MinValue ? "ещё не было ответа" : $"последний ответ {(DateTime.UtcNow - lastPollOk).TotalSeconds:0} с назад") : "выкл")}\n" +
                $"Отслеживается онлайн: {sessionMark.Count}\n" +
                $"Накоплено к отправке: {data.Pending.Count} игрок(ов), {pendingSec / 60:0.0} мин\n" +
                $"Неподтверждённая пачка: {(data.InFlight == null ? "нет" : data.InFlight.Players.Count + " игрок(ов)")}\n" +
                $"Неудач подряд: {failsInRow}");
        }

        [ConsoleCommand("botlink.flush")]
        private void CmdFlush(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null && !arg.IsAdmin) return;
            AccrueAll();
            TrySend();
            arg.ReplyWith("[DiscordBotLink] Отправка запущена, результат — в консоли (при Debug) или botlink.status.");
        }

        #endregion
    }
}
