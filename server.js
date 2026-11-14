"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const net = require("node:net");

const PORT = Number(process.env.PORT || 4173);
const HOST = "127.0.0.1";
const HOME = os.homedir();
const LEGACY_STORE = path.join(HOME, ".config", "sshfs-painel", "profiles.json");
const CONNECTIONS = path.join(__dirname, "conexões");
const UUID = /^[a-f0-9-]{36}$/;
const STATIC = path.join(__dirname, "public");
const token = crypto.randomBytes(32).toString("hex");
const busy = new Set();

function error(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function requireNonRoot(getuid = process.getuid) {
  if (typeof getuid !== "function" || getuid() === 0) throw error("Inicie o painel como usuário comum, nunca como root ou com sudo.", 403);
}

function validHost(host) {
  return net.isIP(host) !== 0 || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host);
}

function validate(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw error("Perfil inválido.");
  const text = (key, max = 512) => {
    const value = profile[key];
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw error(`Campo inválido: ${key}.`);
    return value.trim();
  };
  const name = text("name", 80);
  const host = text("host", 253);
  if (!validHost(host)) throw error("Host inválido.");
  const user = text("user", 64);
  if (!/^[a-zA-Z0-9_.-]+$/.test(user) || user.startsWith("-")) throw error("Usuário inválido.");
  const port = Number(profile.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw error("Porta deve estar entre 1 e 65535.");
  // Nenhuma rota remota é configurada; o SFTP decide seu diretório inicial.
  const local = profile.local === undefined || profile.local === "" ? "~" : text("local");
  // "~" escolhe um ponto de montagem próprio; nunca montamos por cima da home inteira.
  const defaultFolder = `${host.replace(/[^a-zA-Z0-9_-]/g, "-")}-${port}-${user}`;
  const expandedLocal = local === "~" ? path.join(HOME, "Remotos", defaultFolder) : local.startsWith("~/") ? path.join(HOME, local.slice(2)) : local;
  const normalizedLocal = path.normalize(expandedLocal);
  if (!path.isAbsolute(expandedLocal) || normalizedLocal === HOME || !normalizedLocal.startsWith(HOME + path.sep)) throw error("A pasta local deve ficar dentro da sua pasta pessoal; use '~' para criar automaticamente uma pasta de montagem em ~/Remotos.");
  const methods = profile.methods;
  if (!Array.isArray(methods) || !methods.length || methods.some(m => !["agent", "key", "password"].includes(m)) || new Set(methods).size !== methods.length) throw error("Selecione métodos de autenticação válidos.");
  let keyPath = "";
  if (methods.includes("key")) {
    keyPath = text("keyPath");
    if (!path.isAbsolute(keyPath)) throw error("O caminho da chave deve ser absoluto.");
    if (keyPath.includes(",") || keyPath.includes("\\")) throw error("O caminho da chave não pode conter vírgula ou barra invertida.");
  }
  const mode = profile.mode ?? "auto";
  if (!["auto", "direct", "ipv4", "ipv6", "jump"].includes(mode)) throw error("Modo de conexão inválido.");
  let jumpHost = "", jumpUser = "", jumpPort = 22;
  if (mode === "jump") {
    jumpHost = text("jumpHost", 253);
    if (!validHost(jumpHost)) throw error("Host intermediário inválido.");
    jumpUser = text("jumpUser", 64);
    if (!/^[a-zA-Z0-9_.-]+$/.test(jumpUser) || jumpUser.startsWith("-")) throw error("Usuário intermediário inválido.");
    jumpPort = Number(profile.jumpPort);
    if (!Number.isInteger(jumpPort) || jumpPort < 1 || jumpPort > 65535) throw error("Porta intermediária inválida.");
  }
  const options = profile.options ?? [];
  if (!Array.isArray(options) || options.some(o => !["compression", "readonly", "followSymlinks", "idmap"].includes(o)) || new Set(options).size !== options.length) throw error("Opções SSHFS inválidas.");
  return { id: typeof profile.id === "string" && UUID.test(profile.id) ? profile.id : crypto.randomUUID(), name, host, user, port, local: normalizedLocal, methods, keyPath, mode, jumpHost, jumpUser, jumpPort, options };
}

async function ensureConnections() {
  await fs.mkdir(CONNECTIONS, { recursive: true, mode: 0o700 });
  await fs.chmod(CONNECTIONS, 0o700);
}

function connectionFile(id) {
  if (!UUID.test(id)) throw error("Identificador inválido.");
  return path.join(CONNECTIONS, `${id}.json`);
}

async function writeProfile(item, exclusive = false) {
  const file = connectionFile(item.id);
  const tmp = path.join(CONNECTIONS, `${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(item, null, 2), { flag: "wx", mode: 0o600 });
  try {
    if (exclusive) await fs.link(tmp, file); // migração nunca substitui um perfil existente
    else await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function migrateLegacy() {
  let data;
  try { data = JSON.parse(await fs.readFile(LEGACY_STORE, "utf8")); }
  catch (err) {
    if (err.code === "ENOENT") return;
    throw error("Não foi possível migrar os perfis antigos.", 500);
  }
  if (!Array.isArray(data)) throw error("O arquivo antigo de perfis é inválido.", 500);
  for (const old of data) {
    if (!old || typeof old.id !== "string" || !UUID.test(old.id)) throw error("Um perfil antigo tem identificador inválido.", 500);
    const file = connectionFile(old.id);
    try { await fs.access(file); continue; } catch (err) { if (err.code !== "ENOENT") throw err; }
    const item = validate(old);
    try { await writeProfile(item, true); }
    catch (err) { if (err.code !== "EEXIST") throw err; }
  }
  // Retira o arquivo da rota de migração, preservando-o como backup para não recriar perfis excluídos.
  await fs.rename(LEGACY_STORE, `${LEGACY_STORE}.migrated-${Date.now()}`);
}

async function profiles() {
  try {
    await ensureConnections();
    await migrateLegacy();
    const names = (await fs.readdir(CONNECTIONS)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort();
    return await Promise.all(names.map(async name => {
      const data = JSON.parse(await fs.readFile(path.join(CONNECTIONS, name), "utf8"));
      if (data.id !== name.slice(0, -5)) throw new Error("Identificador inconsistente");
      return validate(data);
    }));
  } catch (err) {
    throw error("Não foi possível ler ou migrar as conexões salvas. Verifique a pasta conexões/.", 500);
  }
}

function execute(command, args, { input, timeout = 12000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C", ...env } });
    let stdout = "", stderr = "", finished = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", b => { stdout = (stdout + b).slice(-4096); });
    child.stderr.on("data", b => { stderr = (stderr + b).slice(-4096); });
    child.on("error", err => {
      if (!finished) { finished = true; clearTimeout(timer); reject(error(`Não foi possível executar ${command}: ${err.message}`, 500)); }
    });
    child.on("close", code => {
      if (!finished) { finished = true; clearTimeout(timer); resolve({ code, stdout, stderr: stderr.trim(), timedOut: child.signalCode === "SIGKILL" }); }
    });
    if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  });
}

async function mounted(local) {
  const result = await execute("findmnt", ["--mountpoint", local, "--noheadings", "--output", "FSTYPE,SOURCE"]);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function mountDirectory(local) {
  await fs.mkdir(local, { recursive: true, mode: 0o700 });
  const realHome = await fs.realpath(HOME);
  const realLocal = await fs.realpath(local);
  if (!realLocal.startsWith(realHome + path.sep)) throw error("A pasta local resolve para fora da sua pasta pessoal.");
  if ((await fs.readdir(local)).length && !(await mounted(local))) throw error("A pasta local não está vazia. Escolha uma pasta vazia.");
}

function buildMountArgs(profile, method, mode = profile.mode || "auto", remoteDirectory = "") {
  const args = ["-p", String(profile.port), "-o", "reconnect", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "-o", "NumberOfPasswordPrompts=1"];
  if (mode === "ipv4") args.push("-o", "AddressFamily=inet");
  if (mode === "ipv6") args.push("-o", "AddressFamily=inet6");
  if (mode === "jump") args.push("-o", `ProxyJump=${profile.jumpUser}@${net.isIP(profile.jumpHost) === 6 ? `[${profile.jumpHost}]` : profile.jumpHost}:${profile.jumpPort}`);
  for (const option of profile.options || []) {
    const flag = { compression: "Compression=yes", readonly: "ro", followSymlinks: "follow_symlinks", idmap: "idmap=user" }[option];
    if (flag) args.push("-o", flag);
  }
  if (method === "agent") args.push("-o", "BatchMode=yes", "-o", "PreferredAuthentications=publickey");
  if (method === "key") args.push("-o", "BatchMode=yes", "-o", `IdentityFile=${profile.keyPath}`, "-o", "IdentitiesOnly=yes", "-o", "PreferredAuthentications=publickey");
  if (method === "password") args.push("-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", "-o", "KbdInteractiveAuthentication=no");
  const destination = net.isIP(profile.host) === 6 ? `[${profile.host}]` : profile.host;
  // Sem resultado autenticado, o SFTP escolhe a pasta inicial; caso contrário, monta o pwd confirmado.
  args.push(`${profile.user}@${destination}:${remoteDirectory}`, profile.local);
  return args;
}

function buildProbeArgs(profile, method) {
  const args = ["-p", String(profile.port), "-o", `BatchMode=${method === "password" ? "no" : "yes"}`, "-o", `PreferredAuthentications=${method === "password" ? "password" : "publickey"}`, "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "-o", `NumberOfPasswordPrompts=${method === "password" ? "1" : "0"}`, "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no", "-o", "LogLevel=ERROR", "-T"];
  if (profile.mode === "ipv4") args.push("-o", "AddressFamily=inet");
  if (profile.mode === "ipv6") args.push("-o", "AddressFamily=inet6");
  if (profile.mode === "jump") args.push("-o", `ProxyJump=${profile.jumpUser}@${net.isIP(profile.jumpHost) === 6 ? `[${profile.jumpHost}]` : profile.jumpHost}:${profile.jumpPort}`);
  if (method === "key") args.push("-o", `IdentityFile=${profile.keyPath}`, "-o", "IdentitiesOnly=yes");
  if (method === "password") args.push("-o", "PubkeyAuthentication=no", "-o", "KbdInteractiveAuthentication=no");
  const destination = net.isIP(profile.host) === 6 ? `[${profile.host}]` : profile.host;
  args.push(`${profile.user}@${destination}`, "printf '__SSHFS_PANEL_PWD__%s\\n' \"$(pwd -P)\"");
  return args;
}

function parseRemoteDirectory(output) {
  // O servidor pode exibir banner ou mensagens de shell; leia somente o marcador controlado.
  const match = output.match(/__SSHFS_PANEL_PWD__(\/[^\r\n]*)/);
  if (!match) return null;
  const directory = match[1].trim();
  if (!directory.startsWith("/") || directory.length > 1024 || /[\x00-\x1f\x7f]/.test(directory)) return null;
  return directory;
}

async function executeWithAskpassCommand(command, args, password, timeout = 16000) {
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshfs-askpass-"));
  const socketPath = path.join(socketDir, "password.sock");
  const server = net.createServer(socket => { socket.end(`${password}\n`); });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await fs.chmod(socketDir, 0o700);
    return await execute(command, args, {
      timeout,
      env: { SSH_ASKPASS: `${process.execPath} ${path.join(__dirname, "askpass.js")}`, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || ":0", SSHFS_PANEL_ASKPASS_SOCKET: socketPath }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(socketDir, { recursive: true, force: true });
  }
}

async function probeRemoteDirectory(profile, method) {
  const methods = method ? [method] : profile.methods;
  for (const candidate of methods) {
    if (candidate === "key") {
      try { await fs.access(profile.keyPath); } catch { continue; }
    }
    const args = buildProbeArgs(profile, candidate);
    const result = await execute("ssh", args, { timeout: 12000 });
    if (result.code !== 0 || result.timedOut) continue;
    const directory = parseRemoteDirectory(result.stdout);
    if (directory) return { directory, method: candidate };
  }
  throw error("Não foi possível consultar a pasta por SSH. Confira autenticação, IP, porta e se o shell remoto aceita pwd -P.", 422);
}

function transportFailure(stderr) {
  return /(?:could not resolve hostname|name or service not known|network is unreachable|no route to host|connection timed out|connection refused|address family not supported)/i.test(stderr);
}

function mountFailure(result) {
  const output = result.stderr;
  if (result.timedOut) return "Tempo esgotado aguardando a conexão SSH/SFTP.";
  if (/host key verification failed|remote host identification has changed|offending .*key/i.test(output)) return "Chave do host recusada ou alterada. Confira a identidade do servidor em known_hosts.";
  if (/permission denied \((?:publickey|password|keyboard-interactive|[^)]*)\)|authentication failed|too many authentication failures/i.test(output)) return "Autenticação recusada. Confira usuário, senha ou chave SSH.";
  if (/could not resolve hostname|name or service not known/i.test(output)) return "Host não encontrado. Confira IP ou domínio.";
  if (/connection refused/i.test(output)) return "Conexão recusada. Confira a porta e se o sshd está ativo no Termux.";
  if (/network is unreachable|no route to host|connection timed out/i.test(output)) return "Rede inacessível ou conexão expirada. Confira IP, Wi-Fi e firewall.";
  if (/subsystem request failed|subsystem .* not found|sftp-server: not found|sftp server .*not found/i.test(output)) return "SFTP não está disponível no servidor. No Termux, confira a instalação do pacote openssh.";
  if (/read: connection reset by peer|connection closed|remote host closed/i.test(output)) return "O servidor fechou a conexão. Confira se o subsistema SFTP está disponível.";
  if (/mountpoint is not empty|fuse: .*permission denied|failed to open \/dev\/fuse/i.test(output)) return "Não foi possível usar a pasta de montagem ou o FUSE local. Confira as permissões.";
  return "SSHFS não conseguiu montar. Teste SFTP no terminal para verificar o subsistema remoto.";
}

async function connect(profile, password) {
  await mountDirectory(profile.local);
  if (await mounted(profile.local)) throw error("Já existe uma montagem nessa pasta.");
  const attempts = [];
  for (const method of profile.methods) {
    if (method === "password" && !password) { attempts.push("Senha: não informada."); continue; }
    if (method === "key") {
      try { await fs.access(profile.keyPath); } catch { attempts.push("Chave: arquivo não encontrado ou inacessível."); continue; }
    }
    let remoteDirectory = "";
    if (method !== "password") {
      try { remoteDirectory = (await probeRemoteDirectory(profile, method)).directory; }
      catch { /* Sem SSH autenticado, o SFTP pode ainda determinar a pasta padrão. */ }
    }
    const modes = profile.mode === "auto" || !profile.mode ? ["direct", "ipv4", "ipv6"] : [profile.mode];
    for (const mode of modes) {
      const args = buildMountArgs(profile, method, mode, remoteDirectory);
      const result = await execute("sshfs", args, { timeout: 16000 });
      if (await mounted(profile.local)) {
        try {
          await fs.readdir(profile.local);
          return { method, mode, location: profile.local, remoteDirectory: remoteDirectory || null };
        } catch {
          await execute("fusermount3", ["-u", profile.local], { timeout: 5000 });
          throw error("O SSHFS montou, mas não conseguiu listar a pasta remota. A montagem foi desfeita; confira as permissões da pasta inicial no SFTP.", 422);
        }
      }
      // Não expor stderr bruto: pode conter caminhos e dados sensíveis.
      if (profile.mode === "auto" && mode !== "ipv6" && transportFailure(result.stderr)) continue;
      attempts.push(`${{ agent: "Agente SSH", key: "Chave privada", password: "Senha" }[method]}: ${mountFailure(result)}`);
      break;
    }
  }
  throw error(`Não foi possível montar. ${attempts.join(" ")}`, 422);
}

function checkPort(host, port, timeout = 2500) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = reachable => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function withLock(id, task) {
  if (busy.has(id)) throw error("Já existe uma operação em andamento para este perfil.", 409);
  busy.add(id);
  try { return await task(); } finally { busy.delete(id); }
}

async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 16384) throw error("Requisição muito grande.", 413);
  }
  try { return JSON.parse(data || "{}"); } catch { throw error("JSON inválido."); }
}

function reply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(data));
}

async function handler(req, res) {
  try {
    const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    if (!allowedHosts.includes(req.headers.host)) throw error("Host não permitido.", 403);
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") {
        if (!req.headers.origin || !allowedHosts.some(h => req.headers.origin === `http://${h}`) || req.headers["x-panel-token"] !== token || !req.headers["content-type"]?.startsWith("application/json")) throw error("Requisição não autorizada.", 403);
      }
      if (req.method === "GET" && url.pathname === "/api/profiles") {
        const items = await profiles();
        // Uma única tentativa TCP curta por perfil; não autentica e não inicia montagem.
        const statuses = await Promise.all(items.map(async p => {
          const [mountState, portReachable] = await Promise.all([mounted(p.local), checkPort(p.host, p.port)]);
          return { ...p, mounted: mountState, portReachable, busy: busy.has(p.id) };
        }));
        return reply(res, 200, { profiles: statuses, token });
      }
      if (req.method === "POST" && url.pathname === "/api/profiles") {
        const item = validate(await body(req));
        const items = await profiles();
        const index = items.findIndex(p => p.id === item.id);
        if (index >= 0) {
          if (await mounted(items[index].local)) throw error("Desmonte antes de editar o perfil.");
          items[index] = item;
        } else { item.id = crypto.randomUUID(); items.push(item); }
        await writeProfile(item);
        return reply(res, 200, { profile: item });
      }
      const match = url.pathname.match(/^\/api\/profiles\/([a-f0-9-]{36})\/(mount|unmount|delete|open|probe)$/);
      if (req.method === "POST" && match) {
        const [, id, action] = match;
        return reply(res, 200, await withLock(id, async () => {
          const items = await profiles();
          const saved = items.find(p => p.id === id);
          if (!saved) throw error("Perfil não encontrado.", 404);
          const profile = validate(saved);
          if (action === "probe") return { result: await probeRemoteDirectory(profile) };
          if (action === "mount") {
            const { password } = await body(req);
            if (password !== undefined && (typeof password !== "string" || password.length > 1024 || /[\r\n\x00]/.test(password))) throw error("Senha inválida.");
            return { result: await connect(profile, password) };
          }
          if (action === "open") {
            const source = await mounted(profile.local);
            if (!source.startsWith("fuse.sshfs ")) throw error("Monte a conexão antes de abrir a pasta.");
            if (source.endsWith(":/")) throw error("Esta montagem antiga aponta para a raiz remota. Desmonte e monte novamente para acessar a pasta inicial do SFTP.", 422);
            const location = profile.local;
            const result = await execute("xdg-open", [location], { timeout: 5000 });
            if (result.code !== 0 && !result.timedOut) throw error("Não foi possível abrir o gerenciador de arquivos. Abra a pasta de montagem manualmente.", 422);
            return { location };
          }
          if (action === "unmount") {
            const source = await mounted(profile.local);
            if (!source.startsWith("fuse.sshfs ")) throw error("Esta pasta não contém uma montagem SSHFS.");
            const result = await execute("fusermount3", ["-u", profile.local]);
            if (result.code !== 0) throw error("Falha ao desmontar. Feche arquivos abertos na pasta e tente novamente.", 422);
            return { ok: true };
          }
          if (await mounted(profile.local)) throw error("Desmonte antes de excluir o perfil.");
          await fs.unlink(connectionFile(id));
          return { ok: true };
        }));
      }
      if (req.method === "POST" && url.pathname === "/api/check") {
        const { host, port } = await body(req);
        const p = validate({ name: "Teste", host, port, user: "test", remote: "/", local: path.join(HOME, "sshfs-test"), methods: ["agent"] });
        const reachable = await checkPort(p.host, p.port, 5000);
        return reply(res, 200, { message: reachable ? "Porta acessível. Isso não confirma autenticação nem montagem." : "Porta não acessível agora. Confira dispositivo, IP, rede, firewall e porta." });
      }
      throw error("Rota não encontrada.", 404);
    }
    if (req.method !== "GET") throw error("Método não permitido.", 405);
    const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
    const file = files[url.pathname];
    if (!file) throw error("Página não encontrada.", 404);
    const content = await fs.readFile(path.join(STATIC, file[0]));
    res.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(content);
  } catch (err) { reply(res, err.status || 500, { error: err.status ? err.message : "Erro interno. Consulte o terminal para detalhes." }); if (!err.status) console.error(err); }
}

if (require.main === module) {
  try { requireNonRoot(); }
  catch (err) { console.error(err.message); process.exit(1); }
  http.createServer(handler).listen(PORT, HOST, () => console.log(`Painel SSHFS disponível em http://${HOST}:${PORT}`));
}
module.exports = { validate, handler, requireNonRoot, buildMountArgs, buildProbeArgs, parseRemoteDirectory, mountFailure };
