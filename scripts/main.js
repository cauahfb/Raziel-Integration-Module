const MODULE_ID = "raziel-integration";
const FLAG_SCOPE = "raziel-integration";

class RazielIntegrationApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "raziel-integration-app",
    tag: "section",
    window: {
      title: "Raziel Integration",
      icon: "fa-solid fa-wand-magic-sparkles",
      resizable: true
    },
    position: { width: 620, height: 620 },
    classes: ["raziel-integration-window"]
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/main.hbs` }
  };

  constructor(options = {}) {
    super(options);
    this.importData = null;
    this.selectedActorId = "";
    this.status = "Selecione o arquivo JSON exportado pelo Raziel.";
    this.statusType = "info";
    this.report = null;
    this.connectionMessage = "Integração remota ainda não configurada.";
    this.connectionType = "info";
  }

  async _prepareContext() {
    const actors = game.actors.contents
      .filter(actor => actor.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      .map(actor => ({ id: actor.id, name: actor.name, selected: actor.id === this.selectedActorId }));
    return {
      actors,
      selectedActorId: this.selectedActorId,
      status: this.status,
      statusType: this.statusType,
      report: this.report,
      hasImport: Boolean(this.importData),
      fileName: this.importData?.__fileName ?? "Nenhum arquivo selecionado",
      bridgeUrl: game.settings.get(MODULE_ID, "bridgeUrl") || "",
      anonKey: game.settings.get(MODULE_ID, "anonKey") || "",
      paired: Boolean(game.settings.get(MODULE_ID, "integrationToken")),
      connectionMessage: this.connectionMessage,
      connectionType: this.connectionType
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    root.querySelector("[data-action='save-bridge']")?.addEventListener("click", async () => {
      const url = root.querySelector("#raziel-bridge-url")?.value?.trim().replace(/\/$/, "");
      const anonKey = root.querySelector("#raziel-bridge-anon")?.value?.trim();
      if (!url || !/^https:\/\//.test(url) || !anonKey) {
        this.connectionMessage = "Informe a URL do projeto Supabase e a chave anon/public.";
        this.connectionType = "error";
        return this.render();
      }
      await game.settings.set(MODULE_ID, "bridgeUrl", url);
      await game.settings.set(MODULE_ID, "anonKey", anonKey);
      this.connectionMessage = "Configuração salva. Informe o código de pareamento gerado no site Raziel.";
      this.connectionType = "success";
      this.render();
    });
    root.querySelector("[data-action='pair']")?.addEventListener("click", async () => {
      await this.pairInstallation(root.querySelector("#raziel-pair-code")?.value?.trim());
    });
    root.querySelector("[data-action='unpair']")?.addEventListener("click", async () => {
      await this.unpairInstallation();
    });
    root.querySelector("#raziel-json-file")?.addEventListener("change", async event => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        validatePayload(parsed);
        parsed.__fileName = file.name;
        this.importData = parsed;
        this.status = `Arquivo validado: ${parsed.talents.length} talento(s) adquirido(s).`;
        this.statusType = "success";
        this.report = null;
      } catch (error) {
        this.importData = null;
        this.status = error.message || "Não foi possível ler o arquivo.";
        this.statusType = "error";
      }
      this.render();
    });

    root.querySelector("#raziel-actor-select")?.addEventListener("change", event => {
      this.selectedActorId = event.currentTarget.value;
    });

    root.querySelector("[data-action='sync']")?.addEventListener("click", async () => {
      await this.runSync();
    });
  }

  async bridgeRequest(action, body = {}, token = null) {
    const url = game.settings.get(MODULE_ID, "bridgeUrl");
    const anonKey = game.settings.get(MODULE_ID, "anonKey");
    if (!url || !anonKey) throw new Error("Configure a URL do Supabase e a chave anon/public primeiro.");
    const bearer = token || anonKey;
    const response = await fetch(`${url}/functions/v1/raziel-foundry-bridge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": anonKey,
        "Authorization": `Bearer ${bearer}`
      },
      body: JSON.stringify({ action, ...body })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Falha na comunicação (${response.status}).`);
    return result;
  }

  async pairInstallation(code) {
    try {
      if (!game.user.isGM) throw new Error("Somente o GM pode parear a instalação.");
      if (!code) throw new Error("Informe o código de pareamento gerado no Raziel.");
      const result = await this.bridgeRequest("pair", {
        code,
        installationName: game.world.title || "Foundry VTT",
        worldId: game.world.id
      });
      await game.settings.set(MODULE_ID, "integrationId", result.integration.id);
      await game.settings.set(MODULE_ID, "integrationToken", result.token);
      this.connectionMessage = "Instalação pareada. Aguardando comunicação com o Raziel.";
      this.connectionType = "success";
      startBridgePolling();
    } catch (error) {
      this.connectionMessage = error.message || "Não foi possível parear a instalação.";
      this.connectionType = "error";
    }
    this.render();
  }

  async unpairInstallation() {
    try {
      const token = game.settings.get(MODULE_ID, "integrationToken");
      if (token) await this.bridgeRequest("revoke", {}, token);
      await game.settings.set(MODULE_ID, "integrationToken", "");
      await game.settings.set(MODULE_ID, "integrationId", "");
      this.connectionMessage = "Instalação desvinculada.";
      this.connectionType = "info";
    } catch (error) {
      this.connectionMessage = error.message || "Não foi possível desvincular.";
      this.connectionType = "error";
    }
    this.render();
  }

  async runSync() {
    if (!game.user.isGM) {
      this.status = "Somente o mestre pode executar a sincronização.";
      this.statusType = "error";
      return this.render();
    }
    if (!this.importData) {
      this.status = "Importe um arquivo JSON válido antes de sincronizar.";
      this.statusType = "error";
      return this.render();
    }
    const actor = game.actors.get(this.selectedActorId);
    if (!actor) {
      this.status = "Selecione uma ficha de personagem válida.";
      this.statusType = "error";
      return this.render();
    }
    if (actor.type !== "character") {
      this.status = "O MVP aceita somente fichas do tipo personagem.";
      this.statusType = "error";
      return this.render();
    }
    // A importação manual aplica o snapshot ao Actor selecionado pelo GM.
    // Nome e UUID do personagem de origem no JSON são apenas metadados;
    // a sincronização remota continua validando o UUID em processRemoteRequest.
    if (game.system.id !== "dnd5e") {
      this.status = "Este módulo foi preparado para o sistema D&D 5e.";
      this.statusType = "error";
      return this.render();
    }

    this.status = `Sincronizando ${actor.name}…`;
    this.statusType = "info";
    this.report = null;
    this.render();

    try {
      const report = await reconcileActor(actor, this.importData);
      this.report = report;
      this.status = "Sincronização concluída.";
      this.statusType = "success";
      ui.notifications.info(`Raziel: ${report.created} criada(s), ${report.updated} atualizada(s), ${report.deleted} removida(s).`);
    } catch (error) {
      console.error(`${MODULE_ID} | Erro na sincronização`, error);
      this.status = error.message || "Ocorreu um erro durante a sincronização.";
      this.statusType = "error";
      ui.notifications.error("Raziel: a sincronização não foi concluída. Consulte o console para detalhes.");
    }
    this.render();
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("O JSON não contém um objeto válido.");
  if (payload.source !== "raziel") throw new Error("O arquivo não foi exportado pelo Raziel.");
  if (payload.schemaVersion !== 1) throw new Error(`Versão de JSON não suportada: ${payload.schemaVersion ?? "ausente"}.`);
  if (payload.completeSnapshot !== true) throw new Error("O arquivo não está marcado como snapshot completo. Nenhuma ficha será alterada.");
  if (!payload.character?.name || !Array.isArray(payload.talents)) throw new Error("O arquivo precisa conter personagem e lista de talentos.");
  const ids = new Set();
  for (const talent of payload.talents) {
    if (!talent.id || !talent.name || !Number.isFinite(Number(talent.level)) || Number(talent.level) <= 0) {
      throw new Error("Existe um talento sem identificador, nome ou nível válido.");
    }
    if (ids.has(String(talent.id))) throw new Error(`O talento ${talent.name} aparece duplicado no JSON.`);
    ids.add(String(talent.id));
    if (talent.activities !== undefined && !Array.isArray(talent.activities)) throw new Error(`As atividades de ${talent.name} precisam ser uma lista.`);
    for (const activity of talent.activities ?? []) {
      if (!activity.id || !activity.name || !["attack", "save", "damage", "heal", "utility"].includes(activity.type)) throw new Error(`Existe uma atividade inválida no talento ${talent.name}.`);
    }
    if (talent.isSupreme === true || talent.type === "supreme") throw new Error("O pacote contém uma Suprema. Supremas não são sincronizadas pelo Raziel Integration.");
  }
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function richText(text) {
  const value = String(text ?? "").trim();
  if (!value) return "";
  return value.split(/\n{2,}/).map(paragraph =>
    `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`
  ).join("");
}

function talentDescription(talent) {
  const sections = [];
  const base = richText(talent.description || "");
  if (base) sections.push(base);

  const summaries = (talent.effects ?? [])
    .map(effect => String(effect.summary ?? "").trim())
    .filter(Boolean);
  if (summaries.length) {
    sections.push(`<h3>Benefícios</h3><ul>${summaries.map(summary => `<li>${escapeHtml(summary).replace(/\n/g, "<br>")}</li>`).join("")}</ul>`);
  }

  const activityNotes = (talent.activities ?? [])
    .filter(activity => String(activity.description ?? "").trim())
    .map(activity => `<li><strong>${escapeHtml(activity.name || "Atividade")}.</strong> ${escapeHtml(activity.description).replace(/\n/g, "<br>")}</li>`);
  if (activityNotes.length) sections.push(`<h3>Instruções das atividades</h3><ul>${activityNotes.join("")}</ul>`);

  return sections.join("") || "<p>Habilidade adquirida no Raziel.</p>";
}

function calculateEffectValue(effect, talent) {
  const params = effect.parameters ?? {};
  const baseRaw = params.value;
  const base = baseRaw === undefined || baseRaw === null || baseRaw === "" ? null : Number(baseRaw);
  const perLevel = Number(effect.scaling?.value_per_level);
  const levels = Number(talent.level ?? 1);
  if (effect.scaling?.basis === "acquired_levels" && Number.isFinite(perLevel)) {
    return base === null ? perLevel * levels : base + perLevel * Math.max(0, levels - 1);
  }
  return base;
}

function activeEffectMode(name, fallback) {
  return CONST.ACTIVE_EFFECT_MODES?.[name] ?? fallback;
}

function numericChange(key, value, mode = "ADD") {
  return { key, mode: activeEffectMode(mode, mode === "UPGRADE" ? 5 : 2), value: String(value), priority: 20 };
}

function normalizeMovementType(effect) {
  const raw = String(effect.parameters?.movement_type ?? effect.parameters?.movementType ?? "").toLowerCase();
  const target = String(effect.parameters?.target ?? "").toLowerCase();
  const fromTarget = target.match(/(?:^|_)(walk|walking|burrow|burrowing|climb|climbing|fly|flying|swim|swimming)(?:_speed)?$/)?.[1];
  const value = raw || fromTarget || "";
  return ({ walking: "walk", burrowing: "burrow", climbing: "climb", flying: "fly", swimming: "swim" })[value] ?? value;
}

function mapSupportedChanges(effect, talent) {
  const target = String(effect.parameters?.target ?? "").toLowerCase();
  const value = calculateEffectValue(effect, talent);
  if (!Number.isFinite(value) || value === 0) return [];

  // Alvos numéricos comuns do Raziel -> caminhos oficiais de Active Effects do D&D 5e.
  const directTargets = {
    maximum_hit_points: ["system.attributes.hp.bonuses.overall", "ADD"],
    armor_class: ["system.attributes.ac.bonus", "ADD"],
    initiative: ["system.attributes.init.roll.bonus", "ADD"],
    spell_save_dc: ["system.bonuses.spell.dc", "ADD"],
    spell_dc: ["system.bonuses.spell.dc", "ADD"],
    attack_roll: ["ALL_ATTACKS", "ADD"],
    attack_bonus: ["ALL_ATTACKS", "ADD"],
    damage_roll: ["ALL_DAMAGE", "ADD"],
    damage_bonus: ["ALL_DAMAGE", "ADD"],
    saving_throw: ["system.rolls.ability.save.bonus", "ADD"],
    saving_throw_bonus: ["system.rolls.ability.save.bonus", "ADD"],
    ability_check: ["system.rolls.ability.check.bonus", "ADD"],
    ability_check_bonus: ["system.rolls.ability.check.bonus", "ADD"],
    skill_check: ["system.rolls.ability.skill.bonus", "ADD"],
    skill_check_bonus: ["system.rolls.ability.skill.bonus", "ADD"],
    perception: ["system.skills.prc.roll.bonus", "ADD"],
    perception_bonus: ["system.skills.prc.roll.bonus", "ADD"],
    passive_perception: ["system.skills.prc.bonuses.passive", "ADD"],
    strength: ["system.abilities.str.value", "ADD"],
    dexterity: ["system.abilities.dex.value", "ADD"],
    constitution: ["system.abilities.con.value", "ADD"],
    intelligence: ["system.abilities.int.value", "ADD"],
    wisdom: ["system.abilities.wis.value", "ADD"],
    charisma: ["system.abilities.cha.value", "ADD"]
  };

  if (effect.type === "movement") {
    const movementType = normalizeMovementType(effect);
    if (!["walk", "burrow", "climb", "fly", "swim"].includes(movementType)) return [];
    // Mantém o valor informado pelo Raziel, sem conversão de unidade.
    return [numericChange(`system.attributes.movement.${movementType}`, value, "UPGRADE")];
  }

  if (effect.type !== "numeric_bonus") return [];
  const mapping = directTargets[target];
  if (!mapping) return [];
  if (mapping[0] === "ALL_ATTACKS") {
    return ["mwak", "rwak", "msak", "rsak"].map(type => numericChange(`system.bonuses.${type}.attack`, value));
  }
  if (mapping[0] === "ALL_DAMAGE") {
    return ["mwak", "rwak", "msak", "rsak"].map(type => numericChange(`system.bonuses.${type}.damage`, value));
  }
  return [numericChange(mapping[0], value, mapping[1])];
}

function stableActivityId(value) {
  const source = String(value ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9]/g, "");
  return (source + "RazielActivity").slice(0, 16).padEnd(16, "0");
}

function parseDamageFormula(formula, damageType) {
  const raw = String(formula ?? "").trim();
  if (!raw) return [];
  const match = raw.match(/^(\d*)\s*d\s*(\d+)(.*)$/i);
  let number = 0, denomination = 0, bonus = raw;
  if (match) {
    number = Number(match[1] || 1);
    denomination = Number(match[2]);
    bonus = String(match[3] ?? "").trim().replace(/^\+/, "").trim();
  }
  return [{
    number, denomination, bonus,
    types: damageType ? [String(damageType)] : [],
    custom: { enabled: false, label: "" }
  }];
}

function activityCommonData(activity, talent) {
  const id = stableActivityId(activity.id);
  const data = {
    _id: id,
    type: activity.type,
    name: String(activity.name || talent.name),
    img: talent.image || "icons/svg/aura.svg",
    description: { chatFlavor: richText(activity.description || "") },
    activation: { type: activity.activation?.type || "action", value: Number(activity.activation?.cost ?? 1), condition: "", override: true },
    consumption: { scaling: { allowed: false }, spellSlot: false, targets: [] },
    duration: { value: null, units: "inst", concentration: false },
    range: { value: null, long: null, units: "self", special: "" },
    target: {
      affects: { count: "", type: "" },
      template: { contiguous: false, type: "", size: "", width: "", height: "", count: "", units: "m" },
      prompt: true, override: true
    },
    uses: { spent: 0, max: "", recovery: [] },
    flags: { [FLAG_SCOPE]: {
      managed: true, talentId: String(talent.id), activityId: String(activity.id ?? id), source: "raziel",
      originalRangeUnit: activity.range?.unit ?? null, originalTargetUnit: activity.target?.units ?? null
    }}
  };
  if (activity.range) data.range = { value: activity.range.value ?? null, long: null, units: activity.range.unit || "m", special: "" };
  if (activity.target?.type && activity.target?.value !== undefined) {
    data.target.template = { contiguous: false, type: activity.target.type, size: String(activity.target.value), width: "", height: "", count: "", units: activity.target.units || "m" };
  }
  return data;
}

function buildNativeActivity(activity, talent) {
  const data = activityCommonData(activity, talent);
  if (activity.type === "save") {
    const dc = activity.save?.dc ?? {};
    data.save = {
      ability: activity.save?.ability ? [activity.save.ability] : [],
      dc: { calculation: dc.type === "fixed" ? "flat" : "spellcasting", formula: dc.type === "fixed" ? String(dc.value ?? 0) : "" }
    };
    data.damage = { onSave: activity.damage?.halfOnSuccess ? "half" : "none", parts: parseDamageFormula(activity.damage?.formula, activity.damage?.type) };
  } else if (activity.type === "attack") {
    data.attack = {
      ability: activity.attack?.ability === "spellcasting" ? "" : (activity.attack?.ability || "str"),
      bonus: "", critical: { threshold: null }, flat: false,
      type: { value: "melee", classification: activity.attack?.type || "spell" }
    };
    data.damage = { parts: parseDamageFormula(activity.damage?.formula, activity.damage?.type), includeBase: false, critical: { allow: false, bonus: "" } };
  } else if (activity.type === "damage") {
    data.damage = { parts: parseDamageFormula(activity.damage?.formula, activity.damage?.type), onSave: "none" };
  } else if (activity.type === "heal") {
    data.healing = { number: 0, denomination: 0, bonus: String(activity.healing?.formula ?? ""), types: ["healing"], custom: { enabled: false, label: "" } };
  } else if (activity.type === "utility") {
    data.roll = { prompt: false, formula: "", name: "" };
  }
  return data;
}

function buildNativeActivities(talent) {
  const result = {};
  for (const activity of talent.activities ?? []) {
    if (!activity || !activity.id || !activity.type) continue;
    const data = buildNativeActivity(activity, talent);
    result[data._id] = data;
  }
  return result;
}

async function replaceManagedActivities(item, talent) {
  const current = item.toObject().system?.activities ?? {};
  const merged = {};
  for (const [id, activity] of Object.entries(current)) {
    if (activity?.flags?.[FLAG_SCOPE]?.managed !== true) merged[id] = activity;
  }
  const incoming = buildNativeActivities(talent);
  Object.assign(merged, incoming);
  await item.update({ "system.activities": merged });
  return Object.keys(incoming).length;
}

function buildFeatureData(talent) {
  return {
    name: String(talent.name),
    type: "feat",
    img: talent.image || "icons/svg/aura.svg",
    system: {
      description: { value: talentDescription(talent) },
      requirements: "Desbloqueado pelo Raziel",
      activities: buildNativeActivities(talent)
    },
    flags: {
      [FLAG_SCOPE]: {
        managed: true,
        talentId: String(talent.id),
        tree: String(talent.tree ?? ""),
        acquiredLevel: Number(talent.level),
        source: "raziel",
        schemaVersion: 1,
        activationDefinitions: (talent.effects ?? []).map(effect => effect.activation).filter(Boolean)
      }
    }
  };
}

async function replaceManagedEffects(item, talent) {
  const existing = item.effects.contents.filter(effect => effect.getFlag(FLAG_SCOPE, "managed") === true);
  if (existing.length) await item.deleteEmbeddedDocuments("ActiveEffect", existing.map(effect => effect.id));

  const effectsToCreate = [];
  for (const effect of talent.effects ?? []) {
    const changes = mapSupportedChanges(effect, talent);
    if (!changes.length) continue;
    effectsToCreate.push({
      name: effect.name || talent.name,
      img: talent.image || "icons/svg/aura.svg",
      icon: talent.image || "icons/svg/aura.svg",
      origin: item.uuid,
      disabled: false,
      transfer: true,
      changes,
      flags: {
        [FLAG_SCOPE]: {
          managed: true,
          effectId: String(effect.id),
          talentId: String(talent.id),
          source: "raziel"
        }
      }
    });
  }
  if (effectsToCreate.length) await item.createEmbeddedDocuments("ActiveEffect", effectsToCreate);
  return { applied: effectsToCreate.length, unsupported: (talent.effects ?? []).filter(effect => !mapSupportedChanges(effect, talent).length).length };
}

async function reconcileActor(actor, payload) {
  validatePayload(payload);
  const incoming = new Map(payload.talents.map(talent => [String(talent.id), talent]));
  const existingManaged = actor.items.contents.filter(item => item.getFlag(FLAG_SCOPE, "managed") === true);
  const existingByTalent = new Map(existingManaged.map(item => [String(item.getFlag(FLAG_SCOPE, "talentId")), item]));
  const report = { created: 0, updated: 0, deleted: 0, effectsApplied: 0, activitiesCreated: 0, unsupportedEffects: 0, features: [] };

  // Primeiro cria/atualiza todas as Features. A remoção de itens obsoletos
  // fica para o final, reduzindo o risco de perda em uma sincronização parcial.
  for (const [talentId, talent] of incoming) {
    const data = buildFeatureData(talent);
    let item = existingByTalent.get(talentId);
    if (!item) {
      [item] = await actor.createEmbeddedDocuments("Item", [data]);
      report.created++;
    } else {
      await item.update({
        name: data.name,
        img: data.img,
        "system.description.value": data.system.description.value,
        "system.requirements": data.system.requirements,
        [`flags.${FLAG_SCOPE}.managed`]: true,
        [`flags.${FLAG_SCOPE}.talentId`]: talentId,
        [`flags.${FLAG_SCOPE}.tree`]: data.flags[FLAG_SCOPE].tree,
        [`flags.${FLAG_SCOPE}.acquiredLevel`]: data.flags[FLAG_SCOPE].acquiredLevel,
        [`flags.${FLAG_SCOPE}.activationDefinitions`]: data.flags[FLAG_SCOPE].activationDefinitions
      });
      report.updated++;
    }
    const effectReport = await replaceManagedEffects(item, talent);
    const activitiesCreated = await replaceManagedActivities(item, talent);
    report.activitiesCreated += activitiesCreated;
    report.effectsApplied += effectReport.applied;
    report.unsupportedEffects += effectReport.unsupported;
    report.features.push({ name: talent.name, level: talent.level, effectsApplied: effectReport.applied, activitiesCreated, unsupportedEffects: effectReport.unsupported });
  }

  // Só removemos itens gerenciados quando o arquivo declara snapshot completo.
  const stale = existingManaged.filter(item => !incoming.has(String(item.getFlag(FLAG_SCOPE, "talentId"))));
  if (stale.length) {
    await actor.deleteEmbeddedDocuments("Item", stale.map(item => item.id));
    report.deleted = stale.length;
  }
  return report;
}

let bridgePolling = false;
let remoteRequestInProgress = false;

async function bridgeCall(action, body = {}) {
  const url = game.settings.get(MODULE_ID, "bridgeUrl");
  const anonKey = game.settings.get(MODULE_ID, "anonKey");
  const token = game.settings.get(MODULE_ID, "integrationToken");
  if (!url || !anonKey || !token) throw new Error("Integração remota não configurada.");
  const response = await fetch(`${url}/functions/v1/raziel-foundry-bridge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": anonKey, "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ action, ...body })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Erro HTTP ${response.status}`);
  return result;
}

function previewActor(actor, payload) {
  const incoming = new Map(payload.talents.map(talent => [String(talent.id), talent]));
  const managed = actor.items.contents.filter(item => item.getFlag(FLAG_SCOPE, "managed") === true);
  const byTalent = new Map(managed.map(item => [String(item.getFlag(FLAG_SCOPE, "talentId")), item]));
  let created = 0, updated = 0, activities = 0, effects = 0;
  for (const [id, talent] of incoming) {
    if (byTalent.has(id)) updated++; else created++;
    activities += (talent.activities ?? []).length;
    effects += (talent.effects ?? []).length;
  }
  const removed = managed.filter(item => !incoming.has(String(item.getFlag(FLAG_SCOPE, "talentId")))).length;
  return { created, updated, deleted: removed, activities, effects, character: actor.name };
}

async function processRemoteRequest(request) {
  if (remoteRequestInProgress) return;
  remoteRequestInProgress = true;
  try {
    validatePayload(request.payload);
    const actorId = String(request.actor_uuid || "Actor.khbUpl3bQVdtB3Ms").replace(/^Actor\./, "");
    const actor = game.actors.get(actorId);
    if (!actor || actor.type !== "character") throw new Error(`O Actor ${request.actor_uuid} não foi encontrado neste mundo.`);
    if (game.system.id !== "dnd5e") throw new Error("A integração exige o sistema D&D 5e.");
    const preview = previewActor(actor, request.payload);
    await bridgeCall("preview", { requestId: request.id, preview });

    const confirmed = await Dialog.confirm({
      title: "Raziel — Confirmar sincronização",
      content: `<p>O Raziel solicitou a sincronização de <strong>${escapeHtml(actor.name)}</strong>.</p>
        <ul>
          <li>${preview.created} talento(s) a criar</li>
          <li>${preview.updated} talento(s) a atualizar</li>
          <li>${preview.deleted} talento(s) a remover</li>
          <li>${preview.effects} benefício(s) passivo(s)</li>
          <li>${preview.activities} atividade(s)</li>
        </ul><p>Deseja aplicar essas alterações?</p>`,
      yes: () => true,
      no: () => false,
      defaultYes: false
    });

    if (!confirmed) {
      await bridgeCall("respond", { requestId: request.id, status: "cancelled", result: { message: "Cancelado pelo GM." } });
      ui.notifications.info("Raziel: sincronização cancelada pelo GM.");
      return;
    }
    const report = await reconcileActor(actor, request.payload);
    await bridgeCall("respond", { requestId: request.id, status: "completed", result: report });
    ui.notifications.info(`Raziel: ${report.created} criada(s), ${report.updated} atualizada(s), ${report.deleted} removida(s).`);
  } catch (error) {
    console.error(`${MODULE_ID} | Falha na sincronização remota`, error);
    try {
      await bridgeCall("respond", { requestId: request.id, status: "failed", errorMessage: error.message });
    } catch (reportError) {
      console.error(`${MODULE_ID} | Não foi possível devolver o erro ao Raziel`, reportError);
    }
    ui.notifications.error(`Raziel: ${error.message || "Falha na sincronização remota."}`);
  } finally {
    remoteRequestInProgress = false;
  }
}

function startBridgePolling() {
  if (bridgePolling || !game.user.isGM) return;
  bridgePolling = true;
  const poll = async () => {
    if (!game.user.isGM || !game.settings.get(MODULE_ID, "integrationToken")) {
      bridgePolling = false;
      return;
    }
    if (!remoteRequestInProgress) {
      try {
        const result = await bridgeCall("poll");
        if (result.pending && result.request) await processRemoteRequest(result.request);
      } catch (error) {
        console.warn(`${MODULE_ID} | Conexão com Raziel indisponível`, error.message);
      }
    }
    window.setTimeout(poll, 10000);
  };
  void poll();
}

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Inicializando Raziel Integration`);
  game.settings.register(MODULE_ID, "bridgeUrl", { name: "URL do Supabase", scope: "world", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "anonKey", { name: "Chave pública Supabase", scope: "world", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "integrationId", { name: "ID da integração", scope: "world", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "integrationToken", { name: "Token da integração", scope: "user", config: false, type: String, default: "" });
  game.settings.registerMenu(MODULE_ID, "openPanel", {
    name: "Raziel Integration",
    label: "Abrir painel",
    hint: "Importe um JSON completo exportado pelo Raziel e sincronize as Features de um personagem.",
    icon: "fas fa-wand-magic-sparkles",
    type: RazielIntegrationApp,
    restricted: true
  });
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    ui.notifications.warn("Raziel Integration foi desenvolvido para D&D 5e.");
  }
  game.razielIntegration = {
    open: () => {
      if (!game.user.isGM) return ui.notifications.warn("Somente o mestre pode abrir o Raziel Integration.");
      return new RazielIntegrationApp().render({ force: true });
    },
    reconcileActor
  };
  if (game.user.isGM && game.settings.get(MODULE_ID, "integrationToken")) startBridgePolling();
  console.log(`${MODULE_ID} | Pronto. Abra Configurações > Raziel Integration > Abrir painel.`);
});
