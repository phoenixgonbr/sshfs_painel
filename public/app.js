"use strict";

const $ = selector => document.querySelector(selector);
let items = [];
let token = "";
let editing = null;
let pendingMount = null;
let noticeTimer;
const pendingActions = new Set();
const probedPaths = new Map();

function notify(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `show${isError ? " error" : ""}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.className = ""; }, 6500);
}

async function api(route, data) {
  const options = data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Panel-Token": token }, body: JSON.stringify(data) };
  let response;
  try { response = await fetch(route, options); }
  catch { throw new Error("Painel local indisponível. Inicie 'npm start' sem sudo e recarregue http://127.0.0.1:4173."); }
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Erro na operação.");
  return json;
}

function cell(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

function action(label, className, handler, disabled = false, busyKey = "") {
  const button = cell("button", className, label);
  button.type = "button";
  button.disabled = disabled;
  if (busyKey && pendingActions.has(busyKey)) {
    button.disabled = true;
    button.classList.add("loading");
    button.textContent = "Processando…";
  }
  button.addEventListener("click", handler);
  return button;
}

function render() {
  const list = $("#list");
  list.replaceChildren();
  $("#count").textContent = items.length;
  $("#subtitle").textContent = items.length === 1 ? "1 perfil configurado" : `${items.length} perfis configurados`;
  if (!items.length) {
    const empty = cell("div", "empty", "");
    empty.append(cell("div", "empty-icon", "⇄"), cell("strong", "Nenhuma conexão ainda"), cell("p", "Crie seu primeiro perfil para montar uma pasta remota."));
    list.append(empty);
    return;
  }
  for (const item of items) {
    const card = cell("article", "card", "");
    const top = cell("div", "card-top", "");
    const info = cell("div", "", "");
    info.append(cell("div", "card-title", item.name), cell("div", "card-host", `${item.user}@${item.host}:${item.port}`));
    const states = cell("div", "states", "");
    const availability = cell("span", `state ${item.portReachable ? "reachable" : "unreachable"}`, item.portReachable ? "● Porta acessível" : "○ Porta indisponível");
    availability.title = "Verificação TCP da porta SSH; não confirma login, SFTP ou montagem.";
    states.append(availability, cell("span", `state${item.mounted ? " connected" : ""}`, item.mounted ? "● Pasta montada" : "○ Pasta não montada"));
    top.append(cell("div", "server-icon", "▤"), info, states);
    const detail = cell("div", "card-detail", "");
    for (const [label, value] of [["Pasta remota", "Pasta inicial do SFTP (home do usuário)"], ["Disponível no Linux em", item.local]]) {
      const block = cell("div", "", "");
      block.append(cell("span", "detail-label", label), cell("span", "detail-value", value));
      detail.append(block);
    }
    const discovered = probedPaths.get(item.id);
    if (discovered) {
      const block = cell("div", "", "");
      block.append(cell("span", "detail-label", "Pasta encontrada no SSH"), cell("span", "detail-value", discovered));
      detail.append(block);
    }
    const buttons = cell("div", "card-actions", "");
    buttons.append(action("Testar SSH", "", () => probe(item), item.busy, `${item.id}:probe`));
    if (item.mounted) buttons.append(action("Abrir pasta", "connect", () => operate(item, "open"), item.busy, `${item.id}:open`));
    buttons.append(action("Editar", "", () => openEditor(item), item.busy || !!item.mounted));
    buttons.append(action("Excluir", "", () => remove(item), item.busy || !!item.mounted));
    buttons.append(item.mounted ? action("Desmontar", "connect", () => operate(item, "unmount"), item.busy, `${item.id}:unmount`) : action("↗ Montar", "connect", () => startMount(item), item.busy, `${item.id}:mount`));
    detail.append(buttons);
    card.append(top, detail);
    list.append(card);
  }
}

async function refresh() {
  try {
    const data = await api("/api/profiles");
    token = data.token;
    items = data.profiles;
    $("#server-status").textContent = "Servidor local ativo";
    $("#server-dot").classList.remove("offline");
    render();
  } catch (err) {
    $("#server-status").textContent = "Servidor local indisponível";
    $("#server-dot").classList.add("offline");
    notify(err.message, true);
  }
}

function openEditor(item = null) {
  editing = item?.id || null;
  const form = $("#form");
  form.reset();
  $("#form-title").textContent = item ? "Editar conexão" : "Nova conexão";
  $("#check-result").textContent = "";
  if (item) {
    for (const key of ["name", "host", "port", "user", "keyPath", "jumpHost", "jumpUser", "jumpPort"]) form.elements[key].value = item[key] ?? "";
    form.elements.mode.value = item.mode || "auto";
    for (const input of form.querySelectorAll('[name="methods"]')) input.checked = item.methods.includes(input.value);
    for (const input of form.querySelectorAll('[name="options"]')) input.checked = (item.options || []).includes(input.value);
  }
  toggleKey();
  toggleJump();
  $("#editor").showModal();
}

function toggleKey() { $("#key-field").hidden = !$('#form input[value="key"]').checked; }
function toggleJump() { $("#jump-fields").hidden = $("#mode").value !== "jump"; }

async function operate(item, actionName, payload = {}) {
  const busyKey = `${item.id}:${actionName}`;
  pendingActions.add(busyKey);
  render();
  try {
    const data = await api(`/api/profiles/${item.id}/${actionName}`, payload);
    if (actionName === "mount") {
      if (data.result.remoteDirectory) probedPaths.set(item.id, data.result.remoteDirectory);
      notify("Conexão montada. Clique em “Abrir pasta” para navegar pelos arquivos remotos.");
    }
    else if (actionName === "unmount") notify("Pasta desmontada com sucesso.");
    else if (actionName === "delete") { probedPaths.delete(item.id); notify("Conexão excluída."); }
  } catch (err) { notify(err.message, true); }
  pendingActions.delete(busyKey);
  await refresh();
}

async function probe(item, password) {
  const busyKey = `${item.id}:probe`;
  pendingActions.add(busyKey);
  render();
  try {
    const data = await api(`/api/profiles/${item.id}/probe`, password ? { password } : {});
    probedPaths.set(item.id, data.result.directory);
    render();
    notify("Pasta inicial encontrada por SSH. Isso não confirma a montagem SSHFS.");
  } catch (err) { notify(err.message, true); }
  pendingActions.delete(busyKey);
  await refresh();
}

function startMount(item) {
  if (item.methods.includes("password")) {
    pendingMount = item;
    $("#password-form").reset();
    $("#password-dialog").showModal();
  } else operate(item, "mount");
}

async function remove(item) {
  if (!confirm(`Excluir o perfil “${item.name}”? A pasta local e seus arquivos não serão removidos.`)) return;
  await operate(item, "delete");
}

$("#new").addEventListener("click", () => openEditor());
$("#refresh").addEventListener("click", refresh);
$("#close").addEventListener("click", () => $("#editor").close());
$("#password-close").addEventListener("click", () => $("#password-dialog").close());
$("#form").addEventListener("change", () => { toggleKey(); toggleJump(); });
$("#form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.methods = [...form.querySelectorAll('[name="methods"]:checked')].map(input => input.value);
  data.options = [...form.querySelectorAll('[name="options"]:checked')].map(input => input.value);
  if (editing) {
    data.id = editing;
    // Perfis antigos conservam a pasta local já usada, inclusive montagens existentes.
    const previous = items.find(item => item.id === editing);
    if (previous) data.local = previous.local;
    probedPaths.delete(editing);
  }
  try {
    await api("/api/profiles", data);
    $("#editor").close();
    notify("Conexão salva com sucesso.");
    await refresh();
  } catch (err) { notify(err.message, true); }
});
$("#check").addEventListener("click", async () => {
  const form = $("#form");
  const result = $("#check-result");
  result.textContent = "Testando...";
  try { result.textContent = (await api("/api/check", { host: form.elements.host.value, port: form.elements.port.value })).message; }
  catch (err) { result.textContent = err.message; }
});
$("#password-form").addEventListener("submit", event => {
  event.preventDefault();
  const password = event.currentTarget.elements.password.value;
  event.currentTarget.reset();
  $("#password-dialog").close();
  if (pendingMount) operate(pendingMount, "mount", { password });
  pendingMount = null;
});
refresh();
