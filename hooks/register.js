// node_modules/@cmodjs/core/hotkeys.js
var hotkeyName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
var comboShape = /^(?:(?:ctrl|alt|shift|meta)\+){1,2}(?:[a-z0-9]|f(?:[1-9]|1[0-2])|tab|enter|escape|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|[`\-=[\]\\;',./])$/;
var order = ["ctrl", "alt", "shift", "meta"];
function isCombo(value) {
  if (typeof value !== "string" || !comboShape.test(value))
    return false;
  const modifiers = value.split("+").slice(0, -1);
  return modifiers.every((each, index) => index === 0 || order.indexOf(each) > order.indexOf(modifiers[index - 1]));
}
function checkHotkeys(name, hotkeys) {
  const combos = new Map;
  for (const [key, declared] of Object.entries(hotkeys)) {
    const at = `${name}: hotkeys.${key}`;
    if (!hotkeyName.test(key))
      throw new Error(`${at} is not a hotkey name. Use letters, digits, and _, starting with a letter.`);
    if (declared.title.trim() === "")
      throw new Error(`${at} needs a title, the label Settings shows beside its combo.`);
    if (declared.default === undefined)
      continue;
    if (!isCombo(declared.default))
      throw new Error(`${at} defaults to "${String(declared.default)}", which is not a combo. Give one or two of ctrl, alt, shift, meta in that order, then a key, such as "ctrl+q" or "ctrl+shift+k".`);
    const taken = combos.get(declared.default);
    if (taken !== undefined)
      throw new Error(`${at} defaults to ${declared.default}, which hotkeys.${taken} has too. Give each hotkey its own combo.`);
    combos.set(declared.default, key);
  }
  return hotkeys;
}

// node_modules/@cmodjs/core/installer.js
var stepId = /^[A-Za-z0-9_-]{1,64}$/;
function checkSteps(name, steps) {
  const seen = new Set;
  for (const step of steps) {
    if (!stepId.test(step.id))
      throw new Error(`${name}: the install step "${step.id}" has no valid id. Use 1 to 64 letters, digits, "_", or "-".`);
    if (step.title.trim() === "")
      throw new Error(`${name}: the install step "${step.id}" needs a title, the line the installer shows above it.`);
    if (seen.has(step.id))
      throw new Error(`${name}: two install steps have the id "${step.id}". Give each step its own id.`);
    seen.add(step.id);
  }
}

// node_modules/@cmodjs/core/utils/text.js
function listed(items) {
  if (items.length <= 1)
    return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
function firstLine(text) {
  return text.split(`
`).find((line) => line.trim() !== "")?.trim() ?? "";
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function formatExit(code, reason) {
  const exit = code === null ? "was stopped by a signal" : `exited ${code}`;
  const clause = reason.trim().replace(/[.!?]+$/, "");
  return clause ? `${exit}: ${clause}` : exit;
}

// node_modules/@cmodjs/core/records.js
var listPermissions = ["network", "run", "files", "config"];
var flagPermissions = ["conversation", "prompt", "model", "tasks", "tools", "approve"];
var permissionNames = [...listPermissions, ...flagPermissions];
var hostName = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
var programName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
var releaseVersion = /^\d+\.\d+\.\d+$/;
var settingPath = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9_@-]+)*$/;
var listItemHint = {
  network: 'a host alone, such as "api.github.com", or a socket path, such as "/var/run/docker.sock"',
  run: `a program's command, such as "gh"`,
  files: 'a path that starts with ~/ or /, such as "~/.zshrc"',
  config: `a Claude Code setting's name, or a key path inside one, such as "cleanupPeriodDays" or "env.ANTHROPIC_BASE_URL"`
};
var pluginName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function storeFolder(env) {
  const dataHome = env["XDG_DATA_HOME"];
  const home = env["HOME"];
  if (dataHome)
    return `${dataHome}/cmod`;
  if (!home)
    throw new Error("Neither XDG_DATA_HOME nor HOME is set, so the cmod store has no folder. Set HOME.");
  return `${home}/.local/share/cmod`;
}
function recordPath(store, name) {
  return `${store}/records/${checkedName(name)}.json`;
}
function programPath(store, program, version) {
  return `${store}/bin/${checkedName(program)}/${version}/${program}`;
}
function isProgramNewer(record, programModifiedMs) {
  return record.program !== null && (programModifiedMs === undefined || programModifiedMs > Date.parse(record.installedAt));
}
async function readCmodVersion(files, store) {
  if (!await files.exists(`${store}/programs/cmod`))
    return;
  const newestFirst = (await files.list(`${store}/bin/cmod`)).filter((name) => releaseVersion.test(name)).toSorted((one, other) => isAtLeast(one, other) ? -1 : 1);
  for (const version of newestFirst)
    if (await files.exists(programPath(store, "cmod", version)))
      return version;
  return;
}
function dataFolder(store, name) {
  return `${store}/data/${checkedName(name)}`;
}
function configFolder(env, name) {
  const configRoot = env["CLAUDE_CONFIG_DIR"];
  const home = env["HOME"];
  if (configRoot)
    return `${configRoot}/cmods/${checkedName(name)}`;
  if (!home)
    throw new Error(`Neither CLAUDE_CONFIG_DIR nor HOME is set, so ${name} has no config folder. Set HOME.`);
  return `${home}/.claude/cmods/${checkedName(name)}`;
}
function configFolders(env, name, root) {
  return [
    { tier: "system", folder: configFolder(env, name) },
    { tier: "project", folder: `${root}/.claude/cmods/${checkedName(name)}` }
  ];
}
function checkedName(name) {
  if (!pluginName.test(name) || name.includes("..")) {
    throw new Error(`"${name}" is not a plugin name: use letters, digits, ".", "_", and "-", starting with a letter or digit.`);
  }
  return name;
}
async function readRecord(read, store, name) {
  const path = recordPath(store, name);
  const text = await read(path);
  if (text === undefined)
    return;
  return parseRecord(text, path);
}
function parseRecord(text, path) {
  const fix = `Delete ${path} and run cmod setup on the plugin again.`;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON (${messageOf(error)}). ${fix}`);
  }
  if (!isObject(value))
    throw new Error(`${path} is not a cmod install record. ${fix}`);
  for (const key of ["name", "version", "root", "installedAt", "scriptsSha256"]) {
    if (typeof value[key] !== "string")
      throw new Error(`${path} has no "${key}" text. ${fix}`);
  }
  const uninstall = value["uninstall"];
  if (uninstall !== null && typeof uninstall !== "string")
    throw new Error(`${path} has an "uninstall" that is neither a path nor null. ${fix}`);
  const program = value["program"];
  if (program !== null && typeof program !== "string")
    throw new Error(`${path} has a "program" that is neither a command name nor null. ${fix}`);
  const keys = value["keys"] ?? {};
  if (!isObject(keys) || Object.values(keys).some((command) => typeof command !== "string"))
    throw new Error(`${path} has "keys" that are not key bindings. ${fix}`);
  const permissions = value["permissions"] ?? null;
  if (permissions !== null && !isTextList(permissions))
    throw new Error(`${path} has "permissions" that are not a list of permissions. ${fix}`);
  const grantedOnUpdate = value["grantedOnUpdate"] ?? [];
  if (!isTextList(grantedOnUpdate))
    throw new Error(`${path} has a "grantedOnUpdate" that is not a list of permissions. ${fix}`);
  return {
    name: value["name"],
    version: value["version"],
    root: value["root"],
    installedAt: value["installedAt"],
    scriptsSha256: value["scriptsSha256"],
    uninstall,
    program,
    keys,
    permissions,
    grantedOnUpdate
  };
}
function readSteps(pkg) {
  if (pkg === undefined)
    return;
  if (!isObject(pkg))
    throw new Error("package.json is not a JSON object.");
  const steps = pkg["cmod"];
  if (steps === undefined)
    return;
  if (!isObject(steps))
    throw new Error('package.json has a "cmod" key that is not an object. Write "cmod": { "install": "./setup/install.sh", "uninstall": "./setup/uninstall.sh" }.');
  const program = steps["program"];
  if (program !== undefined && (typeof program !== "string" || !pluginName.test(program)))
    throw new Error(`package.json "cmod.program" must be the program's command, such as "hello".`);
  const approve = steps["approve"];
  if (approve !== undefined && approve !== true)
    throw new Error(`package.json "cmod.approve" is ${JSON.stringify(approve)}. Write "approve": true, or leave it out.`);
  const permissions = readPermissions(steps);
  return {
    ...readCommand(steps, "install"),
    ...readCommand(steps, "uninstall"),
    ...program === undefined ? {} : { program },
    ...readHotkeys(steps["hotkeys"]),
    ...approve === true || permissions.includes("approve") ? { approve: true } : {},
    ...permissions.length === 0 ? {} : { permissions }
  };
}
function readPermissions(steps) {
  const declared = steps["permissions"];
  if (declared === undefined)
    return [];
  const at = 'package.json "cmod.permissions"';
  if (!isObject(declared))
    throw new Error(`${at} must be an object, such as { "network": ["api.github.com"], "prompt": true }.`);
  const items = [];
  for (const [name, value] of Object.entries(declared)) {
    if (!permissionNames.includes(name))
      throw new Error(`${at} names "${name}", which is not a permission. Use ${listed(permissionNames.map((each) => `"${each}"`))}.`);
    if (flagPermissions.includes(name)) {
      if (value !== true)
        throw new Error(`${at} sets "${name}" to ${JSON.stringify(value)}. Write "${name}": true, or leave it out.`);
      items.push(name);
      continue;
    }
    if (name === "run" && value === "*") {
      items.push("run:*");
      continue;
    }
    const example = { network: '["api.github.com"]', run: '["gh"], or "*" for any program', files: '["~/.zshrc"]', config: '["cleanupPeriodDays"]' }[name];
    if (!Array.isArray(value) || value.length === 0 || !value.every((each) => typeof each === "string"))
      throw new Error(`${at} sets "${name}" to ${JSON.stringify(value)}. Write a list, such as "${name}": ${example}.`);
    for (const each of value) {
      const isPath = /^(~\/|\/)/.test(each) && !each.split("/").includes("..");
      const isValid = { network: hostName.test(each) || isPath, run: programName.test(each), files: isPath, config: settingPath.test(each) }[name];
      if (isValid !== true)
        throw new Error(`${at} lists "${each}" under "${name}". Write ${listItemHint[name]}.`);
      items.push(`${name}:${each}`);
    }
  }
  return items;
}
var installFix = "Install it in Plugins.";
var secretFix = "Set it in /config, where Claude Code keeps it in your keychain.";
var pendingStepsMethod = "cmod:pendingSteps";
var finishStepsMethod = "cmod:finishSteps";
function marketplaceOf(root, name) {
  const installed = /\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(root);
  return installed?.[2] === name ? installed[1] : undefined;
}
function pluginsChangedPath(store) {
  return `${store}/plugins-changed`;
}
function markedCheckout(mark) {
  return mark.split(`
`)[1] || undefined;
}
function storeChangedPath(store) {
  return `${store}/store-changed`;
}
function buildFailuresPath(store) {
  return `${store}/build-failures.json`;
}
function linksPath(store) {
  return `${store}/links.json`;
}
function parseLinks(value, path) {
  if (value === undefined)
    return { marketplaces: {}, turnedOff: {} };
  const isLinks = isObject(value) && isObject(value["marketplaces"]) && isObject(value["turnedOff"]) && Object.values(value["marketplaces"]).every((folder) => typeof folder === "string") && Object.values(value["turnedOff"]).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"));
  if (!isLinks)
    throw new Error(`${path} is not a map of the marketplaces cmod link added and the plugins it turned off. Delete it, then run cmod link again for each linked checkout.`);
  return value;
}
function linkedMarketplacesOf(knownMarketplaces, links) {
  return Object.entries(links.marketplaces).filter(([name, folder]) => {
    const known = isObject(knownMarketplaces) ? knownMarketplaces[name] : undefined;
    return isObject(known) && isObject(known["source"]) && known["source"]["source"] === "directory" && known["source"]["path"] === folder;
  });
}
function hasLinkedMods(knownMarketplaces, links) {
  return linkedMarketplacesOf(knownMarketplaces, links).length > 0;
}
function widgetsPath(store) {
  return `${store}/widgets.json`;
}
function preferencesPath(store) {
  return `${store}/preferences.json`;
}
function parsePreferences(value, path) {
  if (value === undefined)
    return { showsInstalledModErrors: false };
  if (!isObject(value) || value["showsInstalledModErrors"] !== undefined && typeof value["showsInstalledModErrors"] !== "boolean")
    throw new Error(`${path} is not a map of cmod's preferences to true or false. Delete it, and cmod uses its defaults.`);
  return { showsInstalledModErrors: value["showsInstalledModErrors"] === true };
}
var loggedFailures = 100;
function logFolder(store) {
  return `${dataFolder(store, "cmod")}/log`;
}
function isLogEntry(value) {
  return isObject(value) && ["mod", "id", "message", "details", "at"].every((key) => typeof value[key] === "string");
}
function parseLog(value, path) {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || !value.every(isLogEntry))
    throw new Error(`${path} is not a list of mod failures. Delete it, and cmod starts it again.`);
  return value;
}
function newestLog(entries) {
  const newest = new Map;
  for (const entry of entries) {
    const key = `${entry.mod}
${entry.id}`;
    if ((newest.get(key)?.at ?? "") < entry.at)
      newest.set(key, entry);
  }
  return [...newest.values()].toSorted((left, right) => right.at.localeCompare(left.at)).slice(0, loggedFailures);
}
function versionsLine({ mod, core, cmod, program, claudeCode }) {
  return [mod === undefined ? undefined : `mod ${mod}`, core === undefined ? undefined : `@cmodjs/core ${core}`, `cmod ${cmod}`, program === undefined ? undefined : `cmod program ${program}`, `Claude Code ${claudeCode}`].filter((part) => part !== undefined).join(" · ");
}
function logReport(entry) {
  const seen = (entry.count ?? 1) > 1 ? `
${entry.count} times in session ${entry.session ?? "unknown"}, first at ${entry.firstAt ?? entry.at}` : "";
  return entry.versions === undefined ? entry.details : `${entry.details}

${versionsLine(entry.versions)}${seen}`;
}
function readHotkeys(hotkeys) {
  if (hotkeys === undefined)
    return {};
  const fix = "cmod check writes it from the hotkeys defineMod declares, so run cmod check.";
  if (!isObject(hotkeys) || !Object.values(hotkeys).every((each) => isObject(each) && typeof each["title"] === "string" && (each["default"] === undefined || typeof each["default"] === "string")))
    throw new Error(`package.json "cmod.hotkeys" is not a map of hotkeys to their title and optional default combo. ${fix}`);
  return { hotkeys: checkHotkeys('package.json "cmod"', hotkeys) };
}
var coreVersion = "5.7.0";
var oldestCmodVersion = "5.4.0";
function hotkeyCommand(mod, hotkey) {
  return `${mod}--${hotkey}`;
}
function boundCombos(keybindings) {
  const blocks = isObject(keybindings) && Array.isArray(keybindings["bindings"]) ? keybindings["bindings"] : [];
  const combos = new Map;
  for (const block of blocks) {
    if (!isObject(block) || block["context"] !== "Chat" || !isObject(block["bindings"]))
      continue;
    for (const [combo, action] of Object.entries(block["bindings"]))
      if (typeof action === "string" && action.startsWith("command:"))
        combos.set(action.slice("command:".length), combo);
  }
  return combos;
}
function readCommand(steps, key) {
  const command = steps[key];
  if (command === undefined)
    return {};
  if (typeof command !== "string" || command.trim() === "")
    throw new Error(`package.json "cmod.${key}" must be a command, such as "./setup/${key}.sh".`);
  if (/[\n\t]/.test(command))
    throw new Error(`package.json "cmod.${key}" holds a line break or a tab. Write one command, such as "./setup/${key}.sh".`);
  const atRoot = scriptPaths(command).find((path) => folderOf(path) === ".");
  if (atRoot !== undefined)
    throw new Error(`package.json "cmod.${key}" names ${atRoot}, a script at the plugin root. Move it into a folder, such as ./setup/${key}.sh: cmod runs the steps again whenever anything in a script's folder changes.`);
  return { [key]: command };
}
function scriptPaths(command) {
  const words = command.split(/[\s;&|()<>]+/).map((word) => word.replace(/^['"]|['"]$/g, "")).filter((word) => word.includes("/") && !word.startsWith("-") && !word.startsWith("/") && !word.startsWith("~") && !word.startsWith("$") && !word.includes("=") && !word.split("/").includes(".."));
  return [...new Set(words)];
}
function folderOf(path) {
  return path.slice(0, path.lastIndexOf("/"));
}
async function scriptsSha256(steps, files) {
  const folders = new Set;
  for (const key of ["install", "uninstall"]) {
    const command = steps[key];
    if (command === undefined)
      continue;
    const scriptFolders = [];
    for (const path of scriptPaths(command)) {
      if (await files.read(path) !== undefined)
        scriptFolders.push(folderOf(path));
    }
    if (scriptFolders.length === 0)
      throw new Error(`package.json "cmod.${key}" runs "${command}", which names no script file in the mod, so cmod cannot tell when what it runs changes. Put the commands in a script, such as ./setup/${key}.sh.`);
    for (const folder of scriptFolders)
      folders.add(folder);
  }
  let text = [
    steps.install ?? "",
    steps.uninstall ?? "",
    steps.program ?? "",
    ...steps.hotkeys === undefined ? [] : [JSON.stringify(Object.entries(steps.hotkeys).sort())],
    ...steps.permissions === undefined ? [] : [JSON.stringify([...steps.permissions].sort())]
  ].join("\x00");
  for (const folder of [...folders].sort()) {
    for (const name of (await files.list(folder)).sort()) {
      const path = `${folder}/${name}`;
      const content = await files.read(path);
      if (content === undefined)
        throw new Error(`${path} links to a folder or to nothing, so cmod cannot tell when it changes. Point the link at a file, or delete it.`);
      text += `\x00${path}\x00${content}`;
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function parseEvent(line) {
  const progress = /^progress (\d+) (\d+)(?: (.*))?$/.exec(line);
  if (progress !== null)
    return { type: "progress", done: Number(progress[1]), total: Number(progress[2]), label: progress[3] ?? "" };
  const consent = /^needs-consent (\S+)\t([^\t]*)\t([^\t]*)(?:\t(.*))?$/.exec(line);
  if (consent !== null) {
    const [hotkeys = "", ...permissions] = (consent[4] ?? "").split("\t");
    return { type: "needs-consent", sha256: consent[1], install: consent[2], uninstall: consent[3], hotkeys, permissions: permissions.filter((item) => item !== "") };
  }
  const done = /^done (\S+)(?: (\S+))?$/.exec(line);
  if (done !== null)
    return { type: "done", name: done[1], ...done[2] === undefined ? {} : { version: done[2] } };
  const missing = /^missing (\S+)$/.exec(line);
  if (missing !== null)
    return { type: "missing", name: missing[1] };
  const failed = /^failed (-?\d+)(?:\t(.*))?$/.exec(line);
  if (failed !== null)
    return { type: "failed", code: Number(failed[1]), message: failed[2] ?? "" };
  const retries = /^retries (changed|later)$/.exec(line);
  if (retries !== null)
    return { type: "retries", when: retries[1] };
  return { type: "log", text: line.replace(/^log /, "") };
}
function isAtLeast(version, minimum) {
  const parts = version.split(".").map(Number);
  const least = minimum.split(".").map(Number);
  for (let index = 0;index < Math.max(parts.length, least.length); index += 1) {
    const difference = (parts[index] ?? 0) - (least[index] ?? 0);
    if (difference !== 0)
      return difference > 0;
  }
  return true;
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTextList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// node_modules/@cmodjs/core/options.js
var optionKey = /^[A-Za-z_]\w*$/;
function checkOptions(name, options) {
  for (const [key, declared] of Object.entries(options)) {
    const at = `${name}: options.${key}`;
    if (!optionKey.test(key))
      throw new Error(`${at} is not an option name. Use letters, digits, and _, starting with a letter, as Claude Code passes each option on as CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}.`);
    if (declared.title.trim() === "")
      throw new Error(`${at} needs a title, the label /config shows.`);
    if (declared.type === "choice" && (declared.choices ?? []).length === 0)
      throw new Error(`${at} is a choice with no choices. Give option.choice(['a', 'b'], { ... }).`);
    if (declared.type === "choice" && declared.default !== undefined && !(declared.choices ?? []).includes(declared.default))
      throw new Error(`${at} defaults to ${String(declared.default)}, which is not one of its choices: ${(declared.choices ?? []).join(", ")}.`);
  }
  return options;
}
function projectOptionsOf(name, declared, text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch (error) {
    return { values: {}, ignored: [`is not JSON (${messageOf(error)}). Fix the file; ${name} uses its other options until then.`] };
  }
  if (!isObject(file))
    return { values: {}, ignored: ['is not a JSON object. Write one, such as { "branch": "main" }.'] };
  const values = {};
  const ignored = [];
  for (const [key, value] of Object.entries(file)) {
    const option = declared[key];
    if (option === undefined)
      ignored.push(`sets ${key}, which ${name} does not declare. ${Object.keys(declared).length === 0 ? "Remove it." : `Remove it, or use one of: ${Object.keys(declared).join(", ")}.`}`);
    else if (option.type === "secret")
      ignored.push(`sets ${key}, a secret, and a project file is committed for everyone to read. Remove it. ${secretFix}`);
    else {
      const misfit = fitsOption(option, value);
      if (misfit === undefined)
        values[key] = value;
      else
        ignored.push(`sets ${key} to ${JSON.stringify(value)}, and ${option.title} ${misfit}.`);
    }
  }
  return { values, ignored };
}
function isUnset(value) {
  return value === undefined || value === "" || Array.isArray(value) && value.length === 0;
}
function fitsOption(declared, value) {
  const type = declared.type;
  if (type === "toggle")
    return typeof value === "boolean" ? undefined : "takes true or false";
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return "takes a number";
    if (declared.min !== undefined && value < declared.min)
      return `takes ${declared.min} or more`;
    if (declared.max !== undefined && value > declared.max)
      return `takes ${declared.max} or less`;
    return;
  }
  if (type === "list")
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? undefined : "takes a list of text";
  if (typeof value !== "string")
    return "takes text";
  if (type === "choice" && !(declared.choices ?? []).includes(value))
    return `takes one of: ${(declared.choices ?? []).join(", ")}`;
  return;
}

// node_modules/@cmodjs/core/runtime/bound.js
var current;
function bind(imports) {
  current = imports;
}
function bound() {
  if (current === undefined)
    throw new Error("A mod's imports work once its setup runs. Call them from setup or from a hook, never at the top of a module.");
  return current;
}

// node_modules/@cmodjs/core/session/goal/task.js
var Task = "task";
var TaskStart = "taskStart";
var TaskEnd = "taskEnd";

// node_modules/@cmodjs/core/session/context/turn/message/sender.js
var Person = "person";
var Mod = "mod";
var Schedule = "schedule";
var Channel = "channel";
var Sdk = "sdk";
var Engine = "engine";
var personOrigins = ["human", "composer", "bridge", "slack-ping"];
var sessionOrigins = ["peer", "peer-send-message", "coordinator", "projects-relay", "observer", "observer-activity"];
function senderOf(origin, isInTask) {
  const fields = isObject(origin) ? origin : {};
  const kind = typeof fields["kind"] === "string" ? fields["kind"] : undefined;
  if (kind === undefined)
    return { type: isInTask ? Task : Person };
  if (personOrigins.includes(kind))
    return { type: Person };
  if (sessionOrigins.includes(kind))
    return { type: "session" };
  if (kind === "auto-continuation")
    return { type: Engine };
  if (kind === "plugin" && typeof fields["name"] === "string")
    return { type: Mod, name: fields["name"], ...fields["asUser"] === true ? { as: Person } : {} };
  if (kind === "scheduled-trigger")
    return { type: Schedule };
  if (kind === "channel" && typeof fields["server"] === "string")
    return { type: Channel, name: fields["server"] };
  if (kind === "sdk")
    return { type: Sdk };
  if (kind === "task-notification")
    return { type: Task };
  return { type: isInTask ? Task : Person };
}

// node_modules/@cmodjs/core/session/session.js
var Session = "session";
var UsageChange = "usageChange";
var sessionEvents = {
  Message: "message",
  Prompt: "prompt",
  Note: "note",
  Reply: "reply",
  ToolCall: "toolCall",
  ToolResult: "toolResult",
  Skill: "skill",
  InstructionFile: "instructionFile",
  AttachedFile: "attachedFile",
  Notice: "notice",
  ContextStart: "contextStart",
  ContextEnd: "contextEnd",
  TurnStart: "turnStart",
  TurnEnd: "turnEnd",
  TaskStart: "taskStart",
  TaskEnd: "taskEnd",
  GoalChange: "goalChange",
  UsageChange: "usageChange"
};
var beforeEvents = ["Prompt", "Note", "Skill", "InstructionFile", "AttachedFile", "Reply", "ToolCall", "ToolResult", "Notice", "TaskStart", "TurnEnd", "ContextEnd"];
var processEvents = {
  ProjectSetup: { on: "Setup", before: "Setup" },
  SessionStart: { on: "SessionStart", before: "SessionStart" },
  SessionEnd: { on: "SessionEnd" },
  ModelChange: { on: "PostModelSwitch", before: "PreModelSwitch" },
  CwdChange: { on: "CwdChanged" },
  DirectoryAdd: { on: "DirectoryAdded" },
  WorktreeCreate: { on: "WorktreeCreate", before: "WorktreeCreate" },
  WorktreeRemove: { on: "WorktreeRemove" },
  Notification: { on: "Notification" },
  Elicitation: { on: "Elicitation", before: "Elicitation" },
  ElicitationResponse: { on: "ElicitationResult", before: "ElicitationResult" },
  PermissionCheck: { on: "tool.check", before: "tool.check" },
  PermissionRequest: { on: "PermissionRequest", before: "PermissionRequest" },
  PermissionDenial: { on: "PermissionDenied", before: "PermissionDenied" },
  ToolBatch: { on: "PostToolBatch", before: "PostToolBatch" },
  TodoCreate: { on: "TaskCreated", before: "TaskCreated" },
  TodoComplete: { on: "TaskCompleted", before: "TaskCompleted" },
  ReplyDisplay: { on: "MessageDisplay", before: "MessageDisplay" }
};

// node_modules/@cmodjs/core/ui/areas.js
var AbovePrompt = "abovePrompt";
var BelowPrompt = "belowPrompt";
var Working = "working";
var TurnEnd = "turnEnd";
var Dashboard = "dashboard";
var areas = [AbovePrompt, BelowPrompt, Working, TurnEnd, Dashboard];

// node_modules/@cmodjs/core/ui/styles.js
var ToolGroup = "toolGroup";
var ToolProgress = "toolProgress";
var CommandOutput = "commandOutput";
var AskUserQuestion = "askUserQuestion";
var components = {
  prompt: "UserMessage",
  reply: "AssistantMessage",
  toolCall: "ToolUse",
  toolResult: "ToolResult",
  notice: "InfoNotice",
  [ToolGroup]: "ToolGroup",
  [ToolProgress]: "ToolProgress",
  [CommandOutput]: "CommandOutput",
  [AskUserQuestion]: "AskUserQuestion",
  [Working]: "Spinner",
  [TurnEnd]: "TurnDuration"
};
function componentOf(kind) {
  return typeof kind === "string" && Object.hasOwn(components, kind) ? components[kind] : undefined;
}
function nameOf(kind) {
  return typeof kind === "string" ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : kind.name;
}
// node_modules/@cmodjs/core/session/context/turn/message/prompt.js
var Prompt = "prompt";
// node_modules/@cmodjs/core/session/context/turn/message/note.js
var Note = "note";
var modNoteBlock = new RegExp(`<(${pluginName.source.slice(1, -1)})_mod>\\n([\\s\\S]*?)\\n</\\1_mod>`, "g");
function modNote(mod, text) {
  return `<${mod}_mod>
${text}
</${mod}_mod>`;
}
function modNotesIn(text) {
  return [...text.matchAll(modNoteBlock)].map((match) => ({ mod: match[1], text: match[2] }));
}
function untagged(text) {
  const notes = modNotesIn(text);
  return notes.length === 0 ? text : notes.map((note) => note.text).join(`

`);
}
// node_modules/@cmodjs/core/session/context/turn/message/reply.js
var Reply = "reply";
// node_modules/@cmodjs/core/session/context/turn/message/tool-call.js
var ToolCall = "toolCall";
// node_modules/@cmodjs/core/session/context/turn/message/tool-result.js
var ToolResult = "toolResult";
// node_modules/@cmodjs/core/session/context/turn/message/skill.js
var Skill = "skill";
// node_modules/@cmodjs/core/session/context/turn/message/instruction-file.js
var InstructionFile = "instructionFile";
function isRulePath(path) {
  return /(^|\/)\.claude[^/]*\/rules\//.test(path);
}
// node_modules/@cmodjs/core/session/context/turn/message/attached-file.js
var AttachedFile = "attachedFile";
var attachmentTypes = {
  file: "contents",
  compact_file_reference: "reference",
  edited_text_file: "change"
};
function attachmentTypeOf(name) {
  return name !== undefined && Object.hasOwn(attachmentTypes, name) ? attachmentTypes[name] : undefined;
}
var readPath = /^Called the Read tool with the following input: \{.*?"file_path":\s*("(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")/m;
var noted = /^Note: (.+?) (?:was read before the last conversation was summarized|changed on disk since you last read it)/m;
function attachedPathOf(text) {
  const read = readPath.exec(text)?.[1];
  return read === undefined ? noted.exec(text)?.[1] ?? "" : JSON.parse(read);
}
// node_modules/@cmodjs/core/session/context/turn/message/notice.js
var Notice = "notice";
// node_modules/@cmodjs/core/runtime/deadline.js
var longestMs = 600000;
var toolDeadline = { ms: 30000, job: "tool" };
var listenerMs = 1e4;

class PassedTimeout extends Error {
}
var timers = globalThis;
function listenerOf(name, method, args) {
  const hasMatcher = typeof args[1] === "function";
  const listener = hasMatcher ? args[1] : args[0];
  const options = (hasMatcher ? args[2] : args[1]) ?? {};
  if (typeof listener !== "function")
    throw new Error(`${name}: ${method} takes a listener, or a matcher and then a listener.`);
  const { timeoutMs, onFailure } = options;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > longestMs))
    throw new Error(`${name}: ${method}'s timeoutMs is ${String(timeoutMs)}. Give a whole number of milliseconds above 0 and at most ${longestMs}.`);
  if (onFailure !== undefined && onFailure !== "pass" && onFailure !== "refuse")
    throw new Error(`${name}: ${method}'s onFailure is ${String(onFailure)}. Give 'pass' or 'refuse'.`);
  return { matcher: hasMatcher ? args[0] : undefined, listener, options };
}
async function withinTime(clock, method, { timeoutMs = listenerMs }, cancel, run) {
  const controller = new AbortController;
  const deadline = await clock.now() + timeoutMs;
  cancel.throwIfAborted();
  let timer;
  let cancelled = () => {
    return;
  };
  const passed = new Promise((_resolve, reject) => {
    timer = timers.setTimeout(() => {
      controller.abort();
      reject(new PassedTimeout(`${method} passed its ${timeoutMs / 1000} s timeout`));
    }, timeoutMs);
    cancelled = () => reject(cancel.reason);
    cancel.addEventListener("abort", cancelled, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run({ deadline, signal: AbortSignal.any([controller.signal, cancel]) })), passed]);
  } finally {
    timers.clearTimeout(timer);
    cancel.removeEventListener("abort", cancelled);
  }
}
var abortGraceMs = 1000;
function settledAfterAbort(work, signal) {
  if (signal === undefined)
    return work;
  return new Promise((resolve, reject) => {
    let timer;
    const giveUp = () => void (timer = timers.setTimeout(() => reject(signal.reason), abortGraceMs));
    if (signal.aborted)
      giveUp();
    else
      signal.addEventListener("abort", giveUp, { once: true });
    work.then(resolve, reject).finally(() => {
      timers.clearTimeout(timer);
      signal.removeEventListener("abort", giveUp);
    });
  });
}
function beforeDeadline(claude, { ms, job }, call, task) {
  return new Promise((resolve, reject) => {
    const passed = job === undefined ? `its ${ms / 1000} s deadline` : `the ${ms / 1000} s deadline of ${job}`;
    const timer = claude.clock.after(ms, () => reject(new Error(`${call} passed ${passed}`)));
    task.then((value) => {
      timer.cancel();
      resolve(value);
    }, (error) => {
      timer.cancel();
      reject(error);
    });
  });
}
// node_modules/@cmodjs/core/runtime/dependencies.js
var cmodPluginName = "cmod";
var loadedMethod = "cmod:isLoaded";
async function answerCall(name, api, e) {
  const method = Object.hasOwn(api, e.method) ? api[e.method] : undefined;
  if (method === undefined)
    return { deny: `${name} has no method ${e.method}.` };
  try {
    return { value: await method(e.input) };
  } catch (error) {
    return { deny: `${name}: ${messageOf(error)}` };
  }
}
function dependencyCalls(claude, within) {
  const methodsOf = (to) => new Proxy({}, { get: (_methods, method) => typeof method === "string" && method !== "then" ? (input) => within(`mod.dependencies.${to}.${method}`, claude.cmod.call({ to, method, input })) : undefined });
  return new Proxy({}, { get: (_dependencies, to) => typeof to === "string" && to !== "then" ? methodsOf(to) : undefined });
}
function withBareRefusals(claude) {
  const prefix = `${claude.plugin.name}: $.cmod.call: `;
  const call = (input) => claude.cmod.call(input).catch((error) => {
    const message = messageOf(error);
    throw message.startsWith(prefix) ? new Error(message.slice(prefix.length), { cause: error }) : error;
  });
  return { ...claude, cmod: { call } };
}
function answeringOwnCalls(claude, router) {
  const name = claude.plugin.name;
  const call = async (input) => {
    if (input.to !== name)
      return claude.cmod.call(input);
    const answer = await router.dispatch("cmod.call", { ...input, caller: name }, async () => ({ deny: `${name} has no method ${input.method}.` }));
    if (answer.deny !== undefined)
      throw new Error(answer.deny);
    return answer.value;
  };
  return { ...claude, cmod: { call } };
}
function notInstalled(name) {
  return `${name} is not installed. ${installFix}`;
}
function isNotInstalled(name, error) {
  return messageOf(error).endsWith(notInstalled(name));
}

// node_modules/@cmodjs/core/mod.js
var sessions = {
  get current() {
    return bound().sessions.current;
  },
  list: (options) => bound().sessions.list(options),
  search: (text, matcher, options) => bound().sessions.search(text, matcher, options),
  ...Object.fromEntries(Object.keys(sessionEvents).map((named) => [`on${named}`, (...args) => bound().sessions[`on${named}`](...args)]))
};
var settings = {
  user: { read: () => bound().settings.user.read(), update: (values) => bound().settings.user.update(values) },
  project: { read: () => bound().settings.project.read(), update: (values) => bound().settings.project.update(values) },
  local: { read: () => bound().settings.local.read(), update: (values) => bound().settings.local.update(values) },
  beforeFileChange: (matcherOrListener, listener) => bound().settings.beforeFileChange(matcherOrListener, listener)
};
var commands = {
  list: () => bound().commands.list(),
  run: (name, args) => bound().commands.run(name, args),
  beforeRun: (...args) => bound().commands.beforeRun(...args),
  onRun: (...args) => bound().commands.onRun(...args)
};
var fs = {
  read: (path) => bound().fs.read(path),
  write: (path, text) => bound().fs.write(path, text),
  exists: (path) => bound().fs.exists(path),
  find: (glob) => bound().fs.find(glob),
  list: (path) => bound().fs.list(path),
  stat: (path, options) => bound().fs.stat(path, options),
  onChange: (matcher, listener) => bound().fs.onChange(matcher, listener)
};
var process = {
  run: (argv, init) => bound().process.run(argv, init),
  spawn: (argv, init) => bound().process.spawn(argv, init)
};
var device = {
  read: () => bound().device.read()
};
var clipboard = {
  write: (text) => bound().clipboard.write(text)
};
function defineMod(definition) {
  if (definition.name.trim() === "")
    throw new Error("defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.");
  if (definition.options !== undefined)
    checkOptions(definition.name, definition.options);
  if (definition.hotkeys !== undefined)
    checkHotkeys(definition.name, definition.hotkeys);
  if (definition.installer !== undefined)
    checkSteps(definition.name, definition.installer);
  return definition;
}

// node_modules/@cmodjs/core/vendor.js
var Bt = Object.create;
var { getPrototypeOf: jt, defineProperty: Ve, getOwnPropertyNames: Gt } = Object;
var Ye = Object.prototype.hasOwnProperty;
function Ut(e) {
  return this[e];
}
var qt;
var Ft;
var Kt = (e, r, t) => {
  var n = e != null && typeof e === "object";
  if (n) {
    var o = r ? qt ??= new WeakMap : Ft ??= new WeakMap, u = o.get(e);
    if (u)
      return u;
  }
  t = e != null ? Bt(jt(e)) : {};
  let s = r || !e || !e.__esModule || !Ye.call(e, "default") ? Ve(t, "default", { value: e, enumerable: true }) : t;
  if (e && typeof e === "object" || typeof e === "function") {
    for (let i of Gt(e))
      if (!Ye.call(s, i))
        Ve(s, i, { get: Ut.bind(e, i), enumerable: true });
  }
  if (n)
    o.set(e, s);
  return s;
};
var me = (e, r) => () => (r || e((r = { exports: {} }).exports, r), r.exports);
var Se = me(function(Qn, dt) {
  var lt = { DOT_LITERAL: "\\.", PLUS_LITERAL: "\\+", QMARK_LITERAL: "\\?", SLASH_LITERAL: "\\/", ONE_CHAR: "(?=.)", QMARK: "[^/]", END_ANCHOR: "(?:\\/|$)", DOTS_SLASH: "\\.{1,2}(?:\\/|$)", NO_DOT: "(?!\\.)", NO_DOTS: "(?!(?:^|\\/)\\.{1,2}(?:\\/|$))", NO_DOT_SLASH: "(?!\\.{0,1}(?:\\/|$))", NO_DOTS_SLASH: "(?!\\.{1,2}(?:\\/|$))", QMARK_NO_DOT: "[^.\\/]", STAR: "[^/]*?", START_ANCHOR: "(?:^|\\/)", SEP: "/" }, wr = { ...lt, SLASH_LITERAL: "[\\\\/]", QMARK: "[^\\\\/]", STAR: "[^\\\\/]*?", DOTS_SLASH: "\\.{1,2}(?:[\\\\/]|$)", NO_DOT: "(?!\\.)", NO_DOTS: "(?!(?:^|[\\\\/])\\.{1,2}(?:[\\\\/]|$))", NO_DOT_SLASH: "(?!\\.{0,1}(?:[\\\\/]|$))", NO_DOTS_SLASH: "(?!\\.{1,2}(?:[\\\\/]|$))", QMARK_NO_DOT: "[^.\\\\/]", START_ANCHOR: "(?:^|[\\\\/])", END_ANCHOR: "(?:[\\\\/]|$)", SEP: "\\" }, Or = { __proto__: null, alnum: "a-zA-Z0-9", alpha: "a-zA-Z", ascii: "\\x00-\\x7F", blank: " \\t", cntrl: "\\x00-\\x1F\\x7F", digit: "0-9", graph: "\\x21-\\x7E", lower: "a-z", print: "\\x20-\\x7E ", punct: "\\-!\"#$%&'()\\*+,./:;<=>?@[\\]^_`{|}~", space: " \\t\\r\\n\\v\\f", upper: "A-Z", word: "A-Za-z0-9_", xdigit: "A-Fa-f0-9" };
  dt.exports = { DEFAULT_MAX_EXTGLOB_RECURSION: 0, MAX_LENGTH: 65536, POSIX_REGEX_SOURCE: Or, REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g, REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/, REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/, REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g, REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g, REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g, REPLACEMENTS: { __proto__: null, "***": "*", "**/**": "**", "**/**/**": "**" }, CHAR_0: 48, CHAR_9: 57, CHAR_UPPERCASE_A: 65, CHAR_LOWERCASE_A: 97, CHAR_UPPERCASE_Z: 90, CHAR_LOWERCASE_Z: 122, CHAR_LEFT_PARENTHESES: 40, CHAR_RIGHT_PARENTHESES: 41, CHAR_ASTERISK: 42, CHAR_AMPERSAND: 38, CHAR_AT: 64, CHAR_BACKWARD_SLASH: 92, CHAR_CARRIAGE_RETURN: 13, CHAR_CIRCUMFLEX_ACCENT: 94, CHAR_COLON: 58, CHAR_COMMA: 44, CHAR_DOT: 46, CHAR_DOUBLE_QUOTE: 34, CHAR_EQUAL: 61, CHAR_EXCLAMATION_MARK: 33, CHAR_FORM_FEED: 12, CHAR_FORWARD_SLASH: 47, CHAR_GRAVE_ACCENT: 96, CHAR_HASH: 35, CHAR_HYPHEN_MINUS: 45, CHAR_LEFT_ANGLE_BRACKET: 60, CHAR_LEFT_CURLY_BRACE: 123, CHAR_LEFT_SQUARE_BRACKET: 91, CHAR_LINE_FEED: 10, CHAR_NO_BREAK_SPACE: 160, CHAR_PERCENT: 37, CHAR_PLUS: 43, CHAR_QUESTION_MARK: 63, CHAR_RIGHT_ANGLE_BRACKET: 62, CHAR_RIGHT_CURLY_BRACE: 125, CHAR_RIGHT_SQUARE_BRACKET: 93, CHAR_SEMICOLON: 59, CHAR_SINGLE_QUOTE: 39, CHAR_SPACE: 32, CHAR_TAB: 9, CHAR_UNDERSCORE: 95, CHAR_VERTICAL_LINE: 124, CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279, extglobChars(e) {
    return { "!": { type: "negate", open: "(?:(?!(?:", close: `))${e.STAR})` }, "?": { type: "qmark", open: "(?:", close: ")?" }, "+": { type: "plus", open: "(?:", close: ")+" }, "*": { type: "star", open: "(?:", close: ")*" }, "@": { type: "at", open: "(?:", close: ")" } };
  }, globChars(e) {
    return e === true ? wr : lt;
  } };
});
var Te = me(function(kr) {
  var { REGEX_BACKSLASH: vr, REGEX_REMOVE_BACKSLASH: Tr, REGEX_SPECIAL_CHARS: Ir, REGEX_SPECIAL_CHARS_GLOBAL: Cr } = Se();
  kr.isObject = (e) => e !== null && typeof e === "object" && !Array.isArray(e);
  kr.hasRegexChars = (e) => Ir.test(e);
  kr.isRegexChar = (e) => e.length === 1 && kr.hasRegexChars(e);
  kr.escapeRegex = (e) => e.replace(Cr, "\\$1");
  kr.toPosixSlashes = (e) => e.replace(vr, "/");
  kr.isWindows = () => {
    if (typeof navigator < "u" && navigator.platform) {
      let e = navigator.platform.toLowerCase();
      return e === "win32" || e === "windows";
    }
    return false;
  };
  kr.removeBackslashes = (e) => e.replace(Tr, (r) => r === "\\" ? "" : r);
  kr.escapeLast = (e, r, t) => {
    let n = e.lastIndexOf(r, t);
    if (n === -1)
      return e;
    if (e[n - 1] === "\\")
      return kr.escapeLast(e, r, n - 1);
    return `${e.slice(0, n)}\\${e.slice(n)}`;
  };
  kr.removePrefix = (e, r = {}) => {
    let t = e;
    if (t.startsWith("./"))
      t = t.slice(2), r.prefix = "./";
    return t;
  };
  kr.wrapOutput = (e, r = {}, t = {}) => {
    let n = t.contains ? "" : "^", o = t.contains ? "" : "$", u = `${n}(?:${e})${o}`;
    if (r.negated === true)
      u = `(?:^(?!${u}).*$)`;
    return u;
  };
  kr.basename = (e, { windows: r } = {}) => {
    let t = e.split(r ? /[\\/]/ : "/"), n = t[t.length - 1];
    if (n === "")
      return t[t.length - 2];
    return n;
  };
});
var xt = me(function(Vn, _t) {
  var Ce = Te(), { CHAR_ASTERISK: Be, CHAR_AT: Gr, CHAR_BACKWARD_SLASH: xe, CHAR_COMMA: Ur, CHAR_DOT: je, CHAR_EXCLAMATION_MARK: Ge, CHAR_FORWARD_SLASH: gt, CHAR_LEFT_CURLY_BRACE: Ue, CHAR_LEFT_PARENTHESES: Ie, CHAR_LEFT_SQUARE_BRACKET: qr, CHAR_PLUS: Fr, CHAR_QUESTION_MARK: ht, CHAR_RIGHT_CURLY_BRACE: Kr, CHAR_RIGHT_PARENTHESES: $t, CHAR_RIGHT_SQUARE_BRACKET: Wr } = Se(), mt = (e) => e === gt || e === xe, yt = (e) => {
    if (e.isPrefix !== true)
      e.depth = e.isGlobstar ? 1 / 0 : 1;
  }, Xr = (e, r) => {
    let t = r || {}, n = e.length - 1, o = t.parts === true || t.tokens === true || t.scanToEnd === true, u = [], s = [], i = [], h = e, N = -1, _ = 0, w = 0, M = false, K = false, g = false, k = false, ee = false, q = false, L = false, H = false, ne = false, X = false, T = 0, V, A, I = { value: "", depth: 0, isGlob: false }, a = () => N >= n, Q = () => h.charCodeAt(N + 1), C = () => (V = A, h.charCodeAt(++N));
    while (N < n) {
      A = C();
      let P;
      if (A === xe) {
        if (L = I.backslashes = true, A = C(), A === Ue)
          q = true;
        continue;
      }
      if (q === true || A === Ue) {
        T++;
        while (a() !== true && (A = C())) {
          if (A === xe) {
            L = I.backslashes = true, C();
            continue;
          }
          if (A === Ue) {
            T++;
            continue;
          }
          if (q !== true && A === je && (A = C()) === je) {
            if (M = I.isBrace = true, g = I.isGlob = true, X = true, o === true)
              continue;
            break;
          }
          if (q !== true && A === Ur) {
            if (M = I.isBrace = true, g = I.isGlob = true, X = true, o === true)
              continue;
            break;
          }
          if (A === Kr) {
            if (T--, T === 0) {
              q = false, M = I.isBrace = true, X = true;
              break;
            }
          }
        }
        if (o === true)
          continue;
        break;
      }
      if (A === gt) {
        if (u.push(N), s.push(I), I = { value: "", depth: 0, isGlob: false }, X === true)
          continue;
        if (V === je && N === _ + 1) {
          _ += 2;
          continue;
        }
        w = N + 1;
        continue;
      }
      if (t.noext !== true) {
        if ((A === Fr || A === Gr || A === Be || A === ht || A === Ge) === true && Q() === Ie) {
          if (g = I.isGlob = true, k = I.isExtglob = true, X = true, A === Ge && N === _)
            ne = true;
          if (o === true) {
            let te = 0;
            while (a() !== true && (A = C())) {
              if (A === xe) {
                L = I.backslashes = true, C();
                continue;
              }
              if (A === Ie) {
                te++;
                continue;
              }
              if (A === $t && --te === 0) {
                X = true;
                break;
              }
            }
            continue;
          }
          break;
        }
      }
      if (A === Be) {
        if (V === Be)
          ee = I.isGlobstar = true;
        if (g = I.isGlob = true, X = true, o === true)
          continue;
        break;
      }
      if (A === ht) {
        if (g = I.isGlob = true, X = true, o === true)
          continue;
        break;
      }
      if (A === qr) {
        while (a() !== true && (P = C())) {
          if (P === xe) {
            L = I.backslashes = true, C();
            continue;
          }
          if (P === Wr) {
            K = I.isBracket = true, g = I.isGlob = true, X = true;
            break;
          }
        }
        if (o === true)
          continue;
        break;
      }
      if (t.nonegate !== true && A === Ge && N === _) {
        H = I.negated = true, _++;
        continue;
      }
      if (t.noparen !== true && A === Ie) {
        if (g = I.isGlob = true, o === true) {
          let J = 1;
          while (a() !== true && (A = C())) {
            if (A === xe) {
              L = I.backslashes = true, C();
              continue;
            }
            if (A === Ie) {
              J++;
              continue;
            }
            if (A === $t && --J === 0) {
              X = true;
              break;
            }
          }
          continue;
        }
        break;
      }
      if (g === true) {
        if (X = true, o === true)
          continue;
        break;
      }
    }
    if (t.noext === true)
      k = false, g = false;
    let B = h, l = "", f = "";
    if (_ > 0)
      l = h.slice(0, _), h = h.slice(_), w -= _;
    if (B && g === true && w > 0)
      B = h.slice(0, w), f = h.slice(w);
    else if (g === true)
      B = "", f = h;
    else
      B = h;
    if (B && B !== "" && B !== "/" && B !== h) {
      if (mt(B.charCodeAt(B.length - 1)))
        B = B.slice(0, -1);
    }
    if (t.unescape === true) {
      if (f)
        f = Ce.removeBackslashes(f);
      if (B && L === true)
        B = Ce.removeBackslashes(B);
    }
    let Y = { prefix: l, input: e, start: _, base: B, glob: f, isBrace: M, isBracket: K, isGlob: g, isExtglob: k, isGlobstar: ee, negated: H, negatedExtglob: ne };
    if (t.tokens === true) {
      if (Y.maxDepth = 0, !mt(A))
        s.push(I);
      Y.tokens = s;
    }
    if (t.parts === true || t.tokens === true) {
      let P;
      for (let W = 0;W < u.length; W++) {
        let ue = P !== undefined ? P + 1 : _, $e = u[W], fe = e.slice(ue, $e);
        if (t.tokens) {
          if (W === 0 && _ !== 0)
            s[W].isPrefix = true, s[W].value = l;
          else
            s[W].value = fe;
          yt(s[W]), Y.maxDepth += s[W].depth;
        }
        if ($e >= _)
          i.push(fe), P = $e;
      }
      let J = P !== undefined ? P + 1 : _, te = e.slice(J);
      if (i.push(te), t.tokens && P && P + 1 < e.length)
        s[s.length - 1].value = te, yt(s[s.length - 1]), Y.maxDepth += s[s.length - 1].depth;
      Y.slashes = u, Y.parts = i;
    }
    return Y;
  };
  _t.exports = Xr;
});
var St = me(function(Yn, Et) {
  var he = Se(), G = Te(), { MAX_LENGTH: ke, POSIX_REGEX_SOURCE: Qr, REGEX_NON_SPECIAL_CHARS: Zr, REGEX_SPECIAL_CHARS_BACKREF: Vr, REPLACEMENTS: At } = he, Yr = (e, r) => {
    if (typeof r.expandRange === "function")
      return r.expandRange(...e, r);
    e.sort();
    let t = `[${e.join("-")}]`;
    try {
      new RegExp(t);
    } catch (n) {
      return e.map((o) => G.escapeRegex(o)).join("..");
    }
    return t;
  }, Ae = (e, r) => `Missing ${e}: "${r}" - use "\\\\${r}" to match literal characters`, Rt = (e) => {
    let r = [], t = 0, n = 0, o = 0, u = "", s = false;
    for (let i of e) {
      if (s === true) {
        u += i, s = false;
        continue;
      }
      if (i === "\\") {
        u += i, s = true;
        continue;
      }
      if (i === '"') {
        o = o === 1 ? 0 : 1, u += i;
        continue;
      }
      if (o === 0) {
        if (i === "[")
          t++;
        else if (i === "]" && t > 0)
          t--;
        else if (t === 0) {
          if (i === "(")
            n++;
          else if (i === ")" && n > 0)
            n--;
          else if (i === "|" && n === 0) {
            r.push(u), u = "";
            continue;
          }
        }
      }
      u += i;
    }
    return r.push(u), r;
  }, Jr = (e) => {
    let r = false;
    for (let t of e) {
      if (r === true) {
        r = false;
        continue;
      }
      if (t === "\\") {
        r = true;
        continue;
      }
      if (/[?*+@!()[\]{}]/.test(t))
        return false;
    }
    return true;
  }, Fe = (e) => {
    let r = e.trim(), t = true;
    while (t === true)
      if (t = false, /^@\([^\\()[\]{}|]+\)$/.test(r))
        r = r.slice(2, -1), t = true;
    if (!Jr(r))
      return;
    return r.replace(/\\(.)/g, "$1");
  }, en = (e) => {
    let r = e.map(Fe).filter(Boolean);
    for (let t = 0;t < r.length; t++)
      for (let n = t + 1;n < r.length; n++) {
        let o = r[t], u = r[n], s = o[0];
        if (!s || o !== s.repeat(o.length) || u !== s.repeat(u.length))
          continue;
        if (o === u || o.startsWith(u) || u.startsWith(o))
          return true;
      }
    return false;
  }, qe = (e, r = true) => {
    if (e[0] !== "+" && e[0] !== "*" || e[1] !== "(")
      return;
    let t = 0, n = 0, o = 0, u = false;
    for (let s = 1;s < e.length; s++) {
      let i = e[s];
      if (u === true) {
        u = false;
        continue;
      }
      if (i === "\\") {
        u = true;
        continue;
      }
      if (i === '"') {
        o = o === 1 ? 0 : 1;
        continue;
      }
      if (o === 1)
        continue;
      if (i === "[") {
        t++;
        continue;
      }
      if (i === "]" && t > 0) {
        t--;
        continue;
      }
      if (t > 0)
        continue;
      if (i === "(") {
        n++;
        continue;
      }
      if (i === ")") {
        if (n--, n === 0) {
          if (r === true && s !== e.length - 1)
            return;
          return { type: e[0], body: e.slice(2, s), end: s };
        }
      }
    }
  }, tn = (e) => `${e.length === 1 ? G.escapeRegex(e[0]) : `[${e.map((t) => G.escapeRegex(t)).join("")}]`}*`, rn = (e) => {
    let r = 0, t = [];
    while (r < e.length) {
      let n = qe(e.slice(r), false);
      if (!n || n.type !== "*")
        return;
      let o = Rt(n.body).map((s) => s.trim());
      if (o.length !== 1)
        return;
      let u = Fe(o[0]);
      if (!u || u.length !== 1)
        return;
      t.push(u), r += n.end + 1;
    }
    if (t.length < 1)
      return;
    return t;
  }, nn = (e) => {
    let r = 0, t = e.trim(), n = qe(t);
    while (n)
      r++, t = n.body.trim(), n = qe(t);
    return r;
  }, sn = (e, r) => {
    if (r.maxExtglobRecursion === false)
      return { risky: false };
    let t = typeof r.maxExtglobRecursion === "number" ? r.maxExtglobRecursion : he.DEFAULT_MAX_EXTGLOB_RECURSION, n = Rt(e).map((i) => i.trim());
    if (n.length > 1) {
      if (n.some((i) => i === "") || n.some((i) => /^[*?]+$/.test(i)) || en(n))
        return { risky: true };
    }
    let o = [], u = false, s = true;
    for (let i of n) {
      let h = rn(i);
      if (h) {
        u = true, o.push(...h);
        continue;
      }
      let N = Fe(i);
      if (N && N.length === 1) {
        o.push(N);
        continue;
      }
      if (s = false, nn(i) > t)
        return { risky: true };
    }
    if (u)
      return s ? { risky: true, safeOutput: tn([...new Set(o)]) } : { risky: true };
    return { risky: false };
  }, Ke = (e, r) => {
    if (typeof e !== "string")
      throw TypeError("Expected a string");
    e = At[e] || e;
    let t = { ...r }, n = typeof t.maxLength === "number" ? Math.min(ke, t.maxLength) : ke, o = e.length;
    if (o > n)
      throw SyntaxError(`Input length: ${o}, exceeds maximum allowed length: ${n}`);
    let u = { type: "bos", value: "", output: t.prepend || "" }, s = [u], i = t.capture ? "" : "?:", h = he.globChars(t.windows), N = he.extglobChars(h), { DOT_LITERAL: _, PLUS_LITERAL: w, SLASH_LITERAL: M, ONE_CHAR: K, DOTS_SLASH: g, NO_DOT: k, NO_DOT_SLASH: ee, NO_DOTS_SLASH: q, QMARK: L, QMARK_NO_DOT: H, STAR: ne, START_ANCHOR: X } = h, T = (p) => `(${i}(?:(?!${X}${p.dot ? g : _}).)*?)`, V = t.dot ? "" : k, A = t.dot ? L : H, I = t.bash === true ? T(t) : ne;
    if (t.capture)
      I = `(${I})`;
    if (typeof t.noext === "boolean")
      t.noextglob = t.noext;
    let a = { input: e, index: -1, start: 0, dot: t.dot === true, consumed: "", output: "", prefix: "", backtrack: false, negated: false, brackets: 0, braces: 0, parens: 0, quotes: 0, globstar: false, tokens: s };
    e = G.removePrefix(e, a), o = e.length;
    let Q = [], C = [], B = [], l = u, f, Y = () => a.index === o - 1, P = a.peek = (p = 1) => e[a.index + p], J = a.advance = () => e[++a.index] || "", te = () => e.slice(a.index + 1), W = (p = "", j = 0) => {
      a.consumed += p, a.index += j;
    }, ue = (p) => {
      a.output += p.output != null ? p.output : p.value, W(p.value);
    }, $e = () => {
      let p = 1;
      while (P() === "!" && (P(2) !== "(" || P(3) === "?"))
        J(), a.start++, p++;
      if (p % 2 === 0)
        return false;
      return a.negated = true, a.start++, true;
    }, fe = (p) => {
      a[p]++, B.push(p);
    }, ae = (p) => {
      a[p]--, B.pop();
    }, R = (p) => {
      if (l.type === "globstar") {
        let j = a.braces > 0 && (p.type === "comma" || p.type === "brace"), d = p.extglob === true || Q.length && (p.type === "pipe" || p.type === "paren");
        if (p.type !== "slash" && p.type !== "paren" && !j && !d)
          a.output = a.output.slice(0, -l.output.length), l.type = "star", l.value = "*", l.output = I, a.output += l.output;
      }
      if (Q.length && p.type !== "paren")
        Q[Q.length - 1].inner += p.value;
      if (p.value || p.output)
        ue(p);
      if (l && l.type === "text" && p.type === "text") {
        l.output = (l.output || l.value) + p.value, l.value += p.value;
        return;
      }
      p.prev = l, s.push(p), l = p;
    }, de = (p, j) => {
      let d = { ...N[j], conditions: 1, inner: "" };
      d.prev = l, d.parens = a.parens, d.output = a.output, d.startIndex = a.index, d.tokensIndex = s.length;
      let O = (t.capture ? "(" : "") + d.open;
      fe("parens"), R({ type: p, value: j, output: a.output ? "" : K }), R({ type: "paren", extglob: true, value: J(), output: O }), Q.push(d);
    }, Re = (p) => {
      let j = e.slice(p.startIndex, a.index + 1), d = e.slice(p.startIndex + 2, a.index), O = sn(d, t);
      if ((p.type === "plus" || p.type === "star") && O.risky) {
        let z = O.safeOutput ? (p.output ? "" : K) + (t.capture ? `(${O.safeOutput})` : O.safeOutput) : undefined, re = s[p.tokensIndex];
        re.type = "text", re.value = j, re.output = z || G.escapeRegex(j);
        for (let ie = p.tokensIndex + 1;ie < s.length; ie++)
          s[ie].value = "", s[ie].output = "", delete s[ie].suffix;
        a.output = p.output + re.output, a.backtrack = true, R({ type: "paren", extglob: true, value: f, output: "" }), ae("parens");
        return;
      }
      let D = p.close + (t.capture ? ")" : ""), U;
      if (p.type === "negate") {
        let z = I;
        if (p.inner && p.inner.length > 1 && p.inner.includes("/"))
          z = T(t);
        if (z !== I || Y() || /^\)+$/.test(te()))
          D = p.close = `)$))${z}`;
        if (p.inner.includes("*") && (U = te()) && /^\.[^\\/.]+$/.test(U)) {
          let re = Ke(U, { ...r, fastpaths: false }).output;
          D = p.close = `)${re})${z})`;
        }
        if (p.prev.type === "bos")
          a.negatedExtglob = true;
      }
      R({ type: "paren", extglob: true, value: f, output: D }), ae("parens");
    };
    if (t.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(e)) {
      let p = false, j = e.replace(Vr, (d, O, D, U, z, re) => {
        if (U === "\\")
          return p = true, d;
        if (U === "?") {
          if (O)
            return O + U + (z ? L.repeat(z.length) : "");
          if (re === 0)
            return A + (z ? L.repeat(z.length) : "");
          return L.repeat(D.length);
        }
        if (U === ".")
          return _.repeat(D.length);
        if (U === "*") {
          if (O)
            return O + U + (z ? I : "");
          return I;
        }
        return O ? d : `\\${d}`;
      });
      if (p === true)
        if (t.unescape === true)
          j = j.replace(/\\/g, "");
        else
          j = j.replace(/\\+/g, (d) => d.length % 2 === 0 ? "\\\\" : d ? "\\" : "");
      if (j === e && t.contains === true)
        return a.output = e, a;
      return a.output = G.wrapOutput(j, a, r), a;
    }
    while (!Y()) {
      if (f = J(), f === "\x00")
        continue;
      if (f === "\\") {
        let d = P();
        if (d === "/" && t.bash !== true)
          continue;
        if (d === "." || d === ";")
          continue;
        if (!d) {
          f += "\\", R({ type: "text", value: f });
          continue;
        }
        let O = /^\\+/.exec(te()), D = 0;
        if (O && O[0].length > 2) {
          if (D = O[0].length, a.index += D, D % 2 !== 0)
            f += "\\";
        }
        if (t.unescape === true)
          f = J();
        else
          f += J();
        if (a.brackets === 0) {
          R({ type: "text", value: f });
          continue;
        }
      }
      if (a.brackets > 0 && (f !== "]" || l.value === "[" || l.value === "[^")) {
        if (t.posix !== false && f === ":") {
          let d = l.value.slice(1);
          if (d.includes("[")) {
            if (l.posix = true, d.includes(":")) {
              let O = l.value.lastIndexOf("["), D = l.value.slice(0, O), U = l.value.slice(O + 2), z = Qr[U];
              if (z) {
                if (l.value = D + z, a.backtrack = true, J(), !u.output && s.indexOf(l) === 1)
                  u.output = K;
                continue;
              }
            }
          }
        }
        if (f === "[" && P() !== ":" || f === "-" && P() === "]")
          f = `\\${f}`;
        if (f === "]" && (l.value === "[" || l.value === "[^"))
          f = `\\${f}`;
        if (t.posix === true && f === "!" && l.value === "[")
          f = "^";
        l.value += f, ue({ value: f });
        continue;
      }
      if (a.quotes === 1 && f !== '"') {
        f = G.escapeRegex(f), l.value += f, ue({ value: f });
        continue;
      }
      if (f === '"') {
        if (a.quotes = a.quotes === 1 ? 0 : 1, t.keepQuotes === true)
          R({ type: "text", value: f });
        continue;
      }
      if (f === "(") {
        fe("parens"), R({ type: "paren", value: f });
        continue;
      }
      if (f === ")") {
        if (a.parens === 0 && t.strictBrackets === true)
          throw SyntaxError(Ae("opening", "("));
        let d = Q[Q.length - 1];
        if (d && a.parens === d.parens + 1) {
          Re(Q.pop());
          continue;
        }
        R({ type: "paren", value: f, output: a.parens ? ")" : "\\)" }), ae("parens");
        continue;
      }
      if (f === "[") {
        if (t.nobracket === true || !te().includes("]")) {
          if (t.nobracket !== true && t.strictBrackets === true)
            throw SyntaxError(Ae("closing", "]"));
          f = `\\${f}`;
        } else
          fe("brackets");
        R({ type: "bracket", value: f });
        continue;
      }
      if (f === "]") {
        if (t.nobracket === true || l && l.type === "bracket" && l.value.length === 1) {
          R({ type: "text", value: f, output: `\\${f}` });
          continue;
        }
        if (a.brackets === 0) {
          if (t.strictBrackets === true)
            throw SyntaxError(Ae("opening", "["));
          R({ type: "text", value: f, output: `\\${f}` });
          continue;
        }
        ae("brackets");
        let d = l.value.slice(1);
        if (l.posix !== true && d[0] === "^" && !d.includes("/"))
          f = `/${f}`;
        if (l.value += f, ue({ value: f }), t.literalBrackets === false || G.hasRegexChars(d))
          continue;
        let O = G.escapeRegex(l.value);
        if (a.output = a.output.slice(0, -l.value.length), t.literalBrackets === true) {
          a.output += O, l.value = O;
          continue;
        }
        l.value = `(${i}${O}|${l.value})`, a.output += l.value;
        continue;
      }
      if (f === "{" && t.nobrace !== true) {
        fe("braces");
        let d = { type: "brace", value: f, output: "(", outputIndex: a.output.length, tokensIndex: a.tokens.length };
        C.push(d), R(d);
        continue;
      }
      if (f === "}") {
        let d = C[C.length - 1];
        if (t.nobrace === true || !d) {
          R({ type: "text", value: f, output: f });
          continue;
        }
        let O = ")";
        if (d.dots === true) {
          let D = s.slice(), U = [];
          for (let z = D.length - 1;z >= 0; z--) {
            if (s.pop(), D[z].type === "brace")
              break;
            if (D[z].type !== "dots")
              U.unshift(D[z].value);
          }
          O = Yr(U, t), a.backtrack = true;
        }
        if (d.comma !== true && d.dots !== true) {
          let D = a.output.slice(0, d.outputIndex), U = a.tokens.slice(d.tokensIndex);
          d.value = d.output = "\\{", f = O = "\\}", a.output = D;
          for (let z of U)
            a.output += z.output || z.value;
        }
        R({ type: "brace", value: f, output: O }), ae("braces"), C.pop();
        continue;
      }
      if (f === "|") {
        if (Q.length > 0)
          Q[Q.length - 1].conditions++;
        R({ type: "text", value: f });
        continue;
      }
      if (f === ",") {
        let d = f, O = C[C.length - 1];
        if (O && B[B.length - 1] === "braces")
          O.comma = true, d = "|";
        R({ type: "comma", value: f, output: d });
        continue;
      }
      if (f === "/") {
        if (l.type === "dot" && a.index === a.start + 1) {
          a.start = a.index + 1, a.consumed = "", a.output = "", s.pop(), l = u;
          continue;
        }
        R({ type: "slash", value: f, output: M });
        continue;
      }
      if (f === ".") {
        if (a.braces > 0 && l.type === "dot") {
          if (l.value === ".")
            l.output = _;
          let d = C[C.length - 1];
          l.type = "dots", l.output += f, l.value += f, d.dots = true;
          continue;
        }
        if (a.braces + a.parens === 0 && l.type !== "bos" && l.type !== "slash") {
          R({ type: "text", value: f, output: _ });
          continue;
        }
        R({ type: "dot", value: f, output: _ });
        continue;
      }
      if (f === "?") {
        if (!(l && l.value === "(") && t.noextglob !== true && P() === "(" && P(2) !== "?") {
          de("qmark", f);
          continue;
        }
        if (l && l.type === "paren") {
          let O = P(), D = f;
          if (l.value === "(" && !/[!=<:]/.test(O) || O === "<" && !/<([!=]|\w+>)/.test(te()))
            D = `\\${f}`;
          R({ type: "text", value: f, output: D });
          continue;
        }
        if (t.dot !== true && (l.type === "slash" || l.type === "bos")) {
          R({ type: "qmark", value: f, output: H });
          continue;
        }
        R({ type: "qmark", value: f, output: L });
        continue;
      }
      if (f === "!") {
        if (t.noextglob !== true && P() === "(") {
          if (P(2) !== "?" || !/[!=<:]/.test(P(3))) {
            de("negate", f);
            continue;
          }
        }
        if (t.nonegate !== true && a.index === 0) {
          $e();
          continue;
        }
      }
      if (f === "+") {
        if (t.noextglob !== true && P() === "(" && P(2) !== "?") {
          de("plus", f);
          continue;
        }
        if (l && l.value === "(" || t.regex === false) {
          R({ type: "plus", value: f, output: w });
          continue;
        }
        if (l && (l.type === "bracket" || l.type === "paren" || l.type === "brace") || a.parens > 0) {
          R({ type: "plus", value: f });
          continue;
        }
        R({ type: "plus", value: w });
        continue;
      }
      if (f === "@") {
        if (t.noextglob !== true && P() === "(" && P(2) !== "?") {
          R({ type: "at", extglob: true, value: f, output: "" });
          continue;
        }
        R({ type: "text", value: f });
        continue;
      }
      if (f !== "*") {
        if (f === "$" || f === "^")
          f = `\\${f}`;
        let d = Zr.exec(te());
        if (d)
          f += d[0], a.index += d[0].length;
        R({ type: "text", value: f });
        continue;
      }
      if (l && (l.type === "globstar" || l.star === true)) {
        l.type = "star", l.star = true, l.value += f, l.output = I, a.backtrack = true, a.globstar = true, W(f);
        continue;
      }
      let p = te();
      if (t.noextglob !== true && /^\([^?]/.test(p)) {
        de("star", f);
        continue;
      }
      if (l.type === "star") {
        if (t.noglobstar === true) {
          W(f);
          continue;
        }
        let d = l.prev, O = d.prev, D = d.type === "slash" || d.type === "bos", U = O && (O.type === "star" || O.type === "globstar");
        if (t.bash === true && (!D || p[0] && p[0] !== "/")) {
          R({ type: "star", value: f, output: "" });
          continue;
        }
        let z = a.braces > 0 && (d.type === "comma" || d.type === "brace"), re = Q.length && (d.type === "pipe" || d.type === "paren");
        if (!D && d.type !== "paren" && !z && !re) {
          R({ type: "star", value: f, output: "" });
          continue;
        }
        while (p.slice(0, 3) === "/**") {
          let pe = e[a.index + 4];
          if (pe && pe !== "/")
            break;
          p = p.slice(3), W("/**", 3);
        }
        let ie = Y() || a.parens > 0 && p === ")".repeat(a.parens) && !Q.some((pe) => pe.type === "negate");
        if (d.type === "bos" && Y()) {
          l.type = "globstar", l.value += f, l.output = T(t), a.output = l.output, a.globstar = true, W(f);
          continue;
        }
        if (d.type === "slash" && d.prev.type !== "bos" && !U && ie) {
          a.output = a.output.slice(0, -(d.output + l.output).length), d.output = `(?:${d.output}`, l.type = "globstar", l.output = T(t) + (t.strictSlashes ? ")" : "|$)"), l.value += f, a.globstar = true, a.output += d.output + l.output, W(f);
          continue;
        }
        if (d.type === "slash" && d.prev.type !== "bos" && p[0] === "/") {
          let pe = p[1] !== undefined ? "|$" : "";
          a.output = a.output.slice(0, -(d.output + l.output).length), d.output = `(?:${d.output}`, l.type = "globstar", l.output = `${T(t)}${M}|${M}${pe})`, l.value += f, a.output += d.output + l.output, a.globstar = true, W(f + J()), R({ type: "slash", value: "/", output: "" });
          continue;
        }
        if (d.type === "bos" && p[0] === "/") {
          l.type = "globstar", l.value += f, l.output = `(?:^|${M}|${T(t)}${M})`, a.output = l.output, a.globstar = true, W(f + J()), R({ type: "slash", value: "/", output: "" });
          continue;
        }
        a.output = a.output.slice(0, -l.output.length), l.type = "globstar", l.output = T(t), l.value += f, a.output += l.output, a.globstar = true, W(f);
        continue;
      }
      let j = { type: "star", value: f, output: I };
      if (t.bash === true) {
        if (j.output = ".*?", l.type === "bos" || l.type === "slash")
          j.output = V + j.output;
        R(j);
        continue;
      }
      if (l && (l.type === "bracket" || l.type === "paren") && t.regex === true) {
        j.output = f, R(j);
        continue;
      }
      if (a.index === a.start || l.type === "slash" || l.type === "dot") {
        if (l.type === "dot")
          a.output += ee, l.output += ee;
        else if (t.dot === true)
          a.output += q, l.output += q;
        else
          a.output += V, l.output += V;
        if (P() !== "*")
          a.output += K, l.output += K;
      }
      R(j);
    }
    while (a.brackets > 0) {
      if (t.strictBrackets === true)
        throw SyntaxError(Ae("closing", "]"));
      a.output = G.escapeLast(a.output, "["), ae("brackets");
    }
    while (a.parens > 0) {
      if (t.strictBrackets === true)
        throw SyntaxError(Ae("closing", ")"));
      a.output = G.escapeLast(a.output, "("), ae("parens");
    }
    while (a.braces > 0) {
      if (t.strictBrackets === true)
        throw SyntaxError(Ae("closing", "}"));
      a.output = G.escapeLast(a.output, "{"), ae("braces");
    }
    if (t.strictSlashes !== true && (l.type === "star" || l.type === "bracket"))
      R({ type: "maybe_slash", value: "", output: `${M}?` });
    if (a.backtrack === true) {
      a.output = "";
      for (let p of a.tokens)
        if (a.output += p.output != null ? p.output : p.value, p.suffix)
          a.output += p.suffix;
    }
    return a;
  };
  Ke.fastpaths = (e, r) => {
    let t = { ...r }, n = typeof t.maxLength === "number" ? Math.min(ke, t.maxLength) : ke, o = e.length;
    if (o > n)
      throw SyntaxError(`Input length: ${o}, exceeds maximum allowed length: ${n}`);
    e = At[e] || e;
    let { DOT_LITERAL: u, SLASH_LITERAL: s, ONE_CHAR: i, DOTS_SLASH: h, NO_DOT: N, NO_DOTS: _, NO_DOTS_SLASH: w, STAR: M, START_ANCHOR: K } = he.globChars(t.windows), g = t.dot ? _ : N, k = t.dot ? w : N, ee = t.capture ? "" : "?:", q = { negated: false, prefix: "" }, L = t.bash === true ? ".*?" : M;
    if (t.capture)
      L = `(${L})`;
    let H = (V) => {
      if (V.noglobstar === true)
        return L;
      return `(${ee}(?:(?!${K}${V.dot ? h : u}).)*?)`;
    }, ne = (V) => {
      switch (V) {
        case "*":
          return `${g}${i}${L}`;
        case ".*":
          return `${u}${i}${L}`;
        case "*.*":
          return `${g}${L}${u}${i}${L}`;
        case "*/*":
          return `${g}${L}${s}${i}${k}${L}`;
        case "**":
          return g + H(t);
        case "**/*":
          return `(?:${g}${H(t)}${s})?${k}${i}${L}`;
        case "**/*.*":
          return `(?:${g}${H(t)}${s})?${k}${L}${u}${i}${L}`;
        case "**/.*":
          return `(?:${g}${H(t)}${s})?${u}${i}${L}`;
        default: {
          let A = /^(.*?)\.(\w+)$/.exec(V);
          if (!A)
            return;
          let I = ne(A[1]);
          if (!I)
            return;
          return I + u + A[2];
        }
      }
    }, X = G.removePrefix(e, q), T = ne(X);
    if (T && t.strictSlashes !== true)
      T += `${s}?`;
    return T;
  };
  Et.exports = Ke;
});
var wt = me(function(Jn, bt) {
  var on = xt(), He = St(), Ne = Te(), un = Se(), an = (e) => e && typeof e === "object" && !Array.isArray(e), Z = (e, r, t = false) => {
    if (Array.isArray(e)) {
      let _ = e.map((M) => Z(M, r, t));
      return (M) => {
        for (let K of _) {
          let g = K(M);
          if (g)
            return g;
        }
        return false;
      };
    }
    let n = an(e) && e.tokens && e.input;
    if (e === "" || typeof e !== "string" && !n)
      throw TypeError("Expected pattern to be a non-empty string");
    let o = r || {}, u = o.windows, s = n ? Z.compileRe(e, r) : Z.makeRe(e, r, false, true), i = s.state;
    delete s.state;
    let h = () => false;
    if (o.ignore) {
      let _ = { ...r, ignore: null, onMatch: null, onResult: null };
      h = Z(o.ignore, _, t);
    }
    let N = (_, w = false) => {
      let { isMatch: M, match: K, output: g } = Z.test(_, s, r, { glob: e, posix: u }), k = { glob: e, state: i, regex: s, posix: u, input: _, output: g, match: K, isMatch: M };
      if (typeof o.onResult === "function")
        o.onResult(k);
      if (M === false)
        return k.isMatch = false, w ? k : false;
      if (h(_)) {
        if (typeof o.onIgnore === "function")
          o.onIgnore(k);
        return k.isMatch = false, w ? k : false;
      }
      if (typeof o.onMatch === "function")
        o.onMatch(k);
      return w ? k : true;
    };
    if (t)
      N.state = i;
    return N;
  };
  Z.test = (e, r, t, { glob: n, posix: o } = {}) => {
    if (typeof e !== "string")
      throw TypeError("Expected input to be a string");
    if (e === "")
      return { isMatch: false, output: "" };
    let u = t || {}, s = u.format || (o ? Ne.toPosixSlashes : null), i = e === n, h = i && s ? s(e) : e;
    if (i === false)
      h = s ? s(e) : e, i = h === n;
    if (i === false || u.capture === true)
      if (u.matchBase === true || u.basename === true)
        i = Z.matchBase(e, r, t, o);
      else
        i = r.exec(h);
    return { isMatch: Boolean(i), match: i, output: h };
  };
  Z.matchBase = (e, r, t, n = t && t.windows) => (r instanceof RegExp ? r : Z.makeRe(r, t)).test(Ne.basename(e, { windows: n }));
  Z.isMatch = (e, r, t) => Z(r, t)(e);
  Z.parse = (e, r) => {
    if (Array.isArray(e))
      return e.map((t) => Z.parse(t, r));
    return He(e, { ...r, fastpaths: false });
  };
  Z.scan = (e, r) => on(e, r);
  Z.compileRe = (e, r, t = false, n = false) => {
    if (t === true)
      return e.output;
    let o = r || {}, u = o.contains ? "" : "^", s = o.contains ? "" : "$", i = `${u}(?:${e.output})${s}`;
    if (e && e.negated === true)
      i = `^(?!${i}).*$`;
    let h = Z.toRegex(i, r);
    if (n === true)
      h.state = e;
    return h;
  };
  Z.makeRe = (e, r = {}, t = false, n = false) => {
    if (!e || typeof e !== "string")
      throw TypeError("Expected a non-empty string");
    let o = { negated: false, fastpaths: true };
    if (r.fastpaths !== false && (e[0] === "." || e[0] === "*"))
      o.output = He.fastpaths(e, r);
    if (!o.output)
      o = He(e, r);
    return Z.compileRe(o, r, t, n);
  };
  Z.toRegex = (e, r) => {
    try {
      let t = r || {};
      return new RegExp(e, t.flags || (t.nocase ? "i" : ""));
    } catch (t) {
      if (r && r.debug === true)
        throw t;
      return /$^/;
    }
  };
  Z.constants = un;
  bt.exports = Z;
});
var vt = me(function(es, Ot) {
  var fn = ["||", "&&", ";;&", ";;", ";&", "|&", "<(", ">(", "<<<", "<<-", "<<", ">>", ">&", ">|", "&>>", "&>", "<&", "<>", "&", ";", "(", ")", "|", "<", ">"], We = /[\n\r\u2028\u2029]/, ln = /[\s#!"$&'():;<=>@\\^`|~]/g;
  Ot.exports = function(r) {
    var t = false;
    return r.map(function(n) {
      if (t && typeof n === "string" && We.test(n))
        throw TypeError("a token after a `comment` must not contain line terminators");
      if (n === "")
        return "''";
      if (n && typeof n === "object") {
        if ("op" in n && n.op === "glob") {
          if (typeof n.pattern !== "string")
            throw TypeError("glob token requires a string `pattern`");
          if (We.test(n.pattern))
            throw TypeError("glob `pattern` must not contain line terminators");
          if (n.pattern === "")
            return "''";
          return n.pattern.replace(ln, "\\$&");
        }
        if ("op" in n && typeof n.op === "string") {
          if (fn.indexOf(n.op) < 0)
            throw TypeError("invalid `op` value: " + JSON.stringify(n.op));
          return n.op.replace(/[\s\S]/g, "\\$&");
        }
        if ("comment" in n && typeof n.comment === "string") {
          if (We.test(n.comment))
            throw TypeError("`comment` must not contain line terminators");
          return t = true, "#" + n.comment;
        }
        throw TypeError("unrecognized object token shape");
      }
      if (/'/.test(n) && /!/.test(n))
        return "'" + n.replace(/'/g, `'"'"'`) + "'";
      if (/["\s\\]/.test(n) && !/'/.test(n))
        return "'" + n + "'";
      if (/["'\s]/.test(n))
        return '"' + n.replace(/(["\\$`])/g, "\\$1") + '"';
      return String(n).replace(/([A-Za-z]:)?([#!"$&'()*,:;<=>?@[\\\]^`{|}~])/g, "$1\\$2");
    }).join(" ");
  };
});
var Pt = me(function(ts, Lt) {
  var Ht = "(?:" + ["\\|\\|", "\\&(?:\\&|>>?)", ";;\\&?", "[;|]\\&", "\\<\\(", "\\<\\<\\<", "\\<\\<-", "\\<\\<(?!\\()", ">>", ">[&|(]", "<[&>]", "[&;()|<>]"].join("|") + ")", Tt = new RegExp("^" + Ht + "$"), It = "|&;()<> \\t", dn = "'([^']*?)'", Nt = "(?:\\\\[\\s\\S]|[^\\\\'])*?", Ct = "\\$'" + Nt + "'", Pe = new RegExp("\\$'" + Nt + "(?:(')|\\\\?$)", "g"), pn = "abeEfnrtv", cn = `\x07\b\x1B\x1B\f
\r	\v`, hn = /^#$/, Xe = "'", kt = '"', be = "$", ge = "", $n = 4294967296;
  for (Le = 0;Le < 4; Le++)
    ge += ($n * Math.random()).toString(16);
  var Le, mn = new RegExp("^" + ge);
  function yn(e, r) {
    var t = r.lastIndex, n = [], o;
    while (o = r.exec(e))
      if (n[n.length] = o, r.lastIndex === o.index)
        r.lastIndex += 1;
    return r.lastIndex = t, n;
  }
  function gn(e, r, t) {
    var n = typeof e === "function" ? e(t) : e[t];
    if (typeof n > "u" && t != "")
      n = "";
    else if (typeof n > "u")
      n = "$";
    if (typeof n === "object")
      return r + ge + JSON.stringify(n) + ge;
    return r + n;
  }
  var _n = /\\([0-7]{1,3}|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|c(?:\\\\|[\s\S])|[abeEfnrtv\\'"?])/g;
  function xn(e, r) {
    var t = r.charAt(0);
    if (t === "c") {
      var n = r.charAt(1);
      return n === "?" ? "\u007f" : String.fromCharCode(n.charCodeAt(0) & 31);
    }
    if (t === "x" || t === "u" || t === "U") {
      var o = parseInt(r.slice(1), 16);
      if (o > 1114111)
        return e;
      return String.fromCharCode.apply(null, o > 65535 ? [55232 + (o >> 10), 56320 + (o & 1023)] : [o]);
    }
    if (t >= "0" && t <= "7")
      return String.fromCharCode(parseInt(r, 8) & 255);
    var u = pn.indexOf(r);
    return u < 0 ? r : cn.charAt(u);
  }
  function An(e) {
    return e.replace(_n, xn).split("\x00")[0];
  }
  function Rn(e, r) {
    return Pe.lastIndex = r, !!Pe.exec(e)[1];
  }
  function En(e, r, t) {
    if (!t)
      t = {};
    var n = t.escape || "\\", o = t.splitUnquoted === true ? ` 	
` : typeof t.splitUnquoted === "string" ? t.splitUnquoted : "", u = "(\\" + n + `['"$\\` + n + It + "]|\\$\\$|\\$(?!" + Ct.slice(2) + `)|[^\\s'"$` + It + "])+", s = '"(?:\\' + n + '[\\s\\S]|[^"\\' + n + '])*"', i = new RegExp(["(" + Ht + ")", "(" + Ct + "|" + u + "|" + s + "|" + dn + ")+"].join("|"), "g"), h = yn(e, i);
    if (h.length === 0)
      return [];
    if (!r)
      r = {};
    var N = false;
    return h.map(function(_) {
      var w = _[0];
      if (!w || N)
        return;
      if (Tt.test(w))
        return { op: w };
      var M = false, K = false, g = "", k = [], ee = false, q = null, L = false, H;
      function ne() {
        H += 1;
        var C, B, l = w.charAt(H);
        if (l === "{") {
          if (H += 1, w.charAt(H) === "}")
            throw Error("Bad substitution: " + w.slice(H - 2, H + 1));
          var f = 1;
          C = H;
          while (f > 0 && C < w.length) {
            if (w.charAt(C) === "{" && w.charAt(C - 1) === "$")
              f += 1;
            else if (w.charAt(C) === "}")
              f -= 1;
            C += 1;
          }
          if (f !== 0)
            throw Error("Bad substitution: " + w.slice(H));
          C -= 1, B = w.slice(H, C), H = C;
        } else if (/[*@#?$!-]/.test(l))
          B = l;
        else {
          var Y = w.slice(H);
          if (C = Y.match(/[^\w\d_]/), !C)
            B = Y, H = w.length;
          else
            B = Y.slice(0, C.index), H += C.index - 1;
        }
        return gn(r, "", B);
      }
      function X() {
        if (q === null)
          return;
        if (q === 0) {
          if (g !== "")
            k[k.length] = g, g = "";
        } else {
          k[k.length] = g, g = "";
          for (var C = 1;C < q; C += 1)
            k[k.length] = "";
        }
        q = null;
      }
      for (H = 0;H < w.length; H++) {
        var T = w.charAt(H);
        if (o && T !== be)
          X();
        if (L = L || !M && (T === "*" || T === "?"), K)
          g += T, K = false;
        else if (M)
          if (T === M)
            M = false;
          else if (M == Xe)
            g += T;
          else if (T === n)
            if (H += 1, T = w.charAt(H), T === kt || T === n || T === be)
              g += T;
            else
              g += n + T;
          else if (T === be)
            g += ne();
          else
            g += T;
        else if (T === kt || T === Xe)
          M = T, ee = true;
        else if (Tt.test(T))
          return { op: w };
        else if (hn.test(T)) {
          N = true;
          var V = { comment: e.slice(_.index + H + 1) };
          if (g.length)
            return [g, V];
          return [V];
        } else if (T === n)
          K = true;
        else if (T === be && w.charAt(H + 1) === Xe && Rn(w, H))
          X(), ee = true, g += An(w.slice(H + 2, Pe.lastIndex - 1)), H = Pe.lastIndex - 1;
        else if (T === be) {
          var A = ne();
          if (!o)
            g += A;
          else
            for (var I = 0;I < A.length; I += 1) {
              var a = A.charAt(I);
              if (o.indexOf(a) < 0)
                X(), g += a;
              else if (q === null)
                q = a === " " || a === "\t" || a === `
` ? 0 : 1;
              else if (a !== " " && a !== "\t" && a !== `
`)
                q += 1;
            }
        } else
          g += T;
      }
      if (L)
        return { op: "glob", pattern: g };
      if (o) {
        if (q !== null && q > 0) {
          k[k.length] = g, g = "";
          for (var Q = 1;Q < q; Q += 1)
            k[k.length] = "";
        }
        if (g !== "" || ee && k.length === 0)
          k[k.length] = g;
        return k;
      }
      return g;
    }).reduce(function(_, w) {
      if (typeof w > "u")
        return _;
      return [].concat(w).forEach(function(M) {
        _[_.length] = M;
      }), _;
    }, []);
  }
  Lt.exports = function(r, t, n) {
    var o = En(r, t, n);
    if (typeof t !== "function")
      return o;
    return o.reduce(function(u, s) {
      if (typeof s === "object")
        return u[u.length] = s, u;
      var i = s.split(RegExp("(" + ge + ".*?" + ge + ")", "g"));
      if (i.length === 1)
        return u[u.length] = i[0], u;
      return i.filter(Boolean).forEach(function(h) {
        u[u.length] = mn.test(h) ? JSON.parse(h.split(ge)[1]) : h;
      }), u;
    }, []);
  };
});
function _e(e, r) {
  let t = typeof e;
  if (t !== typeof r)
    return false;
  if (Array.isArray(e)) {
    if (!Array.isArray(r))
      return false;
    let n = e.length;
    if (n !== r.length)
      return false;
    for (let o = 0;o < n; o++)
      if (!_e(e[o], r[o]))
        return false;
    return true;
  }
  if (t === "object") {
    if (!e || !r)
      return e === r;
    let n = Object.keys(e), o = Object.keys(r);
    if (n.length !== o.length)
      return false;
    for (let s of n)
      if (!_e(e[s], r[s]))
        return false;
    return true;
  }
  return e === r;
}
function oe(e) {
  return encodeURI(Wt(e));
}
function Wt(e) {
  return e.replace(/~/g, "~0").replace(/\//g, "~1");
}
var Xt = { prefixItems: true, items: true, allOf: true, anyOf: true, oneOf: true };
var Qt = { $defs: true, definitions: true, properties: true, patternProperties: true, dependentSchemas: true };
var Zt = { id: true, $id: true, $ref: true, $schema: true, $anchor: true, $vocabulary: true, $comment: true, default: true, enum: true, const: true, required: true, type: true, maximum: true, minimum: true, exclusiveMaximum: true, exclusiveMinimum: true, multipleOf: true, maxLength: true, minLength: true, pattern: true, format: true, maxItems: true, minItems: true, uniqueItems: true, maxProperties: true, minProperties: true };
var Vt = typeof self < "u" && self.location && self.location.origin !== "null" ? new URL(self.location.origin + self.location.pathname + location.search) : new URL("https://github.com/cfworker");
function ce(e, r = Object.create(null), t = Vt, n = "") {
  if (e && typeof e === "object" && !Array.isArray(e)) {
    let u = e.$id || e.id;
    if (u) {
      let s = new URL(u, t.href);
      if (s.hash.length > 1)
        r[s.href] = e;
      else if (s.hash = "", n === "")
        t = s;
      else
        ce(e, r, t);
    }
  } else if (e !== true && e !== false)
    return r;
  let o = t.href + (n ? "#" + n : "");
  if (r[o] !== undefined)
    throw Error(`Duplicate schema URI "${o}".`);
  if (r[o] = e, e === true || e === false)
    return r;
  if (e.__absolute_uri__ === undefined)
    Object.defineProperty(e, "__absolute_uri__", { enumerable: false, value: o });
  if (e.$ref && e.__absolute_ref__ === undefined) {
    let u = new URL(e.$ref, t.href);
    u.hash = u.hash, Object.defineProperty(e, "__absolute_ref__", { enumerable: false, value: u.href });
  }
  if (e.$recursiveRef && e.__absolute_recursive_ref__ === undefined) {
    let u = new URL(e.$recursiveRef, t.href);
    u.hash = u.hash, Object.defineProperty(e, "__absolute_recursive_ref__", { enumerable: false, value: u.href });
  }
  if (e.$anchor) {
    let u = new URL("#" + e.$anchor, t.href);
    r[u.href] = e;
  }
  for (let u in e) {
    if (Zt[u])
      continue;
    let s = `${n}/${oe(u)}`, i = e[u];
    if (Array.isArray(i)) {
      if (Xt[u]) {
        let h = i.length;
        for (let N = 0;N < h; N++)
          ce(i[N], r, t, `${s}/${N}`);
      }
    } else if (Qt[u])
      for (let h in i)
        ce(i[h], r, t, `${s}/${oe(h)}`);
    else
      ce(i, r, t, s);
  }
  return r;
}
var Yt = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
var Jt = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var er = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i;
var tr = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i;
var rr = /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
var nr = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
var sr = /^(?:(?:https?|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?!10(?:\.\d{1,3}){3})(?!127(?:\.\d{1,3}){3})(?!169\.254(?:\.\d{1,3}){2})(?!192\.168(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)(?:\.(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
var or = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
var ur = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
var ir = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
var ar = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
var fr = (e) => {
  if (e[0] === '"')
    return false;
  let [r, t, ...n] = e.split("@");
  if (!r || !t || n.length !== 0 || r.length > 64 || t.length > 253)
    return false;
  if (r[0] === "." || r.endsWith(".") || r.includes(".."))
    return false;
  if (!/^[a-z0-9.-]+$/i.test(t) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(r))
    return false;
  return t.split(".").every((o) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(o));
};
var lr = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
var dr = /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i;
var pr = (e) => e.length > 1 && e.length < 80 && (/^P\d+([.,]\d+)?W$/.test(e) || /^P[\dYMDTHS]*(\d[.,]\d+)?[YMDHS]$/.test(e) && /^P([.,\d]+Y)?([.,\d]+M)?([.,\d]+D)?(T([.,\d]+H)?([.,\d]+M)?([.,\d]+S)?)?$/.test(e));
function le(e) {
  return e.test.bind(e);
}
var Me = { date: Je, time: et.bind(undefined, false), "date-time": $r, duration: pr, uri: gr, "uri-reference": le(rr), "uri-template": le(nr), url: le(sr), email: fr, hostname: le(tr), ipv4: le(lr), ipv6: le(dr), regex: xr, uuid: le(or), "json-pointer": le(ur), "json-pointer-uri-fragment": le(ir), "relative-json-pointer": le(ar) };
function cr(e) {
  return e % 4 === 0 && (e % 100 !== 0 || e % 400 === 0);
}
function Je(e) {
  let r = e.match(Yt);
  if (!r)
    return false;
  let t = +r[1], n = +r[2], o = +r[3];
  return n >= 1 && n <= 12 && o >= 1 && o <= (n == 2 && cr(t) ? 29 : Jt[n]);
}
function et(e, r) {
  let t = r.match(er);
  if (!t)
    return false;
  let n = +t[1], o = +t[2], u = +t[3], s = !!t[5];
  return (n <= 23 && o <= 59 && u <= 59 || n == 23 && o == 59 && u == 60) && (!e || s);
}
var hr = /t|\s/i;
function $r(e) {
  let r = e.split(hr);
  return r.length == 2 && Je(r[0]) && et(true, r[1]);
}
var mr = /\/|:/;
var yr = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
function gr(e) {
  return mr.test(e) && yr.test(e);
}
var _r = /[^\\]\\Z/;
function xr(e) {
  if (_r.test(e))
    return false;
  try {
    return new RegExp(e, "u"), true;
  } catch (r) {
    return false;
  }
}
function tt(e) {
  let r = 0, t = e.length, n = 0, o;
  while (n < t)
    if (r++, o = e.charCodeAt(n++), o >= 55296 && o <= 56319 && n < t) {
      if (o = e.charCodeAt(n), (o & 64512) == 56320)
        n++;
    }
  return r;
}
function F(e, r, t = "2019-09", n = ce(r), o = true, u = null, s = "#", i = "#", h = Object.create(null)) {
  if (r === true)
    return { valid: true, errors: [] };
  if (r === false)
    return { valid: false, errors: [{ instanceLocation: s, keyword: "false", keywordLocation: s, error: "False boolean schema." }] };
  let N = typeof e, _;
  switch (N) {
    case "boolean":
    case "number":
    case "string":
      _ = N;
      break;
    case "object":
      if (e === null)
        _ = "null";
      else if (Array.isArray(e))
        _ = "array";
      else
        _ = "object";
      break;
    default:
      throw Error(`Instances of "${N}" type are not supported.`);
  }
  let { $ref: w, $recursiveRef: M, $recursiveAnchor: K, type: g, const: k, enum: ee, required: q, not: L, anyOf: H, allOf: ne, oneOf: X, if: T, then: V, else: A, format: I, properties: a, patternProperties: Q, additionalProperties: C, unevaluatedProperties: B, minProperties: l, maxProperties: f, propertyNames: Y, dependentRequired: P, dependentSchemas: J, dependencies: te, prefixItems: W, items: ue, additionalItems: $e, unevaluatedItems: fe, contains: ae, minContains: R, maxContains: de, minItems: Re, maxItems: p, uniqueItems: j, minimum: d, maximum: O, exclusiveMinimum: D, exclusiveMaximum: U, multipleOf: z, minLength: re, maxLength: ie, pattern: pe, __absolute_ref__: we, __absolute_recursive_ref__: zt } = r, m = [];
  if (K === true && u === null)
    u = r;
  if (M === "#") {
    let E = u === null ? n[zt] : u, x = `${i}/$recursiveRef`, v = F(e, u === null ? r : u, t, n, o, E, s, x, h);
    if (!v.valid)
      m.push({ instanceLocation: s, keyword: "$recursiveRef", keywordLocation: x, error: "A subschema had errors." }, ...v.errors);
  }
  if (w !== undefined) {
    let x = n[we || w];
    if (x === undefined) {
      let c = `Unresolved $ref "${w}".`;
      if (we && we !== w)
        c += `  Absolute URI "${we}".`;
      throw c += `
Known schemas:
- ${Object.keys(n).join(`
- `)}`, Error(c);
    }
    let v = `${i}/$ref`, y = F(e, x, t, n, o, u, s, v, h);
    if (!y.valid)
      m.push({ instanceLocation: s, keyword: "$ref", keywordLocation: v, error: "A subschema had errors." }, ...y.errors);
    if (t === "4" || t === "7")
      return { valid: m.length === 0, errors: m };
  }
  if (Array.isArray(g)) {
    let E = g.length, x = false;
    for (let v = 0;v < E; v++)
      if (_ === g[v] || g[v] === "integer" && _ === "number" && e % 1 === 0 && e === e) {
        x = true;
        break;
      }
    if (!x)
      m.push({ instanceLocation: s, keyword: "type", keywordLocation: `${i}/type`, error: `Instance type "${_}" is invalid. Expected "${g.join('", "')}".` });
  } else if (g === "integer") {
    if (_ !== "number" || e % 1 || e !== e)
      m.push({ instanceLocation: s, keyword: "type", keywordLocation: `${i}/type`, error: `Instance type "${_}" is invalid. Expected "${g}".` });
  } else if (g !== undefined && _ !== g)
    m.push({ instanceLocation: s, keyword: "type", keywordLocation: `${i}/type`, error: `Instance type "${_}" is invalid. Expected "${g}".` });
  if (k !== undefined) {
    if (_ === "object" || _ === "array") {
      if (!_e(e, k))
        m.push({ instanceLocation: s, keyword: "const", keywordLocation: `${i}/const`, error: `Instance does not match ${JSON.stringify(k)}.` });
    } else if (e !== k)
      m.push({ instanceLocation: s, keyword: "const", keywordLocation: `${i}/const`, error: `Instance does not match ${JSON.stringify(k)}.` });
  }
  if (ee !== undefined) {
    if (_ === "object" || _ === "array") {
      if (!ee.some((E) => _e(e, E)))
        m.push({ instanceLocation: s, keyword: "enum", keywordLocation: `${i}/enum`, error: `Instance does not match any of ${JSON.stringify(ee)}.` });
    } else if (!ee.some((E) => e === E))
      m.push({ instanceLocation: s, keyword: "enum", keywordLocation: `${i}/enum`, error: `Instance does not match any of ${JSON.stringify(ee)}.` });
  }
  if (L !== undefined) {
    let E = `${i}/not`;
    if (F(e, L, t, n, o, u, s, E).valid)
      m.push({ instanceLocation: s, keyword: "not", keywordLocation: E, error: 'Instance matched "not" schema.' });
  }
  let Oe = [];
  if (H !== undefined) {
    let E = `${i}/anyOf`, x = m.length, v = false;
    for (let y = 0;y < H.length; y++) {
      let c = H[y], b = Object.create(h), S = F(e, c, t, n, o, K === true ? u : null, s, `${E}/${y}`, b);
      if (m.push(...S.errors), v = v || S.valid, S.valid)
        Oe.push(b);
    }
    if (v)
      m.length = x;
    else
      m.splice(x, 0, { instanceLocation: s, keyword: "anyOf", keywordLocation: E, error: "Instance does not match any subschemas." });
  }
  if (ne !== undefined) {
    let E = `${i}/allOf`, x = m.length, v = true;
    for (let y = 0;y < ne.length; y++) {
      let c = ne[y], b = Object.create(h), S = F(e, c, t, n, o, K === true ? u : null, s, `${E}/${y}`, b);
      if (m.push(...S.errors), v = v && S.valid, S.valid)
        Oe.push(b);
    }
    if (v)
      m.length = x;
    else
      m.splice(x, 0, { instanceLocation: s, keyword: "allOf", keywordLocation: E, error: "Instance does not match every subschema." });
  }
  if (X !== undefined) {
    let E = `${i}/oneOf`, x = m.length, v = X.filter((y, c) => {
      let b = Object.create(h), S = F(e, y, t, n, o, K === true ? u : null, s, `${E}/${c}`, b);
      if (m.push(...S.errors), S.valid)
        Oe.push(b);
      return S.valid;
    }).length;
    if (v === 1)
      m.length = x;
    else
      m.splice(x, 0, { instanceLocation: s, keyword: "oneOf", keywordLocation: E, error: `Instance does not match exactly one subschema (${v} matches).` });
  }
  if (_ === "object" || _ === "array")
    Object.assign(h, ...Oe);
  if (T !== undefined) {
    let E = `${i}/if`;
    if (F(e, T, t, n, o, u, s, E, h).valid) {
      if (V !== undefined) {
        let v = F(e, V, t, n, o, u, s, `${i}/then`, h);
        if (!v.valid)
          m.push({ instanceLocation: s, keyword: "if", keywordLocation: E, error: 'Instance does not match "then" schema.' }, ...v.errors);
      }
    } else if (A !== undefined) {
      let v = F(e, A, t, n, o, u, s, `${i}/else`, h);
      if (!v.valid)
        m.push({ instanceLocation: s, keyword: "if", keywordLocation: E, error: 'Instance does not match "else" schema.' }, ...v.errors);
    }
  }
  if (_ === "object") {
    if (q !== undefined) {
      for (let y of q)
        if (!(y in e))
          m.push({ instanceLocation: s, keyword: "required", keywordLocation: `${i}/required`, error: `Instance does not have required property "${y}".` });
    }
    let E = Object.keys(e);
    if (l !== undefined && E.length < l)
      m.push({ instanceLocation: s, keyword: "minProperties", keywordLocation: `${i}/minProperties`, error: `Instance does not have at least ${l} properties.` });
    if (f !== undefined && E.length > f)
      m.push({ instanceLocation: s, keyword: "maxProperties", keywordLocation: `${i}/maxProperties`, error: `Instance does not have at least ${f} properties.` });
    if (Y !== undefined) {
      let y = `${i}/propertyNames`;
      for (let c in e) {
        let b = `${s}/${oe(c)}`, S = F(c, Y, t, n, o, u, b, y);
        if (!S.valid)
          m.push({ instanceLocation: s, keyword: "propertyNames", keywordLocation: y, error: `Property name "${c}" does not match schema.` }, ...S.errors);
      }
    }
    if (P !== undefined) {
      let y = `${i}/dependantRequired`;
      for (let c in P)
        if (c in e) {
          let b = P[c];
          for (let S of b)
            if (!(S in e))
              m.push({ instanceLocation: s, keyword: "dependentRequired", keywordLocation: y, error: `Instance has "${c}" but does not have "${S}".` });
        }
    }
    if (J !== undefined)
      for (let y in J) {
        let c = `${i}/dependentSchemas`;
        if (y in e) {
          let b = F(e, J[y], t, n, o, u, s, `${c}/${oe(y)}`, h);
          if (!b.valid)
            m.push({ instanceLocation: s, keyword: "dependentSchemas", keywordLocation: c, error: `Instance has "${y}" but does not match dependant schema.` }, ...b.errors);
        }
      }
    if (te !== undefined) {
      let y = `${i}/dependencies`;
      for (let c in te)
        if (c in e) {
          let b = te[c];
          if (Array.isArray(b)) {
            for (let S of b)
              if (!(S in e))
                m.push({ instanceLocation: s, keyword: "dependencies", keywordLocation: y, error: `Instance has "${c}" but does not have "${S}".` });
          } else {
            let S = F(e, b, t, n, o, u, s, `${y}/${oe(c)}`);
            if (!S.valid)
              m.push({ instanceLocation: s, keyword: "dependencies", keywordLocation: y, error: `Instance has "${c}" but does not match dependant schema.` }, ...S.errors);
          }
        }
    }
    let x = Object.create(null), v = false;
    if (a !== undefined) {
      let y = `${i}/properties`;
      for (let c in a) {
        if (!(c in e))
          continue;
        let b = `${s}/${oe(c)}`, S = F(e[c], a[c], t, n, o, u, b, `${y}/${oe(c)}`);
        if (S.valid)
          h[c] = x[c] = true;
        else if (v = o, m.push({ instanceLocation: s, keyword: "properties", keywordLocation: y, error: `Property "${c}" does not match schema.` }, ...S.errors), v)
          break;
      }
    }
    if (!v && Q !== undefined) {
      let y = `${i}/patternProperties`;
      for (let c in Q) {
        let b = new RegExp(c, "u"), S = Q[c];
        for (let se in e) {
          if (!b.test(se))
            continue;
          let Qe = `${s}/${oe(se)}`, Ze = F(e[se], S, t, n, o, u, Qe, `${y}/${oe(c)}`);
          if (Ze.valid)
            h[se] = x[se] = true;
          else
            v = o, m.push({ instanceLocation: s, keyword: "patternProperties", keywordLocation: y, error: `Property "${se}" matches pattern "${c}" but does not match associated schema.` }, ...Ze.errors);
        }
      }
    }
    if (!v && C !== undefined) {
      let y = `${i}/additionalProperties`;
      for (let c in e) {
        if (x[c])
          continue;
        let b = `${s}/${oe(c)}`, S = F(e[c], C, t, n, o, u, b, y);
        if (S.valid)
          h[c] = true;
        else
          v = o, m.push({ instanceLocation: s, keyword: "additionalProperties", keywordLocation: y, error: `Property "${c}" does not match additional properties schema.` }, ...S.errors);
      }
    } else if (!v && B !== undefined) {
      let y = `${i}/unevaluatedProperties`;
      for (let c in e)
        if (!h[c]) {
          let b = `${s}/${oe(c)}`, S = F(e[c], B, t, n, o, u, b, y);
          if (S.valid)
            h[c] = true;
          else
            m.push({ instanceLocation: s, keyword: "unevaluatedProperties", keywordLocation: y, error: `Property "${c}" does not match unevaluated properties schema.` }, ...S.errors);
        }
    }
  } else if (_ === "array") {
    if (p !== undefined && e.length > p)
      m.push({ instanceLocation: s, keyword: "maxItems", keywordLocation: `${i}/maxItems`, error: `Array has too many items (${e.length} > ${p}).` });
    if (Re !== undefined && e.length < Re)
      m.push({ instanceLocation: s, keyword: "minItems", keywordLocation: `${i}/minItems`, error: `Array has too few items (${e.length} < ${Re}).` });
    let E = e.length, x = 0, v = false;
    if (W !== undefined) {
      let y = `${i}/prefixItems`, c = Math.min(W.length, E);
      for (;x < c; x++) {
        let b = F(e[x], W[x], t, n, o, u, `${s}/${x}`, `${y}/${x}`);
        if (h[x] = true, !b.valid) {
          if (v = o, m.push({ instanceLocation: s, keyword: "prefixItems", keywordLocation: y, error: "Items did not match schema." }, ...b.errors), v)
            break;
        }
      }
    }
    if (ue !== undefined) {
      let y = `${i}/items`;
      if (Array.isArray(ue)) {
        let c = Math.min(ue.length, E);
        for (;x < c; x++) {
          let b = F(e[x], ue[x], t, n, o, u, `${s}/${x}`, `${y}/${x}`);
          if (h[x] = true, !b.valid) {
            if (v = o, m.push({ instanceLocation: s, keyword: "items", keywordLocation: y, error: "Items did not match schema." }, ...b.errors), v)
              break;
          }
        }
      } else
        for (;x < E; x++) {
          let c = F(e[x], ue, t, n, o, u, `${s}/${x}`, y);
          if (h[x] = true, !c.valid) {
            if (v = o, m.push({ instanceLocation: s, keyword: "items", keywordLocation: y, error: "Items did not match schema." }, ...c.errors), v)
              break;
          }
        }
      if (!v && $e !== undefined) {
        let c = `${i}/additionalItems`;
        for (;x < E; x++) {
          let b = F(e[x], $e, t, n, o, u, `${s}/${x}`, c);
          if (h[x] = true, !b.valid)
            v = o, m.push({ instanceLocation: s, keyword: "additionalItems", keywordLocation: c, error: "Items did not match additional items schema." }, ...b.errors);
        }
      }
    }
    if (ae !== undefined)
      if (E === 0 && R === undefined)
        m.push({ instanceLocation: s, keyword: "contains", keywordLocation: `${i}/contains`, error: "Array is empty. It must contain at least one item matching the schema." });
      else if (R !== undefined && E < R)
        m.push({ instanceLocation: s, keyword: "minContains", keywordLocation: `${i}/minContains`, error: `Array has less items (${E}) than minContains (${R}).` });
      else {
        let y = `${i}/contains`, c = m.length, b = 0;
        for (let S = 0;S < E; S++) {
          let se = F(e[S], ae, t, n, o, u, `${s}/${S}`, y);
          if (se.valid)
            h[S] = true, b++;
          else
            m.push(...se.errors);
        }
        if (b >= (R || 0))
          m.length = c;
        if (R === undefined && de === undefined && b === 0)
          m.splice(c, 0, { instanceLocation: s, keyword: "contains", keywordLocation: y, error: "Array does not contain item matching schema." });
        else if (R !== undefined && b < R)
          m.push({ instanceLocation: s, keyword: "minContains", keywordLocation: `${i}/minContains`, error: `Array must contain at least ${R} items matching schema. Only ${b} items were found.` });
        else if (de !== undefined && b > de)
          m.push({ instanceLocation: s, keyword: "maxContains", keywordLocation: `${i}/maxContains`, error: `Array may contain at most ${de} items matching schema. ${b} items were found.` });
      }
    if (!v && fe !== undefined) {
      let y = `${i}/unevaluatedItems`;
      for (x;x < E; x++) {
        if (h[x])
          continue;
        let c = F(e[x], fe, t, n, o, u, `${s}/${x}`, y);
        if (h[x] = true, !c.valid)
          m.push({ instanceLocation: s, keyword: "unevaluatedItems", keywordLocation: y, error: "Items did not match unevaluated items schema." }, ...c.errors);
      }
    }
    if (j)
      for (let y = 0;y < E; y++) {
        let c = e[y], b = typeof c === "object" && c !== null;
        for (let S = 0;S < E; S++) {
          if (y === S)
            continue;
          let se = e[S];
          if (c === se || b && (typeof se === "object" && se !== null) && _e(c, se))
            m.push({ instanceLocation: s, keyword: "uniqueItems", keywordLocation: `${i}/uniqueItems`, error: `Duplicate items at indexes ${y} and ${S}.` }), y = Number.MAX_SAFE_INTEGER, S = Number.MAX_SAFE_INTEGER;
        }
      }
  } else if (_ === "number") {
    if (t === "4") {
      if (d !== undefined && (D === true && e <= d || e < d))
        m.push({ instanceLocation: s, keyword: "minimum", keywordLocation: `${i}/minimum`, error: `${e} is less than ${D ? "or equal to " : ""} ${d}.` });
      if (O !== undefined && (U === true && e >= O || e > O))
        m.push({ instanceLocation: s, keyword: "maximum", keywordLocation: `${i}/maximum`, error: `${e} is greater than ${U ? "or equal to " : ""} ${O}.` });
    } else {
      if (d !== undefined && e < d)
        m.push({ instanceLocation: s, keyword: "minimum", keywordLocation: `${i}/minimum`, error: `${e} is less than ${d}.` });
      if (O !== undefined && e > O)
        m.push({ instanceLocation: s, keyword: "maximum", keywordLocation: `${i}/maximum`, error: `${e} is greater than ${O}.` });
      if (D !== undefined && e <= D)
        m.push({ instanceLocation: s, keyword: "exclusiveMinimum", keywordLocation: `${i}/exclusiveMinimum`, error: `${e} is less than ${D}.` });
      if (U !== undefined && e >= U)
        m.push({ instanceLocation: s, keyword: "exclusiveMaximum", keywordLocation: `${i}/exclusiveMaximum`, error: `${e} is greater than or equal to ${U}.` });
    }
    if (z !== undefined) {
      let E = e % z;
      if (Math.abs(0 - E) >= 0.00000011920929 && Math.abs(z - E) >= 0.00000011920929)
        m.push({ instanceLocation: s, keyword: "multipleOf", keywordLocation: `${i}/multipleOf`, error: `${e} is not a multiple of ${z}.` });
    }
  } else if (_ === "string") {
    let E = re === undefined && ie === undefined ? 0 : tt(e);
    if (re !== undefined && E < re)
      m.push({ instanceLocation: s, keyword: "minLength", keywordLocation: `${i}/minLength`, error: `String is too short (${E} < ${re}).` });
    if (ie !== undefined && E > ie)
      m.push({ instanceLocation: s, keyword: "maxLength", keywordLocation: `${i}/maxLength`, error: `String is too long (${E} > ${ie}).` });
    if (pe !== undefined && !new RegExp(pe, "u").test(e))
      m.push({ instanceLocation: s, keyword: "pattern", keywordLocation: `${i}/pattern`, error: "String does not match pattern." });
    if (I !== undefined && Me[I] && !Me[I](e))
      m.push({ instanceLocation: s, keyword: "format", keywordLocation: `${i}/format`, error: `String does not match format "${I}".` });
  }
  return { valid: m.length === 0, errors: m };
}

class rt {
  schema;
  draft;
  shortCircuit;
  lookup;
  constructor(e, r = "2019-09", t = true) {
    this.schema = e, this.draft = r, this.shortCircuit = t, this.lookup = ce(e);
  }
  validate(e) {
    return F(e, this.schema, this.draft, this.lookup, this.shortCircuit);
  }
  addSchema(e, r) {
    if (r)
      e = { ...e, $id: r };
    ce(e, this.lookup);
  }
}
var Ar = /^[A-Za-z]:\//;
function Ee(e = "") {
  if (!e)
    return e;
  return e.replace(/\\/g, "/").replace(Ar, (r) => r.toUpperCase());
}
var Er = /^[/\\](?![/\\])|^[/\\]{2}(?!\.)|^[A-Za-z]:[/\\]/;
function br() {
  return "/";
}
var ve = function(...e) {
  e = e.map((n) => Ee(n));
  let r = "", t = false;
  for (let n = e.length - 1;n >= -1 && !t; n--) {
    let o = n >= 0 ? e[n] : br();
    if (!o || o.length === 0)
      continue;
    r = `${o}/${r}`, t = ye(o);
  }
  if (r = ze(r, !t), t && !ye(r))
    return `/${r}`;
  return r.length > 0 ? r : ".";
};
function ze(e, r) {
  let t = "", n = 0, o = -1, u = 0, s = null;
  for (let i = 0;i <= e.length; ++i) {
    if (i < e.length)
      s = e[i];
    else if (s === "/")
      break;
    else
      s = "/";
    if (s === "/") {
      if (o === i - 1 || u === 1)
        ;
      else if (u === 2) {
        if (t.length < 2 || n !== 2 || t[t.length - 1] !== "." || t[t.length - 2] !== ".") {
          if (t.length > 2) {
            let h = t.lastIndexOf("/");
            if (h === -1)
              t = "", n = 0;
            else
              t = t.slice(0, h), n = t.length - 1 - t.lastIndexOf("/");
            o = i, u = 0;
            continue;
          } else if (t.length > 0) {
            t = "", n = 0, o = i, u = 0;
            continue;
          }
        }
        if (r)
          t += t.length > 0 ? "/.." : "..", n = 2;
      } else {
        if (t.length > 0)
          t += `/${e.slice(o + 1, i)}`;
        else
          t = e.slice(o + 1, i);
        n = i - o - 1;
      }
      o = i, u = 0;
    } else if (s === "." && u !== -1)
      ++u;
    else
      u = -1;
  }
  return t;
}
var ye = function(e) {
  return Er.test(e);
};
var ft = function(e, r) {
  let t = Ee(e).split("/"), n = "";
  for (let o = t.length - 1;o >= 0; o--) {
    let u = t[o];
    if (u) {
      n = u;
      break;
    }
  }
  return r && n.endsWith(r) ? n.slice(0, -r.length) : n;
};
var Sn = Kt(wt(), 1);
var Mt = vt();
var Dt = Pt();
var $s = Sn.default;

// node_modules/@cmodjs/core/utils/paths.js
var missingPath = /(?:^|: )(?:ENOENT|ENOTDIR)\b/;
function isMissing(error) {
  return missingPath.test(messageOf(error));
}
function ifMissing(value) {
  return (error) => {
    if (isMissing(error))
      return value;
    throw error;
  };
}
var homePrefix = /^(~|\$HOME|\$CLAUDE_CONFIG_DIR)(?=\/|$)/;
function expandHome(path, home, configRoot = `${home}/.claude`) {
  const prefix = homePrefix.exec(path)?.[0];
  if (prefix === undefined)
    return path;
  return `${prefix === "$CLAUDE_CONFIG_DIR" ? configRoot : home}${path.slice(prefix.length)}`;
}
function relativePath(base, path) {
  if (path === base)
    return "";
  const prefix = base === "/" ? "/" : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

// node_modules/@cmodjs/core/runtime/device.js
var cmodAppId = "1fd8a8ee972047c4a89640fd51048522";
var sha256Block = 64;
var systems = { Darwin: "darwin", Linux: "linux" };
var machines = { arm64: "arm64", aarch64: "arm64", x86_64: "x64", amd64: "x64" };
var platformUuid = /"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"/;
var machineId = /^[0-9a-f]{32}$/;
var machineIdFiles = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

class MissingMachineId extends Error {
}
async function readDevice(claude) {
  const output = async (argv) => {
    const { exitCode, stdout, stderr } = await claude.process.run(argv);
    if (exitCode !== 0)
      throw new Error(`cmod could not read this computer: ${argv.join(" ")} ${formatExit(exitCode, stderr)}`);
    return stdout.trim();
  };
  const [system = "", node = "", machine = ""] = (await output(["uname", "-snm"])).split(/\s+/);
  const os = systems[system];
  const arch = machines[machine];
  if (os === undefined)
    throw new Error(`cmod reads the device of macOS and Linux, and this computer runs ${system}.`);
  if (arch === undefined)
    throw new Error(`cmod reads the device of arm64 and x64 computers, and this one is ${machine}.`);
  if (os === "linux")
    return { id: await appSpecific(await linuxMachineId(claude.fs)), name: node, os, arch };
  const [platform, name] = await Promise.all([output(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]), output(["scutil", "--get", "LocalHostName"])]);
  const uuid = platformUuid.exec(platform)?.[1];
  if (uuid === undefined)
    throw new Error("cmod could not read this computer: ioreg -rd1 -c IOPlatformExpertDevice names no IOPlatformUUID.");
  return { id: await appSpecific(uuid.replaceAll("-", "").toLowerCase()), name, os, arch };
}
async function linuxMachineId(fs) {
  for (const path of machineIdFiles) {
    const id = (await fs.read(path).catch(ifMissing(""))).trim();
    if (machineId.test(id))
      return id;
  }
  throw new MissingMachineId(`cmod could not read this computer: neither ${machineIdFiles.join(" nor ")} holds a machine id.`);
}
async function appSpecific(machine) {
  if (!machineId.test(machine))
    throw new Error("cmod could not read this computer: its machine id is not 32 hex digits.");
  const id = (await hmacSha256(bytesOf(machine), bytesOf(cmodAppId))).slice(0, 16);
  id[6] = (id[6] ?? 0) & 15 | 64;
  id[8] = (id[8] ?? 0) & 63 | 128;
  return [...id].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256(key, message) {
  const sha256 = async (...parts) => new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(parts.flatMap((part) => [...part]))));
  const padded = new Uint8Array(sha256Block);
  padded.set(key);
  return sha256(padded.map((byte) => byte ^ 92), await sha256(padded.map((byte) => byte ^ 54), message));
}
function bytesOf(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

// node_modules/@cmodjs/core/runtime/announce.js
var announcementMs = 1e4;
async function announcementOf(claude, plugin, added, openSettings) {
  const manifest = jsonOf(await claude.fs.read(`${plugin.root}/.claude-plugin/plugin.json`).catch(ifMissing(undefined)));
  const { program, hotkeys } = plugin.steps;
  const rules = (await claude.fs.list(`${plugin.root}/rules`).catch(ifMissing([]))).filter((entry) => entry.kind === "file" && entry.name.endsWith(".md")).map((entry) => entry.name.slice(0, -".md".length)).toSorted();
  const lines = [
    isObject(manifest) && typeof manifest["description"] === "string" ? manifest["description"] : undefined,
    added.length > 0 ? `Adds ${listed(added)}.` : undefined,
    rules.length > 0 ? `Adds ${rules.length} ${rules.length === 1 ? "rule" : "rules"}: ${listed(rules)}.` : undefined,
    program === undefined ? undefined : `Installed the ${program} program.`,
    ...Object.values(hotkeys ?? {}).flatMap(({ title, default: combo }) => combo === undefined ? [] : [`Binds ${combo} to ${title}.`])
  ].filter((line) => line !== undefined);
  return { message: "Installed", ...lines.length === 0 ? {} : { description: lines.join(`
`) }, action: { label: "Settings", onClick: () => openSettings() } };
}
function jsonOf(text) {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      return;
    throw error;
  }
}

// node_modules/@cmodjs/core/session/context/turn/message/message.js
var Message = "message";
var skillPrefix = "Base directory for this skill:";
var interruption = /^\[Request interrupted by user( for tool use)?\]$/;
var memoryPath = /^Contents of (.+?)(?: \([^)\n]*\))?:\r?$/m;
function instructionPathOf(text) {
  return memoryPath.exec(text)?.[1] ?? "";
}
function rowOfAppend(append, at, cwd) {
  const { message, origin } = append;
  const text = textOf(message.content);
  const path = message.type === "attachment" ? (attachmentTypeOf(message.name) !== undefined ? attachedPathOf(text) : instructionPathOf(text)) || undefined : undefined;
  const model = isObject(origin) && origin["kind"] === "model" && typeof origin["model"] === "string" ? origin["model"] : undefined;
  return {
    id: append.uuid,
    at,
    type: message.type,
    ...message.name === undefined ? {} : { name: message.name },
    isMeta: message.isMeta === true,
    isSummary: append.door === "compaction",
    content: message.content,
    origin,
    cwd,
    ...path === undefined ? {} : { path },
    ...model === undefined ? {} : { model }
  };
}
var noFiles = { read: [], changed: [] };
function messagesOf(row, isInTask) {
  const found = unplacedOf(row, isInTask);
  return found.length === 1 ? found : found.map((message, index) => ({ ...message, id: `${row.id}:${index}` }));
}
function unplacedOf(row, isInTask) {
  const base = { id: row.id, at: row.at };
  const text = textOf(row.content).trim();
  const notesFrom = (each) => each.map((note) => ({ ...base, type: Note, text: note.text, from: { type: Mod, name: note.mod } }));
  if (row.type === "system")
    return row.name === "turn_duration" || row.name === "compact_boundary" || text === "" ? [] : [{ ...base, type: Notice, text }];
  if (row.type === "attachment" && row.name === "hook_additional_context")
    return notesFrom(row.content.flatMap((entry) => modNotesIn(typeof entry === "string" ? entry : textOf([entry]))));
  if (row.type === "attachment" && row.name === "nested_memory")
    return [{ ...base, type: InstructionFile, path: row.path ?? "", text, isRule: isRulePath(row.path ?? "") }];
  if (row.type === "attachment") {
    const attachmentType = attachmentTypeOf(row.name);
    return attachmentType === undefined ? [] : [{ ...base, type: AttachedFile, path: row.path ?? "", attachmentType, text }];
  }
  if (isModNotesRow(row))
    return notesFrom(modNotesIn(text));
  if (row.type === "assistant") {
    return row.content.filter(isObject).flatMap((block) => {
      if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].trim() !== "")
        return [{ ...base, type: Reply, text: block["text"].trim() }];
      if (block["type"] !== "tool_use" || typeof block["id"] !== "string" || typeof block["name"] !== "string")
        return [];
      return [{ ...base, type: ToolCall, callId: block["id"], name: block["name"], input: isObject(block["input"]) ? block["input"] : {}, cwd: row.cwd ?? "", files: noFiles }];
    });
  }
  if (row.isSummary)
    return [];
  const results = row.content.filter(isToolResultBlock);
  if (results.length > 0)
    return results.map((block) => ({ ...base, type: ToolResult, callId: block["tool_use_id"], name: "", input: {}, cwd: row.cwd ?? "", files: noFiles, output: textOf(block["content"]), isError: block["is_error"] === true }));
  if (text === "")
    return [];
  if (text.startsWith(skillPrefix))
    return [{ ...base, type: Skill, name: basename(text.slice(skillPrefix.length).split(`
`)[0]?.trim() ?? ""), text }];
  if (text.startsWith("<task-notification"))
    return [{ ...base, type: Note, text: tagOf(text, "summary") ?? text, from: { type: Task } }];
  if (interruption.test(text))
    return [];
  const from = senderOf(row.origin, isInTask);
  if (row.isMeta)
    return [{ ...base, type: Note, text, from }];
  const prompt = promptText(text);
  const isPluginCommand = from.type === Mod && tagOf(text, "command-name") !== undefined;
  return prompt === undefined || isPluginCommand ? [] : [{ ...base, type: Prompt, text: prompt, from }];
}
function isModNotesRow(row) {
  const text = textOf(row.content);
  return row.type === "user" && !row.content.some(isToolResultBlock) && modNotesIn(text).length > 0 && text.replace(modNoteBlock, "").trim() === "";
}
function withNoteTexts(entries, texts) {
  let index = -1;
  const replaced = (text) => text.replace(modNoteBlock, (whole, mod) => {
    index += 1;
    const changed = texts.get(index);
    if (changed === undefined)
      return whole;
    return changed === "" ? "" : modNote(mod, changed);
  });
  return entries.map((entry) => {
    if (typeof entry === "string")
      return replaced(entry);
    return isObject(entry) && entry["type"] === "text" && typeof entry["text"] === "string" ? { ...entry, text: replaced(entry["text"]) } : entry;
  });
}
function withTexts(row, texts) {
  if (row.type === "attachment" && row.name === "hook_additional_context")
    return withNoteTexts(row.content, texts);
  if (isModNotesRow(row))
    return keepingMedia(row.content, withNoteTexts([textOf(row.content)], texts)[0]);
  if (row.type === "assistant") {
    let index = -1;
    return row.content.map((block) => {
      if (!isObject(block))
        return block;
      const isText = block["type"] === "text" && typeof block["text"] === "string" && block["text"].trim() !== "";
      const isCall = block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string";
      if (!isText && !isCall)
        return block;
      index += 1;
      const text = texts.get(index);
      return isText && text !== undefined ? { ...block, text } : block;
    });
  }
  if (row.type === "user" && row.content.some(isToolResultBlock)) {
    let index = -1;
    return row.content.map((block) => {
      if (!isToolResultBlock(block))
        return block;
      index += 1;
      const text = texts.get(index);
      if (text === undefined)
        return block;
      return { ...block, content: Array.isArray(block["content"]) ? keepingMedia(block["content"], text) : text };
    });
  }
  const text = texts.get(0);
  if (text === undefined)
    return row.content;
  const whole = textOf(row.content);
  if (whole.trim().startsWith("<task-notification") && tagOf(whole, "summary") !== undefined)
    return keepingMedia(row.content, whole.replace(/<summary>[\s\S]*?<\/summary>/, () => `<summary>${text}</summary>`));
  return keepingMedia(row.content, text);
}
function keepingMedia(content, text) {
  return [{ type: "text", text }, ...content.filter((block) => !isObject(block) || block["type"] !== "text")];
}
function isToolResultBlock(block) {
  return isObject(block) && block["type"] === "tool_result" && typeof block["tool_use_id"] === "string";
}
function textOf(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.flatMap((block) => isObject(block) && block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : []).join(`
`);
}
function tagOf(text, tag) {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim();
}
function promptText(text) {
  if (text.startsWith("<local-command-") || text.startsWith("<bash-stdout") || text.startsWith("<bash-stderr"))
    return;
  const command = tagOf(text, "command-name");
  if (command === undefined)
    return text;
  const args = tagOf(text, "command-args") ?? "";
  return args === "" ? command : `${command} ${args}`;
}
function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

// node_modules/@cmodjs/core/session/context/context.js
var ContextStart = "contextStart";
var ContextEnd = "contextEnd";

// node_modules/@cmodjs/core/session/context/turn/device.js
var deviceLine = /^As of \S+, this session runs on (.+), a (darwin|linux) (arm64|x64) computer with the cmod device id ([0-9a-f]{32})\.$/m;
function deviceNote({ id, name, os, arch }, at) {
  return `As of ${at}, this session runs on ${name}, a ${os} ${arch} computer with the cmod device id ${id}.`;
}
function deviceOf(note) {
  if (note.from.type !== Mod)
    return;
  const [, name, os, arch, id] = deviceLine.exec(note.text) ?? [];
  return name === undefined || id === undefined ? undefined : { id, name, os, arch };
}

// node_modules/@cmodjs/core/session/context/turn/turn.js
var TurnStart = "turnStart";
var TurnEnd2 = "turnEnd";

// node_modules/@cmodjs/core/session/goal/goal.js
var GoalChange = "goalChange";

// node_modules/@cmodjs/core/session/conversation.js
var forkAgentType = "fork";
function ownerOfSpawn(agentType, session) {
  return agentType === forkAgentType ? { forkedFrom: session } : { agentType: agentType ?? "general-purpose" };
}
function tasksWithAgents(tasks, agents) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return tasks.map((task) => {
    const agent = byId.get(task.id);
    return agent === undefined ? task : { ...task, status: agent.status, ...agent.name === undefined ? {} : { name: agent.name }, ...agent.spawnedBy === undefined ? {} : { spawnedBy: agent.spawnedBy } };
  });
}
var searchLimit = 50;
var agentTools = ["Agent", "Task"];
var asyncLaunch = "Async agent launched";
function emptyConversation(session) {
  return { session, context: 0, contextOpenedAt: "", agentCalls: [], endedCalls: {}, tasks: {}, taskTurns: {} };
}
function createConversation(start) {
  let { context, contextOpenedAt, turn, goal, device } = start;
  const agentCalls = new Set(start.agentCalls);
  const endedCalls = new Map(Object.entries(start.endedCalls));
  const tasks = new Map(Object.entries(start.tasks));
  const taskTurns = new Map(Object.entries(start.taskTurns));
  const openCalls = new Map(Object.entries(start.openCalls ?? {}));
  const endTaskTurn = (task, at, ending = {}) => {
    const open = taskTurns.get(task);
    if (open === undefined)
      return [];
    taskTurns.delete(task);
    return open.closedAt === undefined ? [{ type: TurnEnd2, turn: { ...open, ...ending, closedAt: at } }] : [];
  };
  const startContext = (at) => {
    context += 1;
    contextOpenedAt = at;
    return [{ type: ContextStart, context: { number: context, openedAt: at } }];
  };
  const endContext = (at) => context === 0 ? [] : [{ type: ContextEnd, context: { number: context, openedAt: contextOpenedAt, closedAt: at } }];
  const compactTask = (task, at) => {
    const owner = tasks.get(task);
    if (owner === undefined)
      return [];
    const next = { ...owner, context: owner.context + 1, contextOpenedAt: at };
    tasks.set(task, next);
    return [
      { type: ContextEnd, context: { number: owner.context, openedAt: owner.contextOpenedAt ?? owner.openedAt, closedAt: at, task } },
      { type: ContextStart, context: { number: next.context, openedAt: at, task } }
    ];
  };
  const endTurn = (at, ending = {}) => {
    if (turn === undefined)
      return [];
    const ended = { ...turn, ...ending, closedAt: at };
    turn = undefined;
    return [{ type: TurnEnd2, turn: ended }];
  };
  const endCall = (call, at, only) => {
    const opened = [...tasks.values()].filter((each) => each.openedBy === call && (only === undefined || each.id === only));
    if (opened.length === 0) {
      if (agentCalls.has(call))
        endedCalls.set(call, at);
      return [];
    }
    if (only === undefined)
      agentCalls.delete(call);
    return opened.flatMap((task) => {
      if (task.closedAt !== undefined)
        return [];
      const ended = { ...task, closedAt: at };
      tasks.set(task.id, ended);
      return [...endTaskTurn(task.id, at), { type: TaskEnd, task: ended }];
    });
  };
  const changeGoal = (text) => {
    goal = text;
    return [{ type: GoalChange, goal: { text } }];
  };
  return {
    add(row, task) {
      const changes = [];
      if (task === undefined && context === 0)
        changes.push(...startContext(row.at));
      if (task === undefined && row.type === "system" && row.name === "turn_duration")
        return [...changes, ...endTurn(row.at)];
      if (row.type === "system" && row.name === "compact_boundary")
        return [...changes, ...task === undefined ? [...endContext(row.at), ...startContext(row.at)] : compactTask(task, row.at)];
      const owner = task === undefined ? undefined : tasks.get(task);
      const placedIn = owner?.context ?? context;
      for (const unplaced of messagesOf(row, task !== undefined)) {
        if (task === undefined && unplaced.type === Note)
          device = deviceOf(unplaced) ?? device;
        if (unplaced.type === Prompt) {
          changes.push(...task === undefined ? endTurn(row.at) : endTaskTurn(task, row.at));
          const ranOn = task === undefined ? device : owner?.device;
          const opened = { prompt: { ...unplaced, session: start.session, context: placedIn, turn: unplaced.id, ...task === undefined ? {} : { task } }, context: placedIn, openedAt: row.at, ...owner?.closedAt === undefined ? {} : { closedAt: owner.closedAt }, ...ranOn === undefined ? {} : { device: ranOn } };
          if (task === undefined)
            turn = opened;
          else
            taskTurns.set(task, opened);
          changes.push({ type: TurnStart, turn: opened });
          if (task === undefined && goal === undefined)
            changes.push(...changeGoal(unplaced.text));
        }
        const open = task === undefined ? turn : taskTurns.get(task);
        const call = unplaced.type === ToolResult ? openCalls.get(unplaced.callId) : undefined;
        if (unplaced.type === ToolCall)
          openCalls.set(unplaced.callId, { name: unplaced.name, input: unplaced.input, cwd: unplaced.cwd });
        if (unplaced.type === ToolResult)
          openCalls.delete(unplaced.callId);
        const placed = {
          ...unplaced,
          ...call,
          session: start.session,
          context: placedIn,
          ...open === undefined ? {} : { turn: open.prompt.id },
          ...task === undefined ? {} : { task }
        };
        changes.push({ type: Message, message: placed });
        if (placed.type === ToolCall && agentTools.includes(placed.name))
          agentCalls.add(placed.callId);
        if (placed.type === ToolResult && agentCalls.has(placed.callId) && !String(placed.output).startsWith(asyncLaunch))
          changes.push(...endCall(placed.callId, row.at));
        if (placed.type === Note && placed.from.type === Task) {
          const call = tagOf(textOf(row.content), "tool-use-id");
          if (call !== undefined && agentCalls.has(call))
            changes.push(...endCall(call, row.at, tagOf(textOf(row.content), "task-id")));
        }
      }
      return changes;
    },
    startTask(data) {
      if (tasks.has(data.id))
        return [];
      const started = { ...data, context, ...device === undefined ? {} : { device } };
      tasks.set(data.id, started);
      agentCalls.add(data.openedBy);
      const changes = [{ type: TaskStart, task: started }];
      const endedAt = endedCalls.get(data.openedBy);
      if (endedAt !== undefined)
        changes.push(...endCall(data.openedBy, endedAt, data.id));
      return changes;
    },
    endTask(data, at) {
      const open = tasks.get(data.id) ?? { ...data, context };
      if (open.closedAt !== undefined)
        return [];
      const ended = { ...open, closedAt: at };
      tasks.set(data.id, ended);
      return [...endTaskTurn(data.id, at), { type: TaskEnd, task: ended }];
    },
    startContext,
    endTurn: (at, ending, task) => task === undefined ? endTurn(at, ending) : endTaskTurn(task, at, ending),
    changeGoal,
    get state() {
      return {
        session: start.session,
        context,
        contextOpenedAt,
        ...turn === undefined ? {} : { turn },
        ...goal === undefined ? {} : { goal },
        ...device === undefined ? {} : { device },
        agentCalls: [...agentCalls],
        endedCalls: Object.fromEntries(endedCalls),
        tasks: Object.fromEntries(tasks),
        taskTurns: Object.fromEntries(taskTurns),
        openCalls: Object.fromEntries(openCalls)
      };
    }
  };
}

// node_modules/@cmodjs/core/utils/matcher.js
function matches(value, matcher) {
  if (matcher instanceof RegExp)
    return value !== undefined && value !== null && matcher.test(String(value));
  if (Array.isArray(matcher))
    return matcher.some((each) => matches(value, each));
  if (typeof matcher !== "object" || matcher === null)
    return value === matcher;
  if (Array.isArray(value))
    return value.some((each) => matches(each, matcher));
  if (typeof value !== "object" || value === null)
    return false;
  return Object.entries(matcher).every(([key, wanted]) => wanted === undefined || matches(value[key], wanted));
}
function sentMatcher(matcher) {
  if (matcher instanceof RegExp)
    return { regexp: matcher.source, flags: matcher.flags };
  if (Array.isArray(matcher))
    return matcher.map(sentMatcher);
  if (typeof matcher !== "object" || matcher === null)
    return matcher;
  return Object.fromEntries(Object.entries(matcher).filter(([, value]) => value !== undefined).map(([key, value]) => [key, sentMatcher(value)]));
}
function receivedMatcher(sent) {
  if (Array.isArray(sent))
    return sent.map(receivedMatcher);
  if (typeof sent !== "object" || sent === null)
    return sent;
  const fields = sent;
  if (typeof fields["regexp"] === "string" && typeof fields["flags"] === "string" && Object.keys(fields).length === 2)
    return new RegExp(fields["regexp"], fields["flags"]);
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, receivedMatcher(value)]));
}

// node_modules/@cmodjs/core/runtime/tool-calls.js
var reservedKeys = ["tool", "tool_use_id", "consent", "agentId"];
function toolInputOf(envelope) {
  return Object.fromEntries(Object.entries(envelope).filter(([key]) => !reservedKeys.includes(key)));
}
function toolCalls(claude, router) {
  let mainAgentType;
  const agentIds = new Map;
  const noteAgent = (e) => {
    if (e.agent_id === undefined)
      mainAgentType = e.agent_type;
  };
  router.add("classic.SessionStart", (e, next) => {
    noteAgent(e);
    return next(e);
  });
  router.add("classic.UserPromptSubmit", (e, next) => {
    noteAgent(e);
    return next(e);
  });
  router.add("tool.call", async (e, next) => {
    if (e.agentId === undefined)
      return next(e);
    agentIds.set(e.tool_use_id, e.agentId);
    try {
      return await next(e);
    } finally {
      agentIds.delete(e.tool_use_id);
    }
  });
  return {
    async agentOf(toolUseId) {
      const agentId = toolUseId === undefined ? undefined : agentIds.get(toolUseId);
      const agentType = agentId === undefined ? mainAgentType : (await claude.agent.list()).find((agent) => agent.id === agentId)?.type;
      return { ...agentId === undefined ? {} : { agentId }, ...agentType === undefined ? {} : { agentType } };
    }
  };
}

// node_modules/@cmodjs/core/runtime/before.js
var appended = [Note, Reply, Notice];
var withNote = (below, note) => {
  const fields = below ?? {};
  return note === undefined ? fields : { ...fields, additionalContext: [...fields["additionalContext"] ?? [], note] };
};
var withContext = (ran, note) => note === undefined || ran.deny !== undefined ? ran : { ...ran, context: [...ran.context ?? [], note] };
var relayTag = /^(?:<cross-session-message[^>]*>\s*)?<cmod-relay>([\s\S]*)<\/cmod-relay>(?:\s*<\/cross-session-message>[\s\S]*)?$/;
function relayOf(e) {
  const isFromCmod = e.origin.kind === "peer" && !("teammate" in e.origin) && e.origin.plugin === cmodPluginName;
  return isFromCmod ? relayTag.exec(e.text)?.[1] : undefined;
}
function installBefore({ claude, router, hooks }) {
  const { place, wants, fold, failedBefore } = hooks;
  const now = () => new Date().toISOString();
  const asked = async (event, change, decide) => await decide(event, change) ?? {};
  const message = (where, unplaced, task, isInTurn = true) => {
    const turn = isInTurn ? task === undefined ? where.turn : where.taskTurns[task] : undefined;
    const context = task === undefined ? where.context : where.tasks[task]?.context ?? where.context;
    const call = unplaced.type === ToolResult ? where.openCalls?.[unplaced.callId] : undefined;
    return { type: Message, message: { ...unplaced, ...call, session: where.session, context, ...turn === undefined ? {} : { turn: turn.prompt.id }, ...task === undefined ? {} : { task } } };
  };
  const submitted = (e) => (where) => message(where, { id: "", at: now(), type: Prompt, text: e.text, from: senderOf(e.origin, false) }, undefined, false);
  const received = (e) => (where) => message(where, { id: "", at: now(), type: Prompt, text: e.text, from: { type: "session" } }, e.agentId, false);
  const refusedOnFailure = (event, change, error, next) => next.called ? undefined : failedBefore(event, change, error)?.refuse;
  const toolCalled = (e, cwd) => (where) => message(where, { id: e.tool_use_id, at: now(), type: ToolCall, callId: e.tool_use_id, name: e.tool, input: toolInputOf(e), cwd, files: noFiles }, e.agentId);
  const cwdOf = async (agentId) => (agentId === undefined ? undefined : agentFolders.get(agentId)) ?? await claude.session.cwd();
  const startedTask = (e, where) => ({ id: "", title: e.description, ...ownerOfSpawn(e.subagentType, where.session), model: e.model ?? e.parentModel, openedBy: e.tool_use_id, openedAt: now(), ...e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }, context: where.context });
  const attachmentOf = (e) => {
    if (e.type === "nested_memory")
      return { event: InstructionFile, found: { id: "", at: now(), type: InstructionFile, path: instructionPathOf(e.text), text: e.text, isRule: isRulePath(instructionPathOf(e.text)) } };
    const attachmentType = attachmentTypeOf(e.type);
    return attachmentType === undefined ? undefined : { event: AttachedFile, found: { id: "", at: now(), type: AttachedFile, path: attachedPathOf(e.text), attachmentType, text: e.text } };
  };
  const contextClosed = (e) => (where) => {
    const task = e.agentId === undefined ? undefined : where.tasks[e.agentId];
    return e.agentId !== undefined && task === undefined ? undefined : { type: ContextEnd, context: closingContext(where, task, now()) };
  };
  const turnEnded = (turn) => turn === undefined ? undefined : { type: TurnEnd2, turn: { ...turn, closedAt: now() } };
  const titles = new Map;
  const spawned = new Map;
  const startedBy = new Map;
  const startingSpawn = (agentId, agentType) => {
    const known = startedBy.get(agentId);
    if (known !== undefined)
      return known;
    const waiting = [...spawned].filter(([call, spawn]) => spawn.agentType === agentType && ![...startedBy.values()].includes(call));
    return waiting.length === 1 ? waiting[0]?.[0] : undefined;
  };
  const agentFolders = new Map;
  const askedAtStop = (change, signal) => new Promise((resolve, reject) => {
    if (signal.aborted)
      return resolve({});
    const cancelled = () => resolve({});
    signal.addEventListener("abort", cancelled, { once: true });
    asked(TurnEnd2, change, fold(signal)).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelled));
  });
  const answeredStop = (below, answer, signal) => {
    if (signal.aborted)
      return below;
    return answer.refuse === undefined ? withNote(below, answer.note) : { ...below, block: answer.refuse };
  };
  const toolResultHook = (isFailure) => async (e, next) => {
    if (!await wants(ToolResult))
      return next(e);
    const where = await place();
    const name = String(e["tool_name"]);
    const callId = String(e["tool_use_id"]);
    const input = typeof e["tool_input"] === "object" && e["tool_input"] !== null ? e["tool_input"] : {};
    const task = typeof e["agent_id"] === "string" ? e["agent_id"] : undefined;
    const result = { id: callId, at: now(), type: ToolResult, callId, name, input, cwd: String(e["cwd"]), files: noFiles, output: isFailure ? e["error"] : e["tool_response"], isError: isFailure };
    const answer = await asked(ToolResult, message(where, result, task), fold(next.signal));
    const below = await next(e);
    const rewritten = answer.output === undefined || isFailure ? {} : name.startsWith("mcp__") ? { updatedMCPToolOutput: answer.output } : { updatedToolOutput: answer.output };
    const failed = answer.isError === true && !isFailure ? { block: answer.note === undefined ? `${name} failed.` : untagged(answer.note) } : {};
    return { ...withNote(below, answer.isError === true ? undefined : answer.note), ...rewritten, ...failed };
  };
  const added = [
    router.add("prompt.submit", async (e, next) => {
      if (!await wants(Prompt))
        return next(e);
      const answer = await asked(Prompt, submitted(e)(await place()), fold(next.signal));
      if (answer.refuse !== undefined)
        return { drop: answer.refuse };
      const text = answer.text ?? e.text;
      if (answer.title !== undefined)
        titles.set(text, answer.title);
      const context = answer.note === undefined ? e.context : [...e.context ?? [], answer.note];
      const ran = await next({ ...e, text, ...context === undefined ? {} : { context } });
      const passed = titles.get(text);
      if (passed !== undefined && (("drop" in ran) || ran.text !== text)) {
        titles.delete(text);
        if (!("drop" in ran) && typeof ran.text === "string")
          titles.set(ran.text, passed);
      }
      return ran;
    }, (e, error, next) => {
      const refusal = refusedOnFailure(Prompt, submitted(e), error, next);
      return refusal === undefined ? undefined : { drop: refusal };
    }),
    router.add("classic.UserPromptSubmit", async (e, next) => {
      const named = titles.get(e.prompt);
      titles.delete(e.prompt);
      const below = await next(e);
      return named === undefined ? below : { ...below, sessionTitle: named };
    }),
    router.add("classic.PostToolUse", toolResultHook(false)),
    router.add("classic.PostToolUseFailure", toolResultHook(true)),
    router.add("session.receive", async (e, next) => {
      if (!await wants(Prompt) || relayOf(e) !== undefined)
        return next(e);
      const answer = await asked(Prompt, received(e)(await place()), fold(next.signal));
      if (answer.refuse !== undefined)
        return { consumed: answer.refuse };
      return next(answer.text === undefined ? e : { ...e, text: answer.text });
    }, (e, error, next) => {
      const refusal = relayOf(e) === undefined ? refusedOnFailure(Prompt, received(e), error, next) : undefined;
      return refusal === undefined ? undefined : { consumed: refusal };
    }),
    router.add("skill.prompt", async (e, next) => {
      if (!await wants(Skill))
        return next(e);
      const where = await place();
      const answer = await asked(Skill, message(where, { id: "", at: now(), type: Skill, name: e.skill, text: e.text }, undefined), fold(next.signal));
      return answer.text === undefined ? next(e) : { text: answer.text };
    }),
    router.add("prompt.attachment", async (e, next) => {
      const attachment = attachmentOf(e);
      if (attachment === undefined || !await wants(attachment.event))
        return next(e);
      const answer = await asked(attachment.event, message(await place(), attachment.found, e.agentId), fold(next.signal));
      if (answer.refuse !== undefined)
        return { text: null };
      return answer.text === undefined ? next(e) : { text: answer.text };
    }, (e, error, next) => {
      const attachment = attachmentOf(e);
      const refusal = attachment === undefined ? undefined : refusedOnFailure(attachment.event, (where) => message(where, attachment.found, e.agentId), error, next);
      return refusal === undefined ? undefined : { text: null };
    }),
    router.add("session.append", async (e, next) => {
      const wanted = new Set((await Promise.all(appended.map(async (event) => await wants(event) ? [event] : []))).flat());
      if (wanted.size === 0)
        return next(e);
      const row = rowOfAppend({ uuid: e.uuid, door: e.door, origin: e.origin, message: e.message }, now(), "");
      const found = messagesOf(row, e.agentId !== undefined);
      if (!found.some((each) => wanted.has(each.type)))
        return next(e);
      const where = await place();
      const texts = new Map;
      const decide = fold(next.signal);
      for (const [part, unplaced] of found.entries()) {
        if (!wanted.has(unplaced.type))
          continue;
        const answer = await asked(unplaced.type, message(where, unplaced, e.agentId), decide);
        if (answer.text !== undefined)
          texts.set(part, answer.text);
      }
      return next(texts.size === 0 ? e : { ...e, message: { ...e.message, content: withTexts(row, texts) } });
    }),
    router.add("tool.call", async (e, next) => {
      if (!await wants(ToolCall))
        return next(e);
      const where = await place();
      const answer = await asked(ToolCall, toolCalled(e, await cwdOf(e.agentId))(where), fold(next.signal));
      if (answer.refuse !== undefined)
        return { deny: answer.refuse };
      if (answer.result !== undefined)
        return withContext({ result: answer.result }, answer.note);
      if (answer.input === undefined)
        return withContext(await next(e), answer.note);
      const input = toolInputOf(e);
      const reserved = Object.fromEntries(Object.entries(e).filter(([key]) => !(key in input)));
      return withContext(await next({ ...reserved, ...answer.input }), answer.note);
    }, async (e, error, next) => {
      const refusal = refusedOnFailure(ToolCall, toolCalled(e, await cwdOf(e.agentId)), error, next);
      return refusal === undefined ? undefined : { deny: refusal };
    }),
    router.add("agent.spawn", async (e, next) => {
      spawned.set(e.tool_use_id, { prompt: e.prompt, agentType: e.subagentType });
      const start = async (args) => {
        const started = await next(args);
        if (started.agentId === undefined)
          spawned.delete(e.tool_use_id);
        else if (spawned.has(e.tool_use_id))
          startedBy.set(started.agentId, e.tool_use_id);
        const folder = args.isTeammate === true ? undefined : args.cwd ?? (args.parentAgentId === undefined ? undefined : agentFolders.get(args.parentAgentId));
        if (started.agentId !== undefined && folder !== undefined)
          agentFolders.set(started.agentId, ve(await claude.session.cwd(), folder));
        return started;
      };
      if (!await wants(TaskStart))
        return start(e);
      const task = startedTask(e, await place());
      const answer = await asked(TaskStart, { type: TaskStart, task }, fold(next.signal));
      if (answer.refuse !== undefined) {
        spawned.delete(e.tool_use_id);
        return { deny: answer.refuse };
      }
      if (e.workflow !== undefined)
        return start(e);
      const isFork = task.forkedFrom !== undefined;
      const { agentType, model, cwd } = (isFork ? undefined : answer.owner) ?? {};
      const isAsync = isFork ? undefined : answer.isAsync;
      const answered = {
        ...e,
        ...answer.prompt === undefined ? {} : { prompt: answer.prompt },
        ...answer.title === undefined ? {} : { description: answer.title },
        ...agentType === undefined ? {} : { subagentType: agentType },
        ...model === undefined ? {} : { model },
        ...cwd === undefined ? {} : { cwd },
        ...isAsync === undefined ? {} : { background: isAsync }
      };
      spawned.set(e.tool_use_id, { prompt: answered.prompt, agentType: answered.subagentType });
      return start(answered);
    }, (e, error, next) => {
      const refusal = refusedOnFailure(TaskStart, (where) => ({ type: TaskStart, task: startedTask(e, where) }), error, next);
      if (refusal === undefined)
        return;
      spawned.delete(e.tool_use_id);
      return { deny: refusal };
    }),
    router.add("classic.SubagentStart", async (e, next) => {
      const where = await place();
      const openedBy = where.tasks[e.agent_id]?.openedBy ?? startingSpawn(e.agent_id, e.agent_type);
      const prompt = openedBy === undefined ? undefined : spawned.get(openedBy)?.prompt;
      if (openedBy !== undefined)
        spawned.delete(openedBy);
      startedBy.delete(e.agent_id);
      if (!await wants(Prompt))
        return next(e);
      const open = where.taskTurns[e.agent_id]?.prompt;
      const text = open?.text ?? prompt;
      if (text === undefined)
        return next(e);
      const answer = await asked(Prompt, message(where, { id: open?.id ?? "", at: now(), type: Prompt, text, from: open?.from ?? { type: Task } }, e.agent_id, false), fold(next.signal));
      return withNote(await next(e), answer.note);
    }),
    router.add("classic.SubagentStop", async (e, next) => {
      const stopped = (answer) => {
        if (answer.block === undefined)
          agentFolders.delete(e.agent_id);
        return answer;
      };
      if (next.signal.aborted || !await wants(TurnEnd2))
        return stopped(await next(e));
      const change = turnEnded((await place()).taskTurns[e.agent_id]);
      if (change === undefined)
        return stopped(await next(e));
      const answer = await askedAtStop(change, next.signal);
      return stopped(answeredStop(await next(e), answer, next.signal));
    }, async (e, error, next) => {
      const refusal = refusedOnFailure(TurnEnd2, (where) => turnEnded(where.taskTurns[e.agent_id]), error, next);
      return refusal === undefined ? undefined : { ...await next(e), block: refusal };
    }),
    router.add("classic.Stop", async (e, next) => {
      if (next.signal.aborted || !await wants(TurnEnd2))
        return next(e);
      const change = turnEnded((await place()).turn);
      if (change === undefined)
        return next(e);
      const answer = await askedAtStop(change, next.signal);
      return answeredStop(await next(e), answer, next.signal);
    }, async (e, error, next) => {
      const refusal = refusedOnFailure(TurnEnd2, (where) => turnEnded(where.turn), error, next);
      return refusal === undefined ? undefined : { ...await next(e), block: refusal };
    }),
    router.add("session.compact", async (e, next) => {
      if (!await wants(ContextEnd) || e.trigger === "precompute")
        return next(e);
      const change = contextClosed(e)(await place());
      if (change === undefined)
        return next(e);
      const answer = await asked(ContextEnd, change, fold(next.signal));
      if (answer.refuse !== undefined)
        return { skip: answer.refuse };
      return answer.summary === undefined ? next(e) : { messages: [{ role: "user", text: answer.summary, toolUses: [] }] };
    }, (e, error, next) => {
      const refusal = e.trigger === "precompute" ? undefined : refusedOnFailure(ContextEnd, contextClosed(e), error, next);
      return refusal === undefined ? undefined : { skip: refusal };
    })
  ];
  return { remove: () => added.forEach((each) => each.remove()) };
}
function closingContext(where, task, closedAt) {
  return task === undefined ? { number: where.context, openedAt: where.contextOpenedAt, closedAt } : { number: task.context, openedAt: task.contextOpenedAt ?? task.openedAt, closedAt, task: task.id };
}
function withAnswer(change, answer) {
  if (change.type === Message && answer.output !== undefined && change.message.type === ToolResult)
    return { ...change, message: { ...change.message, output: answer.output } };
  if (change.type === Message && answer.text !== undefined)
    return { ...change, message: { ...change.message, text: answer.text } };
  if (change.type === Message && answer.input !== undefined && change.message.type === ToolCall)
    return { ...change, message: { ...change.message, input: answer.input } };
  if (change.type === TaskStart) {
    const { agentType, model } = answer.owner ?? {};
    return { ...change, task: { ...change.task, ...answer.title === undefined ? {} : { title: answer.title }, ...agentType === undefined ? {} : { agentType }, ...model === undefined ? {} : { model } } };
  }
  return change;
}
var methodOf = (prefix, event) => `${prefix}${Object.entries(sessionEvents).find(([, each]) => each === event)?.[0] ?? event}`;
var beforeAnswerKeys = {
  prompt: ["text", "note", "title", "refuse"],
  note: ["text"],
  skill: ["text"],
  instructionFile: ["text", "refuse"],
  attachedFile: ["text", "refuse"],
  reply: ["text"],
  toolCall: ["input", "result", "refuse", "note"],
  toolResult: ["output", "isError", "note"],
  notice: ["text"],
  taskStart: ["prompt", "title", "owner", "isAsync", "refuse"],
  turnEnd: ["refuse", "note"],
  contextEnd: ["refuse", "summary"]
};
function foldBefore(event, change, askers, report) {
  return foldAnswers(methodOf("before", event), beforeAnswerKeys[event], ["refuse", "result"], change, askers, report, withAnswer);
}
function takenAnswer(method, takes, answer) {
  if (answer === undefined || answer === null || answer === false)
    return;
  if (typeof answer !== "object" || Array.isArray(answer))
    throw new Error(`it answered ${JSON.stringify(answer)}, but ${method} takes an object or nothing: ${takes.map((key) => `{ ${key} }`).join(", ") || "no answer"}.`);
  const unread = Object.keys(answer).filter((key) => !takes.includes(key));
  if (unread.length > 0)
    throw new Error(`it answered ${unread.join(" and ")}, which ${method} does not take. It takes ${takes.map((key) => `{ ${key} }`).join(", ") || "no answer"}.`);
  return answer;
}
async function foldAnswers(method, takes, ends, change, askers, report, applied = (same) => same) {
  let latest = change;
  let result;
  for (const ask of askers) {
    try {
      const answer = takenAnswer(method, takes, await ask(latest));
      if (typeof answer !== "object" || answer === null)
        continue;
      const given = answer;
      const notes = [result?.["note"], given["note"]].filter((note) => typeof note === "string");
      result = { ...result, ...given, ...notes.length === 0 ? {} : { note: notes.join(`

`) } };
      if (ends.some((key) => given[key] !== undefined))
        return result;
      latest = applied(latest, answer);
    } catch (error) {
      report(error);
    }
  }
  return result;
}

// node_modules/@cmodjs/core/runtime/programs.js
function lastLineOf(text) {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed.slice(trimmed.lastIndexOf(`
`) + 1).trim();
}
function cmodError(stderr, command) {
  const line = lastLineOf(stderr) ?? "";
  const prefix = `cmod ${command}: `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}
async function readLines(stream, onLine) {
  let pending = "";
  let lastError = "";
  let piece = await stream.next();
  while (piece.done !== true) {
    if (piece.value.stream === "stderr") {
      lastError = lastLineOf(piece.value.text) ?? lastError;
    } else {
      const lines = `${pending}${piece.value.text}`.split(`
`);
      pending = lines.pop() ?? "";
      for (const text of lines)
        onLine(text);
    }
    piece = await stream.next();
  }
  if (pending !== "")
    onLine(pending);
  return { code: piece.value.code, lastError };
}
function spawnCmod(claude, args, session, env = {}) {
  return claude.process.spawn({ argv: ["cmod", ...args], env: { ...env, CLAUDE_CODE_SESSION_ID: session } });
}
async function isHeld(claude, lock, staleMs) {
  const now = await claude.clock.now();
  const holders = await claude.fs.list(lock).catch(ifMissing([]));
  const touched = await Promise.all(holders.map(async ({ name }) => (await claude.fs.stat(`${lock}/${name}`).catch(ifMissing(undefined)))?.mtimeMs ?? 0));
  return touched.some((at) => now - at < staleMs);
}
async function newestCmodVersion(claude) {
  const store = storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() });
  return readCmodVersion({
    list: async (folder) => (await claude.fs.list(folder).catch(ifMissing([]))).map((entry) => entry.name),
    exists: async (path) => await claude.fs.stat(path).catch(ifMissing(undefined)) !== undefined
  }, store);
}
async function runCmod(claude, args, session) {
  const lines = [];
  const { code, lastError } = await readLines(spawnCmod(claude, args, session), (line) => void lines.push(line));
  if (code !== 0)
    throw new Error(cmodError(lastError, args[0]) || `cmod ${args.slice(0, 2).join(" ")} ${formatExit(code, "")}.`);
  return lines.join(`
`);
}
function locatingPrograms(claude) {
  let folder;
  let names = new Set;
  const located = (argv) => {
    const [name, ...rest] = argv;
    return folder !== undefined && name !== undefined && (name === "cmod" || names.has(name)) ? [`${folder}/${name}`, ...rest] : argv;
  };
  return {
    claude: {
      ...claude,
      process: {
        run: (argv, init) => claude.process.run(located(argv), init),
        spawn: (request) => claude.process.spawn({ ...request, argv: located(request.argv) })
      }
    },
    async refresh() {
      const [home, dataHome] = await Promise.all([claude.env.home(), claude.env.dataHome()]);
      const programs = `${storeFolder({ HOME: home, XDG_DATA_HOME: dataHome })}/programs`;
      names = new Set((await claude.fs.list(programs).catch(ifMissing([]))).map((entry) => entry.name));
      folder = programs;
    }
  };
}

// node_modules/@cmodjs/core/utils/parse-shell.js
var markerPattern = /\u0001(\d+)\u0001/g;
var descriptorPattern = /[0-9]+(?=[<>])/y;
var assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
var dynamicPattern = /[$`]/;
var homePrefix2 = /^\$HOME(?=\/|$)/;
var clusterPattern = /^-[A-Za-z0-9]{2,}$/;
var separators = ";&|()<>";
var redirectOperators = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<", "<>", "<&", "<<<"]);
var writeRedirects = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
var sequenceOperators = new Set([";", "&", "&&", "||", "|", "|&"]);
var casePatternStarts = new Set([";;", ";&", ";;&"]);
var reservedWords = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "{", "}", "!"]);
var shells = new Set(["sh", "bash", "zsh"]);
var findActions = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
var gitValuedOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
var nonGetoptPrograms = new Set([
  "find",
  "java",
  "javac",
  "go",
  "gcc",
  "g++",
  "clang",
  "clang++",
  "swift",
  "swiftc",
  "xcodebuild",
  "xcrun",
  "ffmpeg",
  "ffprobe",
  "openssl",
  "plutil",
  "defaults",
  "security",
  "codesign"
]);
var grep = {
  valued: "efmABCdD",
  longValued: ["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--directories", "--devices", "--binary-files", "--label", "--include", "--exclude", "--exclude-dir", "--exclude-from"],
  scriptOptions: ["-e", "-f", "--regexp", "--file"]
};
var awk = {
  valued: "fFvi",
  longValued: ["--file", "--field-separator", "--assign", "--include", "--source"],
  scriptOptions: ["-f", "--file", "--source"],
  takesAssignments: true,
  inPlaceOptions: ["-i", "--include"]
};
var sed = {
  valued: "efl",
  optional: "iI",
  longValued: ["--expression", "--file", "--line-length"],
  scriptOptions: ["-e", "-f", "--expression", "--file"],
  inPlaceOptions: ["-i", "-I", "--in-place"]
};
var perl = {
  valued: "eEIMmF",
  optional: "ixdDC",
  scriptOptions: ["-e", "-E"],
  inPlaceOptions: ["-i"]
};
var fileWriters = new Map([
  ["tee", {}],
  ["rm", {}],
  ["touch", { valued: "drt", longValued: ["--date", "--reference", "--time"] }],
  ["truncate", { valued: "sr", longValued: ["--size", "--reference"] }]
]);
var copyTarget = { valued: "tS", longValued: ["--target-directory", "--suffix"], targetOptions: ["-t", "--target-directory"] };
var copyPrograms = new Map([
  ["cp", { ...copyTarget, sources: "reads" }],
  ["mv", { ...copyTarget, sources: "writes" }],
  ["ln", { ...copyTarget, sources: undefined, linksHere: true }],
  ["rsync", {
    valued: "efBTM",
    longValued: [
      "--rsh",
      "--rsync-path",
      "--filter",
      "--exclude",
      "--include",
      "--exclude-from",
      "--include-from",
      "--files-from",
      "--temp-dir",
      "--compare-dest",
      "--copy-dest",
      "--link-dest",
      "--backup-dir",
      "--suffix",
      "--chmod",
      "--chown",
      "--usermap",
      "--groupmap",
      "--timeout",
      "--contimeout",
      "--bwlimit",
      "--log-file",
      "--log-file-format",
      "--out-format",
      "--password-file",
      "--port",
      "--sockopts",
      "--max-size",
      "--min-size",
      "--max-delete",
      "--partial-dir",
      "--block-size",
      "--modify-window",
      "--iconv",
      "--checksum-choice",
      "--compress-choice",
      "--compress-level",
      "--remote-option",
      "--info",
      "--debug",
      "--address",
      "--write-batch",
      "--only-write-batch",
      "--read-batch",
      "--protocol",
      "--skip-compress"
    ],
    sources: "reads",
    skipsRemote: true
  }]
]);
var fetchers = new Map([
  ["curl", {
    valued: "AbcCdDeEFHKmoPQrTtuUwxXyYz",
    longValued: [
      "--url",
      "--data",
      "--data-raw",
      "--data-binary",
      "--data-urlencode",
      "--data-ascii",
      "--json",
      "--form",
      "--form-string",
      "--header",
      "--proxy-header",
      "--user",
      "--user-agent",
      "--referer",
      "--output",
      "--output-dir",
      "--cookie",
      "--cookie-jar",
      "--request",
      "--proxy",
      "--proxy-user",
      "--preproxy",
      "--noproxy",
      "--max-time",
      "--connect-timeout",
      "--retry",
      "--retry-delay",
      "--retry-max-time",
      "--range",
      "--continue-at",
      "--upload-file",
      "--write-out",
      "--cert",
      "--cert-type",
      "--key",
      "--key-type",
      "--cacert",
      "--capath",
      "--ciphers",
      "--config",
      "--dump-header",
      "--interface",
      "--limit-rate",
      "--max-filesize",
      "--max-redirs",
      "--resolve",
      "--connect-to",
      "--oauth2-bearer",
      "--aws-sigv4",
      "--unix-socket",
      "--abstract-unix-socket",
      "--variable",
      "--url-query",
      "--trace",
      "--trace-ascii",
      "--stderr",
      "--keepalive-time",
      "--local-port",
      "--dns-servers",
      "--doh-url",
      "--quote",
      "--telnet-option",
      "--time-cond",
      "--speed-limit",
      "--speed-time",
      "--etag-save",
      "--etag-compare",
      "--hsts",
      "--alt-svc",
      "--mail-from",
      "--mail-rcpt",
      "--mail-auth",
      "--pass",
      "--proto",
      "--proto-redir",
      "--pubkey",
      "--socks4",
      "--socks4a",
      "--socks5",
      "--socks5-hostname"
    ]
  }],
  ["wget", {
    valued: "aoeiBtOTwQPlARDIXU",
    longValued: [
      "--output-file",
      "--append-output",
      "--execute",
      "--input-file",
      "--base",
      "--tries",
      "--output-document",
      "--timeout",
      "--dns-timeout",
      "--connect-timeout",
      "--read-timeout",
      "--wait",
      "--waitretry",
      "--quota",
      "--limit-rate",
      "--directory-prefix",
      "--level",
      "--accept",
      "--reject",
      "--domains",
      "--exclude-domains",
      "--include-directories",
      "--exclude-directories",
      "--user-agent",
      "--header",
      "--user",
      "--password",
      "--http-user",
      "--http-password",
      "--post-data",
      "--post-file",
      "--body-data",
      "--body-file",
      "--method",
      "--referer",
      "--load-cookies",
      "--save-cookies",
      "--certificate",
      "--private-key",
      "--ca-certificate",
      "--ca-directory",
      "--bind-address",
      "--cut-dirs",
      "--default-page",
      "--restrict-file-names",
      "--local-encoding",
      "--remote-encoding"
    ]
  }]
]);
var su = { valued: "cgGsw", longValued: ["--command", "--session-command", "--group", "--supp-group", "--shell", "--whitelist-environment"] };
var suCodeOptions = ["-c", "--command", "--session-command"];
var fileReaders = new Map([
  ["cat", {}],
  ["head", { valued: "nc", longValued: ["--lines", "--bytes"] }],
  ["tail", { valued: "ncbs", longValued: ["--lines", "--bytes", "--pid", "--sleep-interval", "--max-unchanged-stats"] }],
  ["less", { valued: "bhjkoOpPtTxyz" }],
  ["grep", grep],
  ["egrep", grep],
  ["fgrep", grep],
  ["rg", {
    valued: "efgtTmABCjMrEd",
    longValued: ["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--max-count", "--after-context", "--before-context", "--context", "--threads", "--max-columns", "--replace", "--encoding", "--max-depth", "--max-filesize", "--sort", "--sortr", "--pre", "--pre-glob", "--engine", "--ignore-file", "--path-separator", "--context-separator", "--field-match-separator", "--field-context-separator"],
    scriptOptions: ["-e", "-f", "--regexp", "--file"]
  }],
  ["awk", awk],
  ["gawk", awk],
  ["sed", sed],
  ["gsed", sed]
]);
var wrappers = new Map([
  ["sudo", {
    valued: "CDghpRrTtUu",
    longValued: ["--close-from", "--chdir", "--group", "--host", "--prompt", "--chroot", "--role", "--type", "--command-timeout", "--other-user", "--user"],
    stops: ["-e", "--edit", "-l", "--list", "-v", "--validate", "-V", "--version", "-K", "--remove-timestamp"],
    folderOptions: ["-D", "--chdir"],
    takesAssignments: true
  }],
  ["env", {
    valued: "aCPSu",
    longValued: ["--argv0", "--chdir", "--split-string", "--unset"],
    folderOptions: ["-C", "--chdir"],
    codeOptions: ["-S", "--split-string"],
    takesAssignments: true
  }],
  ["doas", { valued: "aCu", stops: ["-C", "-L"] }],
  ["timeout", { valued: "ks", longValued: ["--kill-after", "--signal"], leadingOperands: 1 }],
  ["flock", { valued: "wEc", longValued: ["--timeout", "--wait", "--conflict-exit-code", "--command"], codeOptions: ["-c", "--command"], leadingOperands: 1 }],
  ["stdbuf", { valued: "ioe", longValued: ["--input", "--output", "--error"] }],
  ["watch", { valued: "nq", optional: "d", longValued: ["--interval", "--equexit"], shellUnless: ["-x", "--exec"] }],
  ["nohup", {}],
  ["nice", { valued: "n", longValued: ["--adjustment"] }],
  ["time", { valued: "fo", longValued: ["--format", "--output"] }],
  ["exec", { valued: "a" }],
  ["command", { stops: ["-v", "-V"] }],
  ["xargs", {
    valued: "aEdILnPs",
    optional: "eil",
    longValued: ["--arg-file", "--delimiter", "--max-args", "--max-chars", "--max-procs", "--process-slot-var"]
  }]
]);
var inlineCodeFlags = new Map([
  ["python", ["-c"]],
  ["python2", ["-c"]],
  ["python3", ["-c"]],
  ["node", ["-e", "--eval", "-p", "--print"]],
  ["bun", ["-e", "--eval", "-p", "--print"]],
  ["deno", ["eval"]],
  ["ruby", ["-e"]],
  ["perl", ["-e", "-E"]],
  ["php", ["-r"]],
  ["lua", ["-e"]],
  ["osascript", ["-e"]]
]);
function parseShell(line) {
  const result = { commands: [], writes: [], reads: [], fetches: [], isFullyParsed: true };
  parseLine(line, "", result);
  return result;
}
function parseLine(line, folder, result) {
  if (line.includes("\x01")) {
    result.isFullyParsed = false;
    return;
  }
  try {
    const { text, markers } = scan(line, 0, false);
    walk(Dt(text, (name) => name === "" ? undefined : `$${name}`), markers, folder, result);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message.startsWith("Bad substitution: ")))
      throw error;
    result.isFullyParsed = false;
  }
}
function scan(source, start, isNested) {
  const markers = [];
  const heredocs = [];
  const mark = (marker) => `\x01${markers.push(marker) - 1}\x01`;
  let text = "";
  let depth = 0;
  let cases = 0;
  let index = start;
  let isWordStart = true;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === `
`) {
      text += " ; ";
      index = readHeredocBodies(source, index + 1, heredocs.splice(0));
      isWordStart = true;
      continue;
    }
    if (char === " " || char === "\t") {
      text += char;
      index += 1;
      isWordStart = true;
      continue;
    }
    if (char === "#") {
      if (isWordStart)
        index = lineEnd(source, index);
      else {
        text += "\\#";
        index += 1;
      }
      continue;
    }
    if (char === "\\") {
      if (next === "")
        throw new SyntaxError("The line ends with a backslash.");
      if (next !== `
`) {
        text += char + next;
        isWordStart = false;
      }
      index += 2;
      continue;
    }
    if (char === "'" || char === "$" && next === "'") {
      const close = closingQuote(source, index + (char === "$" ? 2 : 1), "'", char === "$");
      text += source.slice(index, close + 1);
      index = close + 1;
      isWordStart = false;
      continue;
    }
    if (char === '"') {
      const quoted = readDoubleQuoted(source, index, mark);
      text += quoted.text;
      index = quoted.end;
      isWordStart = false;
      continue;
    }
    const expansion = expansionAt(source, index);
    if (expansion !== undefined) {
      text += mark(expansion);
      index = expansion.end;
      isWordStart = false;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      const close = scan(source, index + 2, true).end;
      text += mark({ raw: source.slice(index, close + 1), code: [source.slice(index + 2, close)] });
      index = close + 1;
      isWordStart = false;
      continue;
    }
    if (char === "(" && next === "(" && isWordStart) {
      const end = arithmeticEnd(source, index + 2);
      if (end !== undefined) {
        if (substitutionsIn(source.slice(index + 2, end - 2)).length > 0)
          throw new SyntaxError("An arithmetic command runs a substitution.");
        index = end;
        continue;
      }
    }
    if (source.startsWith("<<<", index)) {
      text += "<<<";
      index += 3;
      isWordStart = true;
      continue;
    }
    if (char === "<" && next === "<") {
      const heredoc = readHeredocOperator(source, index);
      heredocs.push(heredoc);
      text += ` <<< ${mark(heredoc.marker)} `;
      index = heredoc.end;
      isWordStart = true;
      continue;
    }
    if (isWordStart) {
      descriptorPattern.lastIndex = index;
      const descriptor = descriptorPattern.exec(source);
      if (descriptor !== null) {
        index += descriptor[0].length;
        continue;
      }
      if (startsWord(source, index, "case"))
        cases += 1;
      if (startsWord(source, index, "esac") && cases > 0)
        cases -= 1;
    }
    if (char === "(")
      depth += 1;
    if (char === ")") {
      if (depth > 0)
        depth -= 1;
      else if (cases === 0) {
        if (!isNested)
          throw new SyntaxError("The line closes a parenthesis it never opened.");
        if (heredocs.length > 0)
          throw new SyntaxError("A heredoc inside a substitution has no body.");
        return { text, markers, end: index };
      }
    }
    text += char;
    index += 1;
    isWordStart = separators.includes(char);
  }
  if (isNested)
    throw new SyntaxError("A substitution is never closed.");
  if (depth > 0)
    throw new SyntaxError("A parenthesis is never closed.");
  if (heredocs.length > 0)
    throw new SyntaxError("A heredoc has no body.");
  return { text, markers, end: index };
}
function readDoubleQuoted(source, start, mark) {
  let text = '"';
  let index = start + 1;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === '"')
      return { text: `${text}"`, end: index + 1 };
    if (char === "\\") {
      if (source.charAt(index + 1) !== `
`)
        text += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    const expansion = expansionAt(source, index);
    if (expansion !== undefined) {
      text += mark(expansion);
      index = expansion.end;
      continue;
    }
    text += char;
    index += 1;
  }
  throw new SyntaxError("A double quote is never closed.");
}
function expansionAt(source, index) {
  if (source.startsWith("$((", index)) {
    const end = arithmeticEnd(source, index + 3);
    if (end !== undefined)
      return { raw: source.slice(index, end), code: substitutionsIn(source.slice(index + 3, end - 2)), end };
  }
  if (source.startsWith("$(", index)) {
    const close = scan(source, index + 2, true).end;
    return { raw: source.slice(index, close + 1), code: [source.slice(index + 2, close)], end: close + 1 };
  }
  if (source.charAt(index) === "`") {
    const close = closingQuote(source, index + 1, "`", true);
    return { raw: source.slice(index, close + 1), code: [source.slice(index + 1, close).replace(/\\([\\`$])/g, "$1")], end: close + 1 };
  }
  return;
}
function substitutionsIn(text) {
  const code = [];
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) === "\\") {
      index += 2;
      continue;
    }
    const expansion = expansionAt(text, index);
    if (expansion === undefined)
      index += 1;
    else {
      code.push(...expansion.code);
      index = expansion.end;
    }
  }
  return code;
}
function arithmeticEnd(source, from) {
  let depth = 0;
  for (let index = from;index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === "(")
      depth += 1;
    if (char !== ")")
      continue;
    if (depth > 0)
      depth -= 1;
    else
      return source.charAt(index + 1) === ")" ? index + 2 : undefined;
  }
  throw new SyntaxError("An arithmetic expansion is never closed.");
}
function closingQuote(source, from, quote, isEscapable) {
  for (let index = from;index < source.length; index += 1) {
    const char = source.charAt(index);
    if (isEscapable && char === "\\")
      index += 1;
    else if (char === quote)
      return index;
  }
  throw new SyntaxError(`A ${quote} quote is never closed.`);
}
function lineEnd(source, index) {
  const end = source.indexOf(`
`, index);
  return end < 0 ? source.length : end;
}
function startsWord(source, index, word) {
  return source.startsWith(word, index) && /^$|[\s;&|()<>]/.test(source.charAt(index + word.length));
}
function readHeredocOperator(source, index) {
  let end = index + 2;
  const stripsTabs = source.charAt(end) === "-";
  if (stripsTabs)
    end += 1;
  while (source.charAt(end) === " " || source.charAt(end) === "\t")
    end += 1;
  let delimiter = "";
  let isQuoted = false;
  while (end < source.length && !/[\s;&|()<>]/.test(source.charAt(end))) {
    const char = source.charAt(end);
    if (char === "'" || char === '"') {
      const close = closingQuote(source, end + 1, char, char === '"');
      delimiter += source.slice(end + 1, close);
      isQuoted = true;
      end = close + 1;
    } else if (char === "\\") {
      delimiter += source.charAt(end + 1);
      isQuoted = true;
      end += 2;
    } else {
      delimiter += char;
      end += 1;
    }
  }
  if (delimiter === "")
    throw new SyntaxError("A heredoc has no delimiter.");
  return { delimiter, stripsTabs, isQuoted, marker: { raw: "", code: [] }, end };
}
function readHeredocBodies(source, from, heredocs) {
  let index = from;
  for (const heredoc of heredocs) {
    const lines = [];
    for (;; ) {
      if (index >= source.length)
        throw new SyntaxError(`The heredoc ${heredoc.delimiter} never ends.`);
      const end = lineEnd(source, index);
      const line = heredoc.stripsTabs ? source.slice(index, end).replace(/^\t+/, "") : source.slice(index, end);
      index = end + 1;
      if (line === heredoc.delimiter)
        break;
      lines.push(line);
    }
    heredoc.marker.raw = lines.join(`
`);
    heredoc.marker.code = heredoc.isQuoted ? [] : substitutionsIn(heredoc.marker.raw);
  }
  return index;
}
function walk(tokens, markers, start, result) {
  let folder = start;
  const subshells = [];
  let command = newCommand(undefined);
  let caseState;
  for (let index = 0;index < tokens.length; index += 1) {
    const token = tokens[index];
    if (typeof token !== "string" && "comment" in token)
      throw new SyntaxError("The line holds a comment the scanner left.");
    if (isWordToken(token)) {
      const word = wordOf(token, markers, folder, result);
      if (caseState === "header") {
        if (word.text === "in")
          caseState = "pattern";
      } else if (caseState === "pattern") {
        if (word.text === "esac")
          caseState = undefined;
      } else if (word.text === "case" && command.words.every((earlier) => reservedWords.has(earlier.text))) {
        caseState = "header";
      } else
        command.words.push(word);
      continue;
    }
    const operator = token.op;
    if (redirectOperators.has(operator)) {
      const target = tokens[index + 1];
      if (target === undefined || !isWordToken(target))
        throw new SyntaxError(`The redirection ${operator} has no target.`);
      index += 1;
      command.redirects.push({ operator, target: wordOf(target, markers, folder, result) });
      continue;
    }
    if (caseState !== undefined) {
      if (caseState === "pattern" && operator === ")")
        caseState = undefined;
      continue;
    }
    const following = tokens[index + 1];
    if (operator === "(" && command.words.length === 1 && following !== undefined && !isWordToken(following) && "op" in following && following.op === ")") {
      command = newCommand(undefined);
      index += 1;
      continue;
    }
    const before = result.commands.length;
    folder = finish(command, operator, folder, result);
    const writer = result.commands.length > before ? result.commands.length - 1 : undefined;
    command = newCommand(operator === "|" || operator === "|&" ? { writer } : undefined);
    if (operator === "(")
      subshells.push(folder);
    else if (operator === ")") {
      const outer = subshells.pop();
      if (outer === undefined)
        throw new SyntaxError("The line closes a subshell it never opened.");
      folder = outer;
    } else if (casePatternStarts.has(operator))
      caseState = "pattern";
    else if (!sequenceOperators.has(operator))
      throw new SyntaxError(`The parser does not know the operator ${operator}.`);
  }
  finish(command, ";", folder, result);
}
function newCommand(pipe) {
  return { words: [], redirects: [], pipe };
}
function isWordToken(token) {
  return typeof token === "string" || "op" in token && token.op === "glob";
}
function wordOf(token, markers, folder, result) {
  const raw = typeof token === "string" ? token : token.pattern;
  for (const match of raw.matchAll(markerPattern)) {
    for (const code of markers[Number(match[1])].code)
      parseLine(code, folder, result);
  }
  return {
    text: raw.replace(markerPattern, (_, index) => markers[Number(index)].raw),
    isGlob: typeof token !== "string",
    isDynamic: /[$\u0001]/.test(ft(raw))
  };
}
function finish(command, operator, folder, result) {
  for (const redirect of command.redirects)
    addRedirect(redirect, folder, result);
  const words = withoutPrefixes(command.words);
  const [first, ...args] = words;
  if (first === undefined || first.text === "for" || first.text === "select")
    return folder;
  const here = command.redirects.findLast((redirect) => redirect.operator === "<<<");
  const stdin = here !== undefined ? { type: "text", text: here.target.text } : command.pipe !== undefined ? { type: "pipe" } : undefined;
  const reader = result.commands.length;
  const changed = addCommand(first, args, folder, stdin, result);
  const read = result.commands[reader];
  const writer = command.pipe?.writer;
  if (read !== undefined && writer !== undefined && here === undefined)
    result.commands[reader] = { ...read, input: writer };
  const isPiped = command.pipe !== undefined || operator === "|" || operator === "|&" || operator === "&";
  return changed === undefined || isPiped ? folder : changed;
}
function withoutPrefixes(words) {
  let start = 0;
  for (;; ) {
    const text = words[start]?.text;
    if (text === undefined)
      break;
    if (text === "function")
      start += 2;
    else if (reservedWords.has(text) || assignmentPattern.test(text))
      start += 1;
    else
      break;
  }
  return words.slice(start);
}
function addRedirect({ operator, target }, folder, result) {
  if (operator === "<" || operator === "<>")
    addPath(result, "reads", target, folder);
  if (writeRedirects.has(operator) || operator === ">&" && !/^([0-9]+|-)$/.test(target.text))
    addPath(result, "writes", target, folder);
}
function addCommand(first, args, folder, stdin, result) {
  if (first.isDynamic || first.isGlob)
    result.isFullyParsed = false;
  const program = ft(first.text);
  if (program === "git")
    addGit(first, args, folder, result);
  else if (program === "find")
    addFind(first, args, folder, result);
  else if (wrappers.has(program))
    addWrapper(first, program, args, folder, stdin, result);
  else {
    const flags = expandFlags(program, args);
    result.commands.push({ argv: [first.text, ...flags], folder });
    addEffects(program, args, flags, folder, stdin, result);
    if (program === "cd")
      return changedFolder(args, folder);
  }
  return;
}
function addGit(first, args, folder, result) {
  let index = 0;
  let gitFolder = folder;
  for (let text = args[0]?.text;text?.startsWith("-") === true; text = args[index]?.text) {
    if (text === "-C")
      gitFolder = joinFolder(gitFolder, args[index + 1]?.text ?? "");
    if (text === "-c" && /^alias\.[^=]*=\s*!/i.test(args[index + 1]?.text ?? ""))
      result.isFullyParsed = false;
    index += gitValuedOptions.has(text) ? 2 : 1;
  }
  result.commands.push({ argv: [first.text, ...expandFlags("git", args.slice(index))], folder: gitFolder });
}
function addFind(first, args, folder, result) {
  const own = [];
  const actions = [];
  for (let index = 0;index < args.length; index += 1) {
    const text = args[index].text;
    if (!findActions.has(text)) {
      own.push(text);
      continue;
    }
    const end = args.findIndex((word, at) => at > index && (word.text === ";" || word.text === "+"));
    actions.push(args.slice(index + 1, end < 0 ? args.length : end));
    index = end < 0 ? args.length : end;
  }
  result.commands.push({ argv: [first.text, ...own], folder });
  if (own.includes("-delete"))
    for (const start of findStarts(args))
      addPath(result, "writes", start, folder);
  for (const [actionFirst, ...actionArgs] of actions) {
    if (actionFirst !== undefined)
      addCommand(actionFirst, actionArgs, folder, undefined, result);
  }
}
function findStarts(args) {
  let index = 0;
  for (let text = args[0]?.text;text === "-D" || /^-([HLP]|O\d*)$/.test(text ?? ""); text = args[index]?.text)
    index += text === "-D" ? 2 : 1;
  const end = args.findIndex((word, at) => at >= index && /^[-(!),]/.test(word.text));
  const starts = args.slice(index, end < 0 ? args.length : end);
  return starts.length > 0 ? starts : [literal(".")];
}
function addWrapper(first, program, args, folder, stdin, result) {
  const wrapper = wrappers.get(program);
  if (program === "xargs" && stdin?.type !== "text")
    result.isFullyParsed = false;
  const { options, operands } = readArguments(args, wrapper, true);
  let start = args.length - operands.length;
  if (options.some((option) => wrapper.stops?.includes(option.name) === true))
    start = args.length;
  start += wrapper.leadingOperands ?? 0;
  while (wrapper.takesAssignments === true && assignmentPattern.test(args[start]?.text ?? ""))
    start += 1;
  const hasTrailingCode = wrapper.codeOptions?.includes(args[start]?.text ?? "") === true;
  result.commands.push({ argv: [first.text, ...expandFlags(program, args.slice(0, start))], folder });
  const innerFolder = options.findLast((option) => wrapper.folderOptions?.includes(option.name) === true)?.value;
  const wrappedFolder = innerFolder === undefined ? folder : joinFolder(folder, innerFolder.text);
  const code = hasTrailingCode ? args[start + 1] : options.findLast((option) => wrapper.codeOptions?.includes(option.name) === true)?.value;
  const rest = args.slice(hasTrailingCode ? start + 2 : start);
  const isShell = wrapper.shellUnless !== undefined && !options.some((option) => wrapper.shellUnless?.includes(option.name) === true);
  if (code !== undefined || isShell) {
    parseLine([...code === undefined ? [] : [code], ...rest].map((word) => word.text).join(" "), wrappedFolder, result);
    return;
  }
  const [innerFirst, ...innerArgs] = rest;
  if (innerFirst !== undefined)
    addCommand(innerFirst, innerArgs, wrappedFolder, stdin, result);
}
function addEffects(program, args, flags, folder, stdin, result) {
  const fileProgram = fileReaders.get(program);
  const fileWriter = fileWriters.get(program);
  const copyProgram = copyPrograms.get(program);
  const fetcher = fetchers.get(program);
  const inlineFlags = inlineCodeFlags.get(program);
  if (program === "eval")
    result.isFullyParsed = false;
  else if (shells.has(program))
    addShell(args, folder, stdin, result);
  else if (program === "ssh")
    addSsh(args, stdin, result);
  else if (program === "su")
    addSu(args, folder, result);
  else if (program === "source" || program === ".")
    addPath(result, "reads", readArguments(args, {}, true).operands[0], folder);
  else if (program === "dd")
    for (const word of args.filter((arg) => arg.text.startsWith("of=")))
      addPath(result, "writes", { ...word, text: word.text.slice(3) }, folder);
  else if (fileWriter !== undefined)
    for (const operand of readArguments(args, fileWriter, false).operands)
      addPath(result, "writes", operand, folder);
  else if (copyProgram !== undefined)
    addCopy(copyProgram, args, folder, result);
  else if (fileProgram !== undefined)
    addFileArguments(fileProgram, args, folder, result);
  else if (fetcher !== undefined)
    addFetches(fetcher, args, result);
  else if (inlineFlags !== undefined) {
    if (program === "perl" && readArguments(args, perl, false).options.some((option) => option.name === "-i"))
      addFileArguments(perl, args, folder, result);
    const script = args.find((word) => !word.text.startsWith("-") || word.text === "-");
    const readsCodeFromPipe = stdin?.type === "pipe" && (script === undefined || script.text === "-");
    if (flags.some((flag) => inlineFlags.includes(flag)) || stdin?.type === "text" || readsCodeFromPipe)
      result.isFullyParsed = false;
  }
}
function addShell(args, folder, stdin, result) {
  const { options, operands } = readArguments(args, { valued: "oO", longValued: ["--rcfile", "--init-file"] }, true);
  const script = operands[0];
  if (options.some((option) => option.name === "-c")) {
    if (script !== undefined)
      parseLine(script.text, folder, result);
  } else if (script === undefined || options.some((option) => option.name === "-s"))
    addStdinCode(stdin, folder, result);
}
function addSsh(args, stdin, result) {
  const { operands } = readArguments(args, { valued: "BbcDEeFIiJLlmOoPpQRSWw" }, true);
  const remote = operands.slice(1);
  if (remote.length > 0)
    parseLine(remote.map((word) => word.text).join(" "), "~", result);
  else if (operands.length > 0)
    addStdinCode(stdin, "~", result);
}
function addSu(args, folder, result) {
  const code = readArguments(args, su, false).options.findLast((option) => suCodeOptions.includes(option.name))?.value;
  if (code !== undefined)
    parseLine(code.text, folder, result);
}
function addFetches(fetcher, args, result) {
  const { options, operands } = readArguments(args, fetcher, false);
  const urls = [...options.filter((option) => option.name === "--url").flatMap((option) => option.value === undefined ? [] : [option.value]), ...operands];
  for (const url of urls)
    result.fetches.push(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.text) ? url.text : `http://${url.text}`);
}
function addStdinCode(stdin, folder, result) {
  if (stdin?.type === "text")
    parseLine(stdin.text, folder, result);
  if (stdin?.type === "pipe")
    result.isFullyParsed = false;
}
function addCopy(program, args, folder, result) {
  const { options, operands } = readArguments(args, program, false);
  const target = options.findLast((option) => program.targetOptions?.includes(option.name) === true)?.value;
  const only = operands[0];
  if (program.linksHere === true && target === undefined && operands.length === 1 && only !== undefined) {
    addPath(result, "writes", { ...only, text: ft(only.text) }, folder);
    return;
  }
  const destination = target ?? operands.at(-1);
  const sources = target === undefined ? operands.slice(0, -1) : operands;
  if (destination === undefined || sources.length === 0)
    return;
  const isLocal = (word) => program.skipsRemote !== true || !/^[^/]*:/.test(word.text);
  for (const source of sources.filter(isLocal)) {
    if (program.sources !== undefined)
      addPath(result, program.sources, source, folder);
    if (isLocal(destination) && !source.isGlob && !destination.isGlob)
      addPathText(result, "writes", `${destination.text.replace(/\/+$/, "")}/${ft(source.text)}`, folder);
  }
  if (isLocal(destination))
    addPath(result, "writes", destination, folder);
}
function addFileArguments(program, args, folder, result) {
  const { options, operands } = readArguments(args, program, false);
  const inPlace = options.find((option) => program.inPlaceOptions?.includes(option.name) === true && (program !== awk || option.value?.text === "inplace"));
  let files = operands;
  if (program === sed && inPlace !== undefined && inPlace.value === undefined) {
    const suffix = files[0]?.text;
    const hasScriptOption = options.some((option) => program.scriptOptions?.includes(option.name) === true);
    if (suffix === "" || !hasScriptOption && suffix !== undefined && /^\.[\w.-]*$/.test(suffix))
      files = files.slice(1);
  }
  if (program.scriptOptions !== undefined && !options.some((option) => program.scriptOptions?.includes(option.name) === true))
    files = files.slice(1);
  if (program.takesAssignments === true)
    files = files.filter((file) => !assignmentPattern.test(file.text));
  for (const file of files)
    addPath(result, inPlace === undefined ? "reads" : "writes", file, folder);
}
function readArguments(args, spec, stopsAtOperand) {
  const options = [];
  const operands = [];
  for (let index = 0;index < args.length; index += 1) {
    const word = args[index];
    const text = word.text;
    if (text === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (word.isGlob || text === "-" || !text.startsWith("-")) {
      if (stopsAtOperand) {
        operands.push(...args.slice(index));
        break;
      }
      operands.push(word);
      continue;
    }
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      if (equals >= 0)
        options.push({ name: text.slice(0, equals), value: literal(text.slice(equals + 1)) });
      else if (spec.longValued?.includes(text) === true) {
        options.push({ name: text, value: args[index + 1] });
        index += 1;
      } else
        options.push({ name: text, value: undefined });
      continue;
    }
    for (let at = 1;at < text.length; at += 1) {
      const letter = text.charAt(at);
      const rest = text.slice(at + 1);
      if (spec.optional?.includes(letter) === true) {
        options.push({ name: `-${letter}`, value: rest === "" ? undefined : literal(rest) });
        break;
      }
      if (spec.valued?.includes(letter) === true) {
        if (rest !== "")
          options.push({ name: `-${letter}`, value: literal(rest) });
        else {
          options.push({ name: `-${letter}`, value: args[index + 1] });
          index += 1;
        }
        break;
      }
      options.push({ name: `-${letter}`, value: undefined });
    }
  }
  return { options, operands };
}
function expandFlags(program, args) {
  const texts = args.map((word) => word.text);
  if (nonGetoptPrograms.has(program))
    return texts;
  const spec = fileReaders.get(program) ?? wrappers.get(program);
  const takesValue = `${spec?.valued ?? ""}${spec?.optional ?? ""}`;
  const end = texts.indexOf("--");
  return texts.flatMap((text, index) => end >= 0 && index > end || !clusterPattern.test(text) ? [text] : expandCluster(text, takesValue));
}
function expandCluster(cluster, takesValue) {
  const flags = [];
  for (let index = 1;index < cluster.length; index += 1) {
    const letter = cluster.charAt(index);
    if (takesValue.includes(letter) && index < cluster.length - 1)
      return [...flags, `-${cluster.slice(index)}`];
    flags.push(`-${letter}`);
  }
  return flags;
}
function changedFolder(args, folder) {
  const target = args.find((word) => !word.text.startsWith("-") || word.text === "-");
  if (target === undefined)
    return "~";
  return joinFolder(folder, target.text === "-" ? "$OLDPWD" : target.text);
}
function addPath(result, access, word, folder) {
  if (word !== undefined && !word.isGlob)
    addPathText(result, access, word.text, folder);
}
function addPathText(result, access, path, folder) {
  if (path === "" || path.startsWith("/dev/"))
    return;
  const joined = joinFolder(folder, path);
  if (dynamicPattern.test(joined.replace(homePrefix2, "")))
    result.isFullyParsed = false;
  result[access].push(joined);
}
function joinFolder(folder, path) {
  return folder === "" || /^(\/|~|\$HOME(\/|$))/.test(path) ? path : `${folder}/${path}`;
}
function literal(text) {
  return { text, isGlob: false, isDynamic: false };
}

// node_modules/@cmodjs/core/utils/call-effects.js
function callEffects(use, workspace) {
  const { fs } = workspace;
  const absolute = (path, folder = workspace.cwd) => ve(folder, expandHome(path, workspace.home, workspace.configRoot));
  const access = (path) => ({ path: absolute(path), contents: undefined });
  const effects = { shell: undefined, reads: [], writes: [], urls: [], subagent: undefined };
  if (use.tool === "Bash") {
    const line = textField(use, "command");
    const parsed = parseShell(line);
    const commands = parsed.commands.map(({ argv, folder }) => ({ argv, folder: absolute(folder) }));
    effects.shell = { line, commands, isFullyParsed: parsed.isFullyParsed };
    effects.reads = parsed.reads.map(access);
    effects.writes = parsed.writes.map(access);
    effects.urls = parsed.fetches;
  } else if (use.tool === "PowerShell") {
    effects.shell = { line: textField(use, "command"), commands: [], isFullyParsed: false };
  } else if (use.tool === "Edit") {
    const path = absolute(textField(use, "file_path"));
    effects.writes = [{ path, contents: once(() => editedContents(use, path, fs)) }];
  } else if (use.tool === "Write") {
    const path = absolute(textField(use, "file_path"));
    const content = textField(use, "content");
    effects.writes = [{ path, contents: once(async () => contentsOf(content, await previousContentOf(path, fs))) }];
  } else if (use.tool === "NotebookEdit") {
    const path = absolute(textField(use, "notebook_path"));
    effects.writes = [{ path, contents: once(async () => contentsOf(undefined, await previousContentOf(path, fs))) }];
  } else if (use.tool === "Read") {
    effects.reads = [access(textField(use, "file_path"))];
  } else if (use.tool === "Grep") {
    effects.reads = [access(optionalTextField(use, "path") ?? "")];
  } else if (use.tool === "Glob") {
    const folder = absolute(optionalTextField(use, "path") ?? "");
    effects.reads = [{ path: absolute(textField(use, "pattern"), folder), contents: undefined }];
  } else if (use.tool === "WebFetch") {
    effects.urls = [textField(use, "url")];
  } else if (use.tool === "Agent") {
    effects.subagent = optionalTextField(use, "subagent_type") ?? "general-purpose";
  }
  return effects;
}
async function editedContents(use, path, fs) {
  const previousContent = await previousContentOf(path, fs);
  const oldString = textField(use, "old_string");
  const newString = textField(use, "new_string");
  if (oldString === "")
    return contentsOf(previousContent === undefined || previousContent === "" ? newString : undefined, previousContent);
  if (previousContent === undefined || !previousContent.includes(oldString))
    return contentsOf(undefined, previousContent);
  const content = fieldOf(use, "replace_all") === true ? previousContent.split(oldString).join(newString) : previousContent.replace(oldString, () => newString);
  return contentsOf(content, previousContent);
}
async function previousContentOf(path, fs) {
  const stat = await fs.stat(path).catch(ifMissing(undefined));
  return stat?.kind === "file" ? fs.read(path) : undefined;
}
function contentsOf(content, previousContent) {
  return { ...content === undefined ? {} : { content }, ...previousContent === undefined ? {} : { previousContent } };
}
function once(load) {
  let loaded;
  return () => loaded ??= load();
}
function fieldOf(use, name) {
  return use.input[name];
}
function textField(use, name) {
  const value = fieldOf(use, name);
  if (typeof value !== "string")
    throw new Error(`The ${use.tool} call has no text field ${name}.`);
  return value;
}
function optionalTextField(use, name) {
  return fieldOf(use, name) === undefined ? undefined : textField(use, name);
}

// node_modules/@cmodjs/core/runtime/hooks.js
function classicHook(event, hook, report) {
  const routed = async (e, next) => {
    const ours = await Promise.resolve().then(() => hook(e, next.signal)).catch((error) => {
      report({ id: `hook:${event}`, message: `The ${event} listener failed`, error });
      return;
    });
    if (ours === undefined)
      return next(e);
    return mergeClassic(await next(e), ours);
  };
  return routed;
}
function classicFailure(failed) {
  const routed = async (e, error, next) => {
    const ours = await failed(e, error);
    return ours === undefined ? undefined : mergeClassic(await next(e), ours);
  };
  return routed;
}
var frontmatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
var baseDirectoryLine = /^Base directory for this skill: [^\n]*\n\n/;
function userSkillHook(claude) {
  return async (e, next) => {
    const { name, root } = claude.plugin;
    if (!e.skill.startsWith(`${name}:`))
      return next(e);
    const skill = e.skill.slice(name.length + 1);
    const skills = `${root}/skills`;
    if (!await claude.fs.exists(skills) || !(await claude.fs.list(skills)).some((entry) => entry.name === skill))
      return next(e);
    if ((await claude.fs.stat(`${skills}/${skill}`)).kind !== "dir")
      return next(e);
    const env = { HOME: await claude.env.home(), CLAUDE_CONFIG_DIR: await claude.env.configHome() };
    for (const { folder } of configFolders(env, name, await claude.session.root()).toReversed()) {
      const path = `${folder}/skills/${skill}/SKILL.md`;
      if (await claude.fs.exists(path))
        return { text: `${baseDirectoryLine.exec(e.text)?.[0] ?? ""}${(await claude.fs.read(path)).replace(frontmatter, "")}` };
    }
    return next(e);
  };
}
async function callFiles(name, claude, folders, use, cwd) {
  try {
    const { home, configRoot } = await folders;
    if (home === undefined)
      throw new Error("HOME is not set, so ~ in a path has no meaning.");
    const { shell, reads, writes } = callEffects(use, { cwd, home, ...configRoot === undefined ? {} : { configRoot }, fs: claude.fs });
    const known = (accesses) => accesses.map(({ path }) => path).filter((path) => shell === undefined || !dynamicPattern.test(path));
    const unchecked = (path) => (error) => {
      if (!isMissing(error))
        claude.ui.warn("call:files", `${name}: the ${use.tool} call reads ${path}, which could not be checked: ${messageOf(error)}`);
      return;
    };
    const read = await Promise.all(known(reads).map(async (path) => (await claude.fs.stat(path).catch(unchecked(path)))?.kind === "file" ? [path] : []));
    return { read: read.flat(), changed: known(writes) };
  } catch (error) {
    claude.ui.warn("call:files", `${name}: the ${use.tool} call lists no files: ${messageOf(error)}`);
    return { read: [], changed: [] };
  }
}
function mergeClassic(below, ours) {
  const merged = { ...below, ...ours };
  const context = [...below["additionalContext"] ?? [], ...ours["additionalContext"] ?? []];
  if (context.length > 0)
    merged["additionalContext"] = context;
  return merged;
}

// node_modules/@cmodjs/core/runtime/sessions.js
var everySession = "*";
var conversationMethods = {
  sessions: "cmod:sessions",
  search: "cmod:search",
  messages: "cmod:messages",
  turns: "cmod:turns",
  contexts: "cmod:contexts",
  tasks: "cmod:tasks",
  goal: "cmod:goal",
  updateGoal: "cmod:updateGoal",
  subscribe: "cmod:subscribe",
  watchBefore: "cmod:watchBefore",
  act: "cmod:act",
  changed: "cmod:changed",
  before: "cmod:before",
  sessionColor: "cmod:sessionColor"
};
var resetColors = ["default", "reset", "none", "gray", "grey"];
function pickedColor(args) {
  const picked = args.trim().toLowerCase();
  return resetColors.includes(picked) ? undefined : picked;
}
var acts = ["send", "startTask", "fork", "clone", "startBackgroundTask", "callTool", "usage", "surfaces", "abort"];
var isAct = (action) => acts.includes(action);
async function usageOf(claude) {
  const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()]);
  const { tokens, window, percent } = usage.context;
  const rateLimits = usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ type: kind, percent: percentUsed, ...resetsAt === undefined ? {} : { resetsAt } }));
  return { model, contextWindow: { ...tokens === undefined ? {} : { tokenCount: tokens }, size: window, ...percent === undefined ? {} : { percent } }, rateLimits, ...usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } } };
}
function payloadOf(change) {
  if (change.type === Message)
    return change.message;
  if ("turn" in change)
    return change.turn;
  if ("context" in change)
    return change.context;
  if ("task" in change) {
    const { id, title, agentType, model, openedBy, openedAt, closedAt, isBackground, forkedFrom } = change.task;
    const owner = { id, title, ...agentType === undefined ? {} : { agentType }, ...model === undefined ? {} : { model }, ...forkedFrom === undefined ? {} : { forkedFrom }, startedAt: openedAt };
    return { id, title, openedBy, openedAt, ...closedAt === undefined ? {} : { closedAt }, ...isBackground === true ? { isBackground } : {}, owner };
  }
  if ("usage" in change)
    return change.usage;
  return change.goal;
}
function isHeardBy(event, matcher, change) {
  const named = change.type === Message ? event === Message || event === change.message.type : event === change.type;
  return named && (matcher === undefined || matches(payloadOf(change), matcher));
}
function taskOfChange(change) {
  if (change.type === Message)
    return change.message.task;
  if (change.type === TaskStart || change.type === TaskEnd)
    return change.task.id === "" ? change.task.parent : change.task.id;
  if (change.type === TurnStart || change.type === TurnEnd2)
    return change.turn.prompt.task;
  if (change.type === ContextStart || change.type === ContextEnd)
    return change.context.task;
  if (change.type === GoalChange)
    return change.goal.task;
  return;
}
function ownerOfChange(change) {
  if (change.type === TaskStart || change.type === TaskEnd)
    return change.task.parent;
  return taskOfChange(change);
}
function contextOfChange(change) {
  if (change.type === Message)
    return change.message.context;
  if (change.type === TurnStart || change.type === TurnEnd2)
    return change.turn.context;
  if (change.type === ContextStart || change.type === ContextEnd)
    return change.context.number;
  if (change.type === TaskStart || change.type === TaskEnd)
    return change.task.context;
  return;
}
function isInScope(scope, session, change, isUnder) {
  if (scope.session !== undefined && scope.session !== session)
    return false;
  const task = taskOfChange(change);
  if (scope.isAgent === true)
    return (change.type === TaskStart || change.type === TaskEnd ? change.task.parent : task) === scope.task;
  if (scope.task !== undefined && (task === undefined || !isUnder(task, scope.task)))
    return false;
  if (scope.context !== undefined && (contextOfChange(change) !== scope.context || ownerOfChange(change) !== scope.task))
    return false;
  if (scope.turn === undefined)
    return true;
  if (change.type === Message)
    return change.message.turn === scope.turn;
  return (change.type === TurnStart || change.type === TurnEnd2) && change.turn.prompt.id === scope.turn;
}
function withoutPermissionCheck(name, hearer) {
  return `${name}: ${hearer} hears Claude Code's permission check, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod.`;
}
function createSessionsClient({ name, claude, report, hookOn, routeOn, permissionRoutes }) {
  const call = (method, input) => claude.cmod.call({ to: cmodPluginName, method, input });
  const listening = new Map;
  const deciding = new Map;
  const queued = new Set;
  const parents = new Map;
  const readingParents = new Map;
  const known = new Map;
  let current = { id: "", title: "", project: "", cwd: "", model: "", startedAt: "", lastAt: "", isRunning: true };
  let told = { session: "" };
  const colored = ({ color: _color, ...data }) => told.session === data.id && told.color !== undefined ? { ...data, color: told.color } : data;
  const keyOf = (scope) => scope.session ?? everySession;
  const subscribe = (key) => {
    if (queued.has(key))
      return;
    queued.add(key);
    Promise.resolve().then(async () => {
      queued.delete(key);
      const heard = (from) => [...from.get(key) ?? []].map(({ event, matcher, options, scope }) => ({ event, matcher: matcher === undefined ? undefined : sentMatcher(matcher), ...options.onFailure === "refuse" ? { onFailure: "refuse", scope } : {} }));
      const tracksTasks = [...listening.get(key) ?? [], ...deciding.get(key) ?? []].some(({ scope }) => scope.task !== undefined || scope.isGoal === true);
      const subscriptions = [...heard(listening), ...tracksTasks ? [{ event: TaskStart }] : []];
      await call(conversationMethods.subscribe, { session: key, subscriptions }).catch((error) => report(`sessions:${key}`, `Hears nothing from ${key === everySession ? "the other sessions" : `session ${key}`}`, error));
      await call(conversationMethods.watchBefore, { session: key, subscriptions: heard(deciding) }).catch((error) => report(`before:${key}`, `Changes nothing in ${key === everySession ? "the other sessions" : `session ${key}`}`, error));
    });
  };
  const parentsOf = (session) => {
    const known = parents.get(session);
    if (known !== undefined)
      return known;
    const reading = readingParents.get(session);
    if (reading !== undefined)
      return reading;
    const read = call(conversationMethods.tasks, { session, all: true }).then((tasks) => {
      const tree = new Map(tasks.map((task) => [task.id, task.parent]));
      parents.set(session, tree);
      return tree;
    }).finally(() => readingParents.delete(session));
    readingParents.set(session, read);
    return read;
  };
  const isUnderIn = (tree) => (task, ancestor) => {
    for (let at = task, steps = 0;at !== undefined && steps < 64; at = tree?.get(at), steps += 1)
      if (at === ancestor)
        return true;
    return false;
  };
  const inScope = ({ scope }, session, change) => {
    if (scope.task === undefined || scope.isAgent === true)
      return isInScope(scope, session, change, isUnderIn(undefined));
    const tree = parentsOf(session);
    if (tree instanceof Map)
      return isInScope(scope, session, change, isUnderIn(tree));
    return tree.then((read) => isInScope(scope, session, change, isUnderIn(read)), (error) => (report(`tasks:${session}`, "Could not read the tasks it listens under", error), false));
  };
  const remember = (session, change) => {
    if (change.type !== TaskStart)
      return;
    parents.get(session)?.set(change.task.id, change.task.parent);
    readingParents.get(session)?.then((tree) => tree.set(change.task.id, change.task.parent), (error) => claude.ui.warn("tasks:read", `${name}: the tasks of ${session} stay unread until the next change: ${messageOf(error)}`));
  };
  const add = (into, scope, event, method, args, onChange) => {
    const key = keyOf(scope);
    const entry = { scope, event, method, ...listenerOf(name, method, args) };
    const set = into.get(key) ?? new Set;
    set.add(entry);
    into.set(key, set);
    onChange(key);
    return {
      remove() {
        for (const [at, held] of into) {
          if (!held.delete(entry))
            continue;
          if (held.size === 0)
            into.delete(at);
          onChange(at);
          return;
        }
      }
    };
  };
  const refusalOf = (options, takes, error) => options.onFailure === "refuse" && takes.includes("refuse") ? { refuse: `${name}: ${messageOf(error)}` } : undefined;
  const invoke = (method, options, cancel, run, takes = []) => withinTime(claude.clock, method, options, cancel, run).catch((error) => {
    if (cancel.aborted || error instanceof PassedTimeout && !method.startsWith("before"))
      return;
    report(`session:${method}`, `The ${method} listener failed`, error);
    return refusalOf(options, takes, error);
  });
  const decidersOf = (session, event, isInProject) => [...deciding.get(session) ?? [], ...isInProject ? deciding.get(everySession) ?? [] : []].filter((entry) => entry.event === event);
  const decides = async (entry, session, change) => (entry.matcher === undefined || matches(payloadOf(change), entry.matcher)) && await inScope(entry, session, change);
  const combined = async (session, event, change, isInProject, cancel) => {
    const askers = decidersOf(session, event, isInProject).map((entry) => async (latest) => {
      if (!await decides(entry, session, latest))
        return;
      const payload = await payloadFor(session, latest);
      return invoke(entry.method, entry.options, cancel, async (time) => takenAnswer(entry.method, beforeAnswerKeys[event], await entry.listener(payload, time)), beforeAnswerKeys[event]);
    });
    const answer = await foldBefore(event, change, askers, (error) => report(`session:${methodOf("before", event)}`, `The ${methodOf("before", event)} listener failed`, error));
    return answer?.note === undefined ? answer : { ...answer, note: modNote(name, answer.note) };
  };
  const eventMethods = (scopeOf, hasBefore, ended) => {
    const method = (into, named, event) => (...args) => {
      if (ended !== undefined)
        throw new Error(`${name}: ${ended} has ended, so its ${named} never fires. Listen on its Session.`);
      return add(into, scopeOf(), event, named, args, subscribe);
    };
    return Object.fromEntries([
      ...Object.entries(sessionEvents).map(([named, event]) => [`on${named}`, method(listening, `on${named}`, event)]),
      ...hasBefore ? beforeEvents.map((named) => [`before${named}`, method(deciding, `before${named}`, sessionEvents[named])]) : []
    ]);
  };
  let folders;
  const withFiles = async (message) => {
    if (message.type !== ToolCall && message.type !== ToolResult)
      return message;
    folders ??= Promise.all([claude.env.home(), claude.env.configHome()]).then(([home, configRoot]) => ({ home, configRoot }));
    return { ...message, files: await callFiles(name, claude, folders, { tool: message.name, input: message.input }, message.cwd) };
  };
  const messagesFrom = async (method, input) => Promise.all((await call(method, input)).map(withFiles));
  const searched = (request, matcher) => ({
    async* [Symbol.asyncIterator]() {
      let before = request["before"];
      for (;; ) {
        const page = await messagesFrom(conversationMethods.search, { ...request, ...before === undefined ? {} : { before } });
        for (const message of page)
          if (matcher === undefined || matches(message, matcher))
            yield message;
        const last = page.at(-1);
        if (last === undefined || page.length < searchLimit)
          return;
        before = { session: last.session, id: last.id };
      }
    }
  });
  const recordPart = (scope, ended) => ({
    search: (text, matcher) => searched({ text, ...scope }, matcher),
    ...eventMethods(() => scope, true, ended)
  });
  const turnOf = (scope, data) => {
    const task = data.prompt.task ?? scope.task;
    return {
      ...data,
      ...recordPart({ ...scope, ...task === undefined ? {} : { task }, turn: data.prompt.id }, data.closedAt === undefined ? undefined : `turn ${data.prompt.id}`),
      messages: () => messagesFrom(conversationMethods.messages, { session: scope.session, turn: data.prompt.id, ...task === undefined ? {} : { task } }),
      abort: async () => {
        if (data.closedAt !== undefined)
          throw new Error(`${name}: turn ${data.prompt.id} has ended, so there is nothing to abort.`);
        const session = scope.session ?? current.id;
        await act(session, "abort", { turn: data.prompt.id }, task === undefined ? undefined : { session, task });
      }
    };
  };
  const contextOf = (scope, data) => {
    const owned = { ...scope.session === undefined ? {} : { session: scope.session }, ...data.task === undefined ? {} : { task: data.task } };
    return {
      ...data,
      ...recordPart({ ...owned, context: data.number }, data.closedAt === undefined ? undefined : `context ${data.number}`),
      turns: async () => (await call(conversationMethods.turns, { ...owned, context: data.number })).map((turn) => turnOf(owned, turn))
    };
  };
  const taskOf = (session, data) => {
    const record = data.isBackground === true ? { session: data.id } : { session, task: data.id };
    return {
      id: data.id,
      title: data.title,
      openedBy: data.openedBy,
      openedAt: data.openedAt,
      ...data.closedAt === undefined ? {} : { closedAt: data.closedAt },
      ...data.status === undefined ? {} : { status: data.status },
      ...data.name === undefined ? {} : { name: data.name },
      ...data.spawnedBy === undefined ? {} : { spawnedBy: data.spawnedBy },
      ...data.isBackground === true ? { isBackground: true } : {},
      owner: ownerOf(session, data),
      ...recordPart({ session, task: data.id }),
      search: (text, matcher) => searched({ text, ...record }, matcher),
      tasks: async () => (await call(conversationMethods.tasks, record)).map((task) => taskOf(record.session, task)),
      messages: () => messagesFrom(conversationMethods.messages, record)
    };
  };
  const goalOf = (where) => ({
    search: (text, matcher) => searched({ text, ...where() }, matcher),
    ...eventMethods(() => ({ ...where(), isGoal: true }), true),
    text: async () => (await call(conversationMethods.goal, where())).text,
    tasks: async () => {
      const { session = current.id, task } = where();
      return (await call(conversationMethods.tasks, { session, ...task === undefined ? {} : { task } })).map((each) => taskOf(session, each));
    },
    update: async ({ text }) => {
      if (text.trim() === "")
        throw new Error(`${name}: a goal needs text.`);
      const { session = current.id, task } = where();
      await call(conversationMethods.updateGoal, { session, ...task === undefined ? {} : { task }, text });
    }
  });
  const payloadFor = async (session, change) => {
    const scope = { session };
    if (change.type === Message)
      return withFiles(change.message);
    if ("turn" in change)
      return turnOf(scope, change.turn);
    if ("context" in change)
      return contextOf(scope, change.context);
    if ("task" in change)
      return taskOf(session, change.task);
    if ("usage" in change)
      return change.usage;
    const { task } = change.goal;
    return goalOf(() => ({ session, ...task === undefined ? {} : { task } }));
  };
  const act = (session, action, input, owned) => call(conversationMethods.act, { session: owned?.session ?? session, action, input, ...owned === undefined ? {} : { task: owned.task } });
  const sendHere = async ({ type, text, as }) => {
    if (type === Note) {
      if (as !== undefined)
        throw new Error(`${name}: a Note is always from this mod, so it takes no as.`);
      const added = await claude.session.append({ message: { type: "user", content: [{ type: "text", text: modNote(name, text) }] } });
      if (added.deny !== undefined)
        throw new Error(`${name}: Claude Code refused the note: ${added.deny}`);
      return;
    }
    const submitted = await claude.prompt.submit({ text, ...as === Person ? { asUser: true } : {} });
    if ("drop" in submitted && typeof submitted.drop === "string")
      throw new Error(`${name}: Claude Code dropped the prompt: ${submitted.drop}`);
  };
  const surfacesHere = async () => [...await claude.session.surfaces()];
  const sessionOf = (read, owned, isOwner = owned !== undefined) => {
    const id = () => read().id;
    const isHere = () => owned === undefined && id() === current.id;
    const scope = () => owned === undefined ? { session: id(), isAgent: true } : { session: owned.session, task: owned.task, isAgent: true };
    const where = () => owned === undefined ? { session: id() } : { session: owned.session, task: owned.task };
    const turnsOf = async (options = {}) => (await call(conversationMethods.turns, { ...where(), ...options })).map((turn) => turnOf(where(), turn));
    const contextsOf = async () => (await call(conversationMethods.contexts, where())).map((context) => contextOf(where(), context));
    const session = {
      get id() {
        return read().id;
      },
      get title() {
        return read().title;
      },
      get color() {
        return read().color;
      },
      get project() {
        return read().project;
      },
      get agentType() {
        return read().agentType;
      },
      get model() {
        return read().model;
      },
      get cwd() {
        return read().cwd;
      },
      get isRunning() {
        return read().isRunning;
      },
      get startedAt() {
        return read().startedAt;
      },
      get lastAt() {
        return read().lastAt;
      },
      get forkedFrom() {
        return read().forkedFrom;
      },
      search: (text, matcher) => recordPart(scope()).search(text, matcher),
      ...eventMethods(scope, true),
      goal: goalOf(where),
      context: async () => {
        const all = await contextsOf();
        const last = all.at(-1);
        if (last === undefined)
          throw new Error(`${name}: session ${id()} has no context yet.`);
        return last;
      },
      contexts: contextsOf,
      turn: async () => {
        const [last] = await turnsOf({ last: 1 });
        return last?.closedAt === undefined ? last : undefined;
      },
      turns: turnsOf,
      messages: (options = {}) => messagesFrom(conversationMethods.messages, { ...where(), ...options }),
      usage: async () => isHere() ? usageOf(claude) : act(id(), "usage", null, owned),
      surfaces: async () => isHere() ? surfacesHere() : act(id(), "surfaces", null, owned),
      async send(message) {
        if (message.text.trim() === "")
          throw new Error(`${name}: send needs text.`);
        if (isHere() && message.as !== Session)
          return sendHere(message);
        await act(id(), "send", message, owned);
      }
    };
    if (isOwner)
      return session;
    const started = async (starting) => taskOf(id(), await starting.catch((error) => Promise.reject(new Error(`${name}: ${messageOf(error)}`))));
    return Object.assign(session, {
      startTask: (task) => started(task.isBackground === true ? act(id(), "startBackgroundTask", task) : isHere() ? spawnTask(claude, task) : act(id(), "startTask", task)),
      fork: (task) => started(isHere() ? spawnTask(claude, task, current.id) : act(id(), "fork", task)),
      clone: (task) => started(act(id(), "clone", task)),
      callTool: async (toolCall) => await withFiles(await act(id(), "callTool", toolCall))
    });
  };
  const ownerOf = (session, data) => {
    const parent = session === current.id ? current : known.get(session);
    const isBackground = data.isBackground === true;
    return sessionOf(() => ({
      id: data.id,
      title: data.title,
      project: parent?.project ?? "",
      ...data.agentType === undefined ? {} : { agentType: data.agentType },
      model: data.model ?? "",
      cwd: parent?.cwd ?? "",
      isRunning: data.closedAt === undefined && (isBackground || (parent?.isRunning ?? true)),
      startedAt: data.openedAt,
      lastAt: data.closedAt ?? data.openedAt,
      ...data.forkedFrom === undefined ? {} : { forkedFrom: data.forkedFrom }
    }), isBackground ? undefined : { session, task: data.id }, true);
  };
  const processListeners = new Map;
  const processHearers = (method, payload) => [...processListeners.get(method) ?? []].filter(({ matcher, isEveryAgent }) => (payload["task"] === undefined || isEveryAgent) && (matcher === undefined || matches(payload, matcher)));
  const raise = async (method, payload, cancel) => {
    const heard = processHearers(method, payload);
    if (!method.startsWith("before")) {
      await Promise.all(heard.map(({ listener, options }) => invoke(method, options, cancel, (time) => listener(payload, time))));
      return;
    }
    const takes = takesOf(method);
    const askers = heard.map(({ listener, options }) => () => invoke(method, options, cancel, async (time) => takenAnswer(method, takes, await listener(payload, time)), takes));
    return foldAnswers(method, takes, ["refuse"], undefined, askers, (error) => report(`session:${method}`, `The ${method} listener failed`, error));
  };
  const takesOf = (method) => answerKeys[method.slice("before".length)] ?? [];
  const refusalFor = (method, payload, error) => processHearers(method, payload).map((entry) => refusalOf(entry.options, takesOf(method), error)).find((answer) => answer !== undefined);
  const commandRun = async (e) => {
    const source = (await claude.command.list()).find((command) => command.name === e.command)?.source;
    return { session: current.id, cwd: current.cwd, name: e.command, args: e.args, ...defined({ source }), from: senderOf(e.origin, false) };
  };
  const commandListeners = { beforeRun: new Set, onRun: new Set };
  for (const [method, held] of Object.entries(commandListeners))
    processListeners.set(method, held);
  routeOn?.("command.run", async (e, next) => {
    if (commandListeners.beforeRun.size === 0 && commandListeners.onRun.size === 0)
      return next(e);
    const run = await commandRun(e);
    const answer = commandListeners.beforeRun.size === 0 ? undefined : await raise("beforeRun", run, next.signal);
    if (typeof answer?.["refuse"] === "string")
      return { text: answer["refuse"] };
    if (typeof answer?.["result"] === "string")
      return { text: answer["result"], ...typeof answer["exitCode"] === "number" ? { exitCode: answer["exitCode"] } : {} };
    const args = typeof answer?.["args"] === "string" ? answer["args"] : e.args;
    const ran = await next(args === e.args ? e : { ...e, args });
    raise("onRun", { ...run, args }, next.signal);
    return typeof answer?.["note"] === "string" ? { ...ran, context: [...ran.context ?? [], modNote(name, answer["note"])] } : ran;
  }, async (e, error) => {
    const refusal = commandListeners.beforeRun.size === 0 ? undefined : refusalFor("beforeRun", await commandRun(e), error);
    return refusal === undefined ? undefined : { text: refusal.refuse };
  });
  const listenTo = (method, named) => {
    if (hookOn === undefined || routeOn === undefined)
      throw new Error(`${name}: ${method} works only in a mod's own session.`);
    const isBefore = method.startsWith("before");
    if (named === "PermissionCheck" || named === "PermissionRequest") {
      const routes = permissionRoutes?.();
      if (routes === undefined)
        throw new Error(withoutPermissionCheck(name, method));
      return routes(method, { raise, refusalFor, hookOn, routeOn, current: () => current });
    }
    const event = processEvents[named];
    const hook = (isBefore ? event.before : undefined) ?? event.on;
    if (method === "beforeSessionStart")
      routeOn("session.compact", trackCompaction);
    if (method === "beforeModelChange")
      hookOn(event.on, () => {
        const notes = modelNotes.splice(0);
        return notes.length === 0 ? undefined : { additionalContext: notes };
      });
    const failed = (input, error) => {
      const refusal = refusalFor(method, processPayloadOf(named, input), error);
      return refusal === undefined ? undefined : hookAnswerOf(name, named, refusal);
    };
    return hookOn(hook, async (input, signal) => {
      const payload = processPayloadOf(named, input);
      if (named === "SessionStart" && payload["source"] === "compact") {
        if (!isBefore)
          return;
        const task = compacting?.agentId;
        const model = task === undefined ? await claude.session.model() : undefined;
        const answer = await raise(method, { ...payload, ...defined({ task, model, title: current.title || undefined }) }, signal);
        if (answer === undefined)
          return;
        return hookAnswerOf(name, named, task === undefined ? answer : defined({ note: answer["note"] }));
      }
      if (!isBefore) {
        raise(method, payload, signal);
        return;
      }
      if (named === "ModelChange")
        modelNotes.splice(0);
      const answer = await raise(method, payload, signal);
      if (answer === undefined)
        return;
      if (named === "ModelChange" && typeof answer["note"] === "string" && answer["refuse"] === undefined)
        modelNotes.push(modNote(name, answer["note"]));
      return hookAnswerOf(name, named, answer);
    }, isBefore ? failed : undefined);
  };
  const modelNotes = [];
  let compacting;
  const trackCompaction = async (e, next) => {
    compacting = e;
    try {
      return await next(e);
    } finally {
      if (compacting === e)
        compacting = undefined;
    }
  };
  const listen = (method, args, isEveryAgent = false) => {
    const heard = listenerOf(name, method, args);
    const entry = { ...heard, options: method === "beforePermissionRequest" ? { ...heard.options, onFailure: "refuse" } : heard.options, isEveryAgent };
    const held = processListeners.get(method) ?? new Set;
    if (!processListeners.has(method)) {
      listenTo(method, method.replace(/^(on|before)/, ""));
      processListeners.set(method, held);
    }
    held.add(entry);
    return { remove: () => void held.delete(entry) };
  };
  const processMethods = () => Object.fromEntries(Object.entries(processEvents).flatMap(([named, event]) => [`on${named}`, ..."before" in event ? [`before${named}`] : []]).map((method) => [method, (...args) => listen(method, args)]));
  const here = sessionOf(() => current);
  const currentSession = Object.assign(here, processMethods(), {
    goal: Object.assign(here.goal, { beforeSessionStart: (...args) => listen("beforeSessionStart", args, true) }),
    async scrollTo(message, options) {
      const { deny } = await claude.ui.scroll({ to: { requestId: message.id }, ...options?.block === undefined ? {} : { block: options.block } });
      if (deny !== undefined)
        throw new Error(`${name}: Claude Code did not scroll to the message: ${deny}`);
    },
    caption: (toolCall, text) => claude.ui.notice(toolCall.callId, text)
  });
  const every = eventMethods(() => ({}), false);
  const failedBefore = (session, event, change, isInProject, error) => {
    const asked = decidersOf(session, event, isInProject).filter((entry) => isInScope(entry.scope, session, change, isUnderIn(parents.get(session))) && (entry.matcher === undefined || matches(payloadOf(change), entry.matcher)));
    return asked.map((entry) => refusalOf(entry.options, beforeAnswerKeys[event], error)).find((answer) => answer !== undefined);
  };
  return {
    sessions: {
      get current() {
        return currentSession;
      },
      list: async (scope = {}) => (await call(conversationMethods.sessions, scope)).map((data) => {
        if (data.id !== current.id) {
          known.set(data.id, data);
          return sessionOf(() => known.get(data.id) ?? data);
        }
        if (current.title === "")
          current = { ...current, title: data.title };
        return currentSession;
      }),
      search: (text, matcher, options = {}) => searched({ text, ...searchOptionsOf(options) }, matcher),
      ...every
    },
    changed(session, change, isInProject, cancel) {
      remember(session, change);
      let payload;
      for (const key of isInProject ? [session, everySession] : [session]) {
        for (const entry of listening.get(key) ?? []) {
          const { event, method, matcher, listener, options } = entry;
          const deliver = () => {
            payload ??= payloadFor(session, change);
            payload.then((heard) => invoke(method, options, cancel, (time) => listener(heard, time))).catch((error) => report(`session:${method}`, `The ${method} listener failed`, error));
          };
          const isHeard = isHeardBy(event, matcher, change) && inScope(entry, session, change);
          if (isHeard === true)
            deliver();
          else if (isHeard !== false)
            isHeard.then((isIn) => isIn && deliver());
        }
      }
    },
    answerBefore: combined,
    failedBefore,
    raise,
    listen,
    turn: (data) => turnOf({ session: current.id }, data),
    follow(next) {
      const moved = next.id !== current.id && current.id !== "";
      const previous = current.id;
      current = colored({ ...next, title: next.title || (next.id === current.id ? current.title : ""), isRunning: true, lastAt: new Date().toISOString() });
      if (!moved)
        return;
      for (const into of [listening, deciding]) {
        const kept = into.get(previous);
        if (kept === undefined)
          continue;
        into.delete(previous);
        for (const entry of kept)
          if (entry.scope.session === previous)
            entry.scope = { ...entry.scope, session: current.id };
        into.set(current.id, new Set([...into.get(current.id) ?? [], ...kept]));
      }
      parents.delete(previous);
      subscribe(previous);
      subscribe(current.id);
    },
    recolor(next) {
      told = next;
      current = colored(current);
    }
  };
}
var recordOf = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
var defined = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
var placementOf = (input) => defined({ session: input["session_id"], task: input["agent_id"], agentType: input["agent_type"], cwd: input["cwd"], permissionMode: input["permission_mode"] });
var mcpServerOf = (server) => server === undefined ? undefined : { name: String(recordOf(server)["name"]), source: String(recordOf(server)["source"]) };
var modelChangeOf = (input) => ({
  model: input["to_model"],
  previous: input["from_model"],
  requested: input["requested_model"] ?? undefined,
  source: input["source"],
  contextTokenCount: input["context_tokens"],
  isCacheWarm: input["prompt_cache_warm"],
  cacheTtl: input["cache_ttl"],
  cacheWriteUsd: input["estimated_cache_write_usd"],
  pricing: input["pricing"]
});
var answerKeys = {
  Run: ["args", "note", "result", "exitCode", "refuse"],
  ProjectSetup: ["note"],
  SessionStart: ["note", "title", "reloadSkills", "firstPrompt"],
  ModelChange: ["ask", "refuse", "note"],
  WorktreeCreate: ["result"],
  Elicitation: ["refuse"],
  ElicitationResponse: ["refuse"],
  PermissionCheck: ["allow", "ask", "refuse"],
  PermissionRequest: ["allow", "input", "updates", "refuse", "interrupt"],
  PermissionDenial: ["retry"],
  ToolBatch: ["note"],
  TodoCreate: ["refuse"],
  TodoComplete: ["refuse"],
  ReplyDisplay: ["text"]
};
var todoOf = (input) => ({ id: input["task_id"], subject: input["task_subject"], description: input["task_description"], teammate: input["teammate_name"] });
var processFields = {
  ProjectSetup: (input) => ({ trigger: input["trigger"] }),
  SessionStart: (input) => ({
    source: input["source"],
    model: input["model"],
    title: input["session_title"] || undefined,
    idleSeconds: input["seconds_since_last_response"],
    contextTokenCount: input["context_tokens"],
    isCacheWarm: input["prompt_cache_likely_expired"] === undefined ? undefined : input["prompt_cache_likely_expired"] !== true,
    cacheWriteUsd: input["estimated_cache_write_usd"]
  }),
  SessionEnd: (input) => ({ reason: input["reason"] === "prompt_input_exit" ? "exit" : input["reason"] }),
  ModelChange: modelChangeOf,
  CwdChange: (input) => ({ cwd: input["new_cwd"] ?? input["cwd"], previous: input["old_cwd"] }),
  DirectoryAdd: (input) => ({ directory: input["directory"], source: input["source"] === "slash_command" ? "command" : "sdk" }),
  WorktreeCreate: (input) => ({ name: input["name"] }),
  WorktreeRemove: (input) => ({ path: input["worktree_path"] }),
  Notification: (input) => ({ text: input["message"], title: input["title"], type: input["notification_type"] }),
  Elicitation: (input) => ({ id: input["elicitation_id"], server: input["mcp_server_name"], text: input["message"], mode: input["mode"], url: input["url"], schema: input["requested_schema"] }),
  ElicitationResponse: (input) => ({ id: input["elicitation_id"], server: input["mcp_server_name"], mode: input["mode"], action: input["action"], content: input["content"] }),
  PermissionRequest: (input) => ({ name: input["tool_name"], input: recordOf(input["tool_input"]), suggestions: input["permission_suggestions"] ?? [], mcpServer: mcpServerOf(input["mcp_server"]) }),
  PermissionDenial: (input) => ({ name: input["tool_name"], input: recordOf(input["tool_input"]), callId: input["tool_use_id"], reason: input["reason"], mcpServer: mcpServerOf(input["mcp_server"]) }),
  ToolBatch: (input) => ({
    calls: (Array.isArray(input["tool_calls"]) ? input["tool_calls"] : []).map((call) => {
      const fields = recordOf(call);
      return defined({ callId: fields["tool_use_id"], name: fields["tool_name"], input: recordOf(fields["tool_input"]), output: fields["tool_response"] });
    })
  }),
  TodoCreate: todoOf,
  TodoComplete: todoOf,
  ReplyDisplay: (input) => ({ replyId: input["message_id"], index: input["index"], isLast: input["final"], text: input["delta"] })
};
async function spawnTask(claude, task, forkedFrom) {
  if (task.title.trim() === "")
    throw new Error("a task needs a title.");
  const { name, agentType, model, cwd } = forkedFrom === undefined ? task : { prompt: task.prompt, title: task.title, agentType: forkAgentType };
  const started = await claude.agent.spawn({
    prompt: task.prompt,
    description: task.title,
    ...name === undefined ? {} : { name },
    ...agentType === undefined ? {} : { subagentType: agentType },
    ...model === undefined ? {} : { model },
    ...cwd === undefined ? {} : { cwd }
  });
  if (started.deny !== undefined)
    throw new Error(`Claude Code refused the task: ${started.deny}`);
  if (started.agentId === undefined)
    throw new Error("Claude Code answered without starting a task.");
  return { id: started.agentId, title: task.title, ...forkedFrom === undefined ? { agentType: agentType ?? "general-purpose" } : { forkedFrom }, model: started.model, openedBy: "", openedAt: new Date().toISOString() };
}
function processPayloadOf(named, input) {
  const fields = recordOf(input);
  return { ...placementOf(fields), ...defined(processFields[named](fields)) };
}
function hookAnswerOf(name, named, answer) {
  const refuse = typeof answer["refuse"] === "string" ? answer["refuse"] : undefined;
  const note = typeof answer["note"] === "string" ? [modNote(name, answer["note"])] : undefined;
  if (named === "SessionStart")
    return defined({ additionalContext: note, sessionTitle: answer["title"], reloadSkills: answer["reloadSkills"] === true ? true : undefined, initialUserMessage: answer["firstPrompt"] });
  if (named === "ModelChange") {
    if (refuse !== undefined)
      return { permissionDecision: "deny", permissionDecisionReason: refuse };
    return typeof answer["ask"] === "string" ? { permissionDecision: "ask", permissionDecisionReason: answer["ask"] } : undefined;
  }
  if (named === "ProjectSetup")
    return defined({ additionalContext: note });
  if (named === "WorktreeCreate")
    return defined({ worktreePath: answer["result"] });
  if (named === "PermissionDenial")
    return answer["retry"] === true ? { retry: true } : undefined;
  if (named === "ToolBatch")
    return defined({ additionalContext: note });
  if (named === "ReplyDisplay")
    return defined({ displayContent: answer["text"] });
  return refuse === undefined ? undefined : { block: refuse };
}
function resultOf(where, call, answered) {
  const base = { id: "", type: ToolResult, at: new Date().toISOString(), session: where.session, context: where.context, ...where.turn === undefined ? {} : { turn: where.turn.prompt.id }, callId: "", name: call.name, input: call.input, cwd: call.cwd, files: noFiles };
  if (answered.deny !== undefined)
    return { ...base, output: answered.deny, isError: true };
  return { ...base, output: answered.result ?? answered.text, isError: answered.isError === true };
}
function searchOptionsOf({ running, since, everyProject, before }) {
  return {
    ...running === undefined ? {} : { running },
    ...since === undefined ? {} : { since },
    ...everyProject === undefined ? {} : { everyProject },
    ...before === undefined ? {} : { before: { session: before.session, id: before.id } }
  };
}

// node_modules/@cmodjs/core/runtime/conversations.js
var relayKinds = new Set(["act", "before", "answer", "watch", "goal", "taskEnd"]);
var taskVariable = "CMOD_TASK";
var isRelay = (value) => isObject(value) && relayKinds.has(value["kind"]);
var bufferedTaskRows = 200;
var beforeDeadlineMs = 5000;
var awayFoldMs = 8000;
var livenessMs = 5000;
var keptClosings = 200;
var keptMessages = 200;
var noWatches = "[]";
function serveConversations({ claude, router, store, project, report, clear }) {
  const folder = dataFolder(store, cmodPluginName);
  const goals = `${folder}/goals`;
  const backgroundTasks = `${folder}/tasks`;
  const watches = `${folder}/before`;
  const listeners = `${folder}/listeners`;
  const heard = new Map;
  const subscribed = new Map;
  let listenerFiles = Promise.resolve();
  const asked = new Map;
  const ownWatches = new Map;
  let watchers = [];
  let watching = Promise.resolve();
  let hasReadWatchers = false;
  let published = new Set;
  let publishing = Promise.resolve();
  let session = "";
  const left = new Set;
  let asks = 0;
  let conversation = createConversation(emptyConversation(""));
  let starting = Promise.resolve();
  let live = [];
  const liveIds = new Set;
  const waitingRows = new Map;
  let follower;
  const engineTurns = new Map;
  router.add("turn.start", async (e, next) => {
    const agent = e.agentId ?? "";
    engineTurns.set(agent, e.turnId);
    return next(e);
  });
  const endTurn = (ending, task) => (below, isInterrupted = false) => {
    if (below.block !== undefined)
      return below;
    engineTurns.delete(task ?? "");
    if (!isInterrupted)
      dispatch(session, conversation.endTurn(new Date().toISOString(), ending, task));
    return below;
  };
  router.add("classic.Stop", async (e, next) => endTurn({ reason: "answer", ...e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message } })(await next(e), next.signal.aborted));
  router.add("classic.StopFailure", async (e, next) => endTurn({ reason: "error", failure: { type: String(e.error), text: e.error_details ?? e.last_assistant_message ?? String(e.error) } })(await next(e)));
  router.add("classic.SubagentStop", async (e, next) => endTurn({ reason: "answer", ...e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message } }, e.agent_id)(await next(e), next.signal.aborted));
  router.add("classic.Stop", async (e, next) => {
    const below = await next(e);
    if (below.block === undefined && !next.signal.aborted)
      answerTask().catch((error) => report("task", "Could not record that this session answered its task", error));
    return below;
  });
  const json = async (args) => JSON.parse(await runCmod(claude, [...args, "--json", "--project", project()], await claude.session.id()));
  const ended = (id) => new Error(`session ${id} has ended`);
  const isRunning = async (id) => (await json(["history", "sessions", "--running", "--all"])).some((each) => each.id === id);
  let color = { session: "" };
  let onColor = () => {
    return;
  };
  const recolor = (id, picked) => {
    if (session !== id)
      return;
    color = { session: id, ...picked === undefined ? {} : { color: picked } };
    onColor(color);
  };
  const readColor = (id) => void json(["history", "sessions", "--running", "--all"]).then((running) => recolor(id, running.find((each) => each.id === id)?.color)).catch((error) => report("color", `Could not read the color of session ${id}`, error));
  router.add("command.run", async (e, next) => {
    const answer = await next(e);
    if (e.command !== "color" || session === "")
      return answer;
    if (e.args.trim() === "")
      readColor(session);
    else
      recolor(session, pickedColor(e.args));
    return answer;
  });
  let lastTurn;
  const closings = new Map;
  const dispatch = (to, changes, isInProject = true) => {
    for (const change of changes) {
      if (to === session && (change.type === TurnStart || change.type === TurnEnd2) && change.turn.prompt.task === undefined)
        lastTurn = change.turn;
      if (change.type === Message && !liveIds.has(change.message.id) && to === session) {
        live.push(change.message);
        liveIds.add(change.message.id);
        if (live.length > keptMessages)
          liveIds.delete(live.shift()?.id ?? "");
      }
      for (const [mod, sessions] of heard) {
        const subscriptions = [...sessions.get(to) ?? [], ...isInProject ? sessions.get(everySession) ?? [] : []];
        if (!subscriptions.some(({ event, matcher }) => isHeardBy(event, matcher, change)))
          continue;
        claude.cmod.call({ to: mod, method: conversationMethods.changed, input: { session: to, change, isInProject } }).then(() => clear(`changed:${mod}`), (error) => isNotInstalled(mod, error) ? forgetListeners(mod) : report(`changed:${mod}`, `Could not tell ${mod} about session ${to}`, error));
      }
    }
  };
  const restartFollower = async () => {
    if (session === "")
      return;
    const wantsEvery = [...heard.values()].some((sessions) => (sessions.get(everySession) ?? []).length > 0);
    const named = [...heard.values()].flatMap((sessions) => [...sessions].filter(([id, list]) => id !== session && id !== everySession && list.length > 0).map(([id]) => id));
    const others = [...new Set(named)].sort();
    const args = [...others, ...wantsEvery ? ["--running"] : []];
    const wanted = [session, project(), ...args].join(" ");
    if (follower?.sessions === wanted)
      return;
    follower?.stop();
    follower = undefined;
    if (args.length === 0)
      return;
    const version = newestCmodVersion(claude);
    const stream = spawnCmod(claude, ["history", "follow", ...args, "--json", "--project", project()], session);
    const started = { sessions: wanted, stop: () => void stream.return(undefined) };
    follower = started;
    const followed = readLines(stream, (line) => {
      if (line.trim() === "")
        return;
      const parsed = JSON.parse(line);
      dispatch(parsed.session, [parsed.change], parsed.isInProject);
    });
    Promise.all([version, followed]).then(([, { code, lastError }]) => {
      if (follower === started)
        throw new Error(`cmod history follow ${formatExit(code, lastError)}`);
    }).catch(async (error) => {
      if (follower !== started)
        return;
      follower = undefined;
      started.stop();
      if (await newestCmodVersion(claude) === await version)
        throw error;
      follow();
    }).catch((error) => report("follow", "Stopped hearing the other sessions", error));
  };
  const follow = () => void restartFollower().catch((error) => report("follow", "Stopped hearing the other sessions", error));
  const post = async (to, relay) => {
    const sent = await claude.session.send({ to: { sessionId: to }, text: `<cmod-relay>${JSON.stringify(relay)}</cmod-relay>` });
    if (sent.isDelivered !== true)
      throw ended(to);
  };
  const waitingOn = new Map;
  let liveness;
  let isChecking = false;
  const checkLiveness = async () => {
    if (isChecking)
      return;
    isChecking = true;
    try {
      const waiting = [...waitingOn];
      const running = new Set((await json(["history", "sessions", "--running", "--all"])).map((each) => each.id));
      for (const [settle, to] of waiting)
        if (!running.has(to))
          settle.reject(ended(to));
    } finally {
      isChecking = false;
    }
  };
  const watchLife = (settle, to) => {
    waitingOn.set(settle, to);
    liveness ??= claude.clock.every(livenessMs, () => void checkLiveness().catch((error) => report("liveness", "Could not check which sessions still run", error)));
    return {
      cancel() {
        waitingOn.delete(settle);
        if (waitingOn.size > 0)
          return;
        liveness?.cancel();
        liveness = undefined;
      }
    };
  };
  const ask = (to, relay, deadlineMs) => new Promise((resolve, reject) => {
    const id = `${session}:${asks += 1}`;
    const settle = {
      resolve(value) {
        if (asked.delete(id))
          timer.cancel();
        resolve(value);
      },
      reject(error) {
        if (asked.delete(id))
          timer.cancel();
        reject(error);
      }
    };
    const timer = deadlineMs === undefined ? watchLife(settle, to) : claude.clock.after(deadlineMs, () => settle.reject(new PassedTimeout(`session ${to} did not answer within ${deadlineMs / 1000} s`)));
    asked.set(id, settle);
    post(to, { ...relay, id, from: session }).catch((error) => settle.reject(error instanceof Error ? error : new Error(messageOf(error))));
  });
  const publishWatches = (isEnding = false) => {
    const next = publishing.then(() => publishNow(isEnding));
    publishing = next.catch((error) => claude.ui.warn("before:publish", `cmod: publishing before listeners failed: ${messageOf(error)}`));
    return next;
  };
  const publishNow = async (isEnding) => {
    if (session === "")
      return;
    const at = session;
    const list = await onListenerFiles(async () => {
      const kept = isEnding ? [] : [...ownWatches.values()].filter((watch) => watch.events.length > 0);
      await claude.fs.write(`${watches}/${at}.json`, JSON.stringify(kept));
      return kept;
    });
    const targets = new Set([...published, ...list.map((watch) => watch.target)]);
    published = new Set(list.map((watch) => watch.target));
    const running = targets.has(everySession) ? (await json(["history", "sessions", "--running"])).map((each) => each.id) : [];
    const told = new Set([...running, ...targets].filter((id) => id !== everySession && id !== session && !left.has(id)));
    await Promise.all([...told].map((id) => post(id, { kind: "watch" }).catch((error) => {
      if (messageOf(error) !== ended(id).message)
        claude.ui.warn("before:tell", `cmod: session ${id} did not hear of a before listener: ${messageOf(error)}`);
    })));
  };
  const hear = (caller, id, list) => {
    const sessions = heard.get(caller) ?? new Map;
    sessions.set(id, list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })));
    heard.set(caller, sessions);
    const lists = subscribed.get(caller) ?? new Map;
    lists.set(id, list);
    subscribed.set(caller, lists);
  };
  const forgetListeners = (mod) => {
    if (!heard.delete(mod))
      return;
    subscribed.delete(mod);
    clear(`changed:${mod}`);
    follow();
    saveListeners().catch((error) => report("listeners", `Kept the listeners of ${mod}, which left this session`, error));
  };
  const onListenerFiles = (work) => {
    const next = listenerFiles.then(work);
    listenerFiles = next.catch((error) => claude.ui.warn("listeners:files", `cmod: reading or writing the mods' listeners failed: ${messageOf(error)}`));
    return next;
  };
  const clearListeners = (at) => onListenerFiles(() => claude.fs.write(`${listeners}/${at}.json`, "{}"));
  const clearWatches = (at) => onListenerFiles(() => claude.fs.write(`${watches}/${at}.json`, noWatches));
  const saveListeners = (isEnding = false) => {
    const at = session;
    if (at === "")
      return Promise.resolve();
    if (isEnding)
      return clearListeners(at);
    return onListenerFiles(() => claude.fs.write(`${listeners}/${at}.json`, JSON.stringify(Object.fromEntries([...subscribed].map(([caller, lists]) => [caller, Object.fromEntries(lists)])))));
  };
  const restoreListeners = () => {
    const at = session;
    return onListenerFiles(async () => {
      const kept = JSON.parse(await claude.fs.read(`${listeners}/${at}.json`).catch(ifMissing("{}")));
      for (const [caller, lists] of Object.entries(kept))
        if (!subscribed.has(caller))
          for (const [id, list] of Object.entries(lists))
            hear(caller, id, list);
    });
  };
  const readWatchers = () => onListenerFiles(async () => {
    const files = (await claude.fs.list(watches).catch(ifMissing([]))).filter((file) => file.name.endsWith(".json") && file.size !== noWatches.length);
    const texts = await Promise.all(files.map((file) => claude.fs.read(`${watches}/${file.name}`).catch(ifMissing(noWatches))));
    const found = [];
    for (const [index, file] of files.entries()) {
      const from = file.name.replace(/\.json$/, "");
      if (left.has(from))
        continue;
      const text = texts[index] ?? noWatches;
      let list;
      try {
        list = JSON.parse(text);
      } catch (error) {
        if (from === session || !(error instanceof SyntaxError))
          throw error;
        claude.ui.warn("before:read", `cmod: session ${from} was writing its before listeners, so it keeps the ones from before until it relays that it changed them`);
        found.push(...watchers.filter((watch) => watch.from === from));
        continue;
      }
      if (from === session) {
        for (const watch of list)
          if (!ownWatches.has(`${watch.mod}
${watch.target}`))
            ownWatches.set(`${watch.mod}
${watch.target}`, watch);
        continue;
      }
      found.push(...list.filter((watch) => watch.target === session || watch.target === everySession && watch.project === project()).map((watch) => ({ ...watch, from })));
    }
    watchers = found;
  });
  const changeGoal = (task, text) => dispatch(session, task === undefined ? conversation.changeGoal(text) : [{ type: GoalChange, goal: { text, task } }]);
  const reloadWatchers = () => {
    watching = readWatchers().catch((error) => report("before", "Kept the other sessions’ before listeners from before", error));
  };
  const place = () => {
    const { context, contextOpenedAt, turn, tasks, taskTurns, openCalls } = conversation.state;
    return { session, context, contextOpenedAt, ...turn === undefined ? {} : { turn }, tasks, taskTurns, ...openCalls === undefined ? {} : { openCalls } };
  };
  const deciders = (event) => {
    const all = [...[...ownWatches.values()].filter((watch) => watch.target === session || watch.target === everySession).map((watch) => ({ ...watch, from: session })), ...watchers];
    return [...new Map(all.filter((watcher) => watcher.events.includes(event)).map((watcher) => [`${watcher.from}
${watcher.mod}`, watcher])).values()];
  };
  const askHere = async (mod, event, change, from = session, isInProject = true) => claude.cmod.call({ to: mod, method: conversationMethods.before, input: { session: from, event, change, isInProject } }).catch((error) => {
    if (!isNotInstalled(mod, error))
      throw error;
    forgetWatches(mod);
    return;
  });
  const forgetWatches = (mod) => {
    const left = [...ownWatches].filter(([, watch]) => watch.mod === mod);
    if (left.length === 0)
      return;
    for (const [key] of left)
      ownWatches.delete(key);
    publishWatches().catch((error) => report("before", `Kept the before listeners of ${mod}, which left this session`, error));
  };
  const isUnderHere = (task, ancestor) => {
    for (let at = task, steps = 0;at !== undefined && steps < 64; at = conversation.state.tasks[at]?.parent, steps += 1)
      if (at === ancestor)
        return true;
    return false;
  };
  const refuses = (watcher, event, change) => beforeAnswerKeys[event].includes("refuse") && (watcher.refusing ?? []).some(({ event: heard, matcher, scope }) => change === undefined ? heard === event : isInScope(scope ?? {}, session, change, isUnderHere) && isHeardBy(heard, matcher === undefined ? undefined : receivedMatcher(matcher), change));
  const askAway = async (watcher, event, change, endsAt) => {
    try {
      const leftMs = Math.min(beforeDeadlineMs, endsAt - await claude.clock.now());
      if (leftMs <= 0)
        throw new PassedTimeout(`the ${awayFoldMs / 1000} s cmod waits on other sessions ran out before session ${watcher.from} was asked`);
      return await ask(watcher.from, { kind: "before", mod: watcher.mod, event, change, project: project() }, leftMs);
    } catch (error) {
      if (isNotInstalled(watcher.mod, error)) {
        watchers = watchers.filter((each) => each.from !== watcher.from || each.mod !== watcher.mod);
        return;
      }
      if (await isRunning(watcher.from)) {
        if (error instanceof PassedTimeout && refuses(watcher, event, change))
          return { refuse: `${watcher.mod}: ${error.message}` };
        throw error;
      }
      watchers = watchers.filter((each) => each.from !== watcher.from);
      claude.ui.warn("before:ended", `cmod: session ${watcher.from} ended without clearing its before listeners, so they are cleared now`);
      await clearWatches(watcher.from);
      return;
    }
  };
  const wants = async (event) => {
    await watching;
    return deciders(event).length > 0;
  };
  const failedBefore = (event, change, error) => {
    if (!hasReadWatchers)
      return { refuse: `${cmodPluginName}: ${error.message}` };
    const changed = change(place());
    const refusing = deciders(event).find((watcher) => refuses(watcher, event, changed));
    return refusing === undefined ? undefined : { refuse: `${refusing.mod}: ${error.message}` };
  };
  const decide = (cancel) => {
    let endsAt;
    return (event, change) => foldBefore(event, change, deciders(event).map((watcher) => async (latest) => {
      if (cancel?.aborted === true)
        return;
      if (watcher.from === session)
        return askHere(watcher.mod, event, latest);
      endsAt ??= claude.clock.now().then((now) => now + awayFoldMs);
      return askAway(watcher, event, latest, await endsAt);
    }), (error) => {
      if (cancel?.aborted !== true)
        report(`before:${event}`, `Passed the ${event} on without a mod's answer`, error);
    });
  };
  const recordCompaction = async (e, next) => {
    const compacted = await next(e);
    if (e.trigger === "precompute" || compacted.skip !== undefined || session === "")
      return compacted;
    const at = new Date().toISOString();
    const boundary = { id: `compact:${e.agentId ?? session}:${at}`, at, type: "system", name: "compact_boundary", isMeta: false, isSummary: false, content: [] };
    take(boundary, e.agentId).catch((error) => report("compact", "Missed a compaction", error));
    return compacted;
  };
  router.add("session.compact", recordCompaction, (e, _error, next) => recordCompaction(e, next));
  installBefore({
    claude,
    router,
    hooks: {
      place: async () => {
        await starting;
        return place();
      },
      wants,
      fold: decide,
      failedBefore
    }
  });
  const start = (id, source) => {
    if (id === session)
      return;
    const previous = session;
    if (previous !== "")
      left.add(previous);
    left.delete(id);
    session = id;
    live = [];
    liveIds.clear();
    waitingRows.clear();
    conversation = createConversation(emptyConversation(id));
    const isNew = source === "startup" || source === "clear";
    if (!isNew)
      readColor(id);
    starting = isNew ? Promise.resolve(dispatch(id, conversation.startContext(new Date().toISOString()))) : json(["history", "state", id]).then((state) => {
      if (session === id)
        conversation = createConversation({ ...emptyConversation(id), ...state });
    }, (error) => report("state", `Starts session ${id} without its earlier turns`, error));
    const restored = restoreListeners().catch((error) => report("listeners", "Could not read back the mods' listeners of this session", error)).then(follow);
    starting = Promise.all([starting, restored]).then(() => {
      return;
    });
    reloadWatchers();
    hasReadWatchers = false;
    watching.then(() => {
      if (session === id)
        hasReadWatchers = true;
    });
    if (subscribed.size > 0)
      Promise.all([previous === "" ? undefined : clearListeners(previous), saveListeners()]).catch((error) => report("follow", "Kept telling the mods about the session from before", error));
    if (ownWatches.size === 0)
      return;
    Promise.all([previous === "" ? undefined : clearWatches(previous), publishWatches()]).catch((error) => report("before", "Kept its before listeners on the session from before", error));
  };
  const take = async (row, task) => {
    await starting;
    if (task !== undefined && conversation.state.tasks[task] === undefined) {
      const waiting = waitingRows.get(task) ?? [];
      waiting.push(row);
      waitingRows.set(task, waiting);
      if (waiting.length < bufferedTaskRows)
        return;
      waitingRows.delete(task);
      dispatch(session, conversation.startTask({ id: task, title: "", agentType: "general-purpose", openedBy: "", openedAt: row.at }));
      for (const each of waiting)
        dispatch(session, conversation.add(each, task));
      return;
    }
    dispatch(session, conversation.add(row, task));
    if (task !== undefined || row.type !== "system" || row.name !== "turn_duration" || lastTurn === undefined)
      return;
    closings.set(row.id, lastTurn);
    if (closings.size > keptClosings)
      closings.delete(closings.keys().next().value);
  };
  router.add("classic.SessionStart", async (e, next) => {
    start(e.session_id, e.source);
    return next(e);
  });
  router.add("classic.SessionEnd", async (e, next) => {
    if (ownWatches.size > 0)
      await publishWatches(true).catch((error) => report("before", "Left its before listeners registered", error));
    if (subscribed.size > 0)
      await saveListeners(true).catch((error) => report("follow", "Left its listeners registered", error));
    return next(e);
  });
  const recordAppend = async (e, next) => {
    const kept = await next(e);
    if (kept.deny !== undefined || session === "")
      return kept;
    const cwd = e.message.type === "assistant" ? await claude.session.cwd() : "";
    take(rowOfAppend({ uuid: kept.uuid, door: e.door, origin: e.origin, message: kept.message }, new Date().toISOString(), cwd), e.agentId).catch((error) => report("append", "Missed a message", error));
    return kept;
  };
  router.add("session.append", recordAppend, (e, _error, next) => recordAppend(e, next));
  router.add("session.measure", async (e, next) => {
    const measured = await next(e);
    if (session !== "")
      dispatch(session, [{ type: UsageChange, usage: await usageOf(claude) }]);
    return measured;
  });
  const recordSpawn = async (e, next) => {
    const spawned = await next(e);
    if (spawned.deny !== undefined || spawned.agentId === undefined)
      return spawned;
    const id = spawned.agentId;
    await starting;
    const opened = { id, title: e.description, ...ownerOfSpawn(e.subagentType, session), model: spawned.model, openedBy: e.tool_use_id, openedAt: new Date().toISOString(), ...e.parentAgentId === undefined ? {} : { parent: e.parentAgentId } };
    dispatch(session, conversation.startTask(opened));
    const waiting = waitingRows.get(id) ?? [];
    waitingRows.delete(id);
    for (const row of waiting)
      dispatch(session, conversation.add(row, id));
    return spawned;
  };
  router.add("agent.spawn", recordSpawn, (e, _error, next) => recordSpawn(e, next));
  router.add("session.receive", async (e, next) => {
    const sent = relayOf(e);
    if (sent === undefined)
      return next(e);
    const relay = JSON.parse(sent);
    claude.clock.after(0, () => void (isRelay(relay) ? received(relay) : refuse(relay)).catch((error) => report("relay", "Could not answer another session", error)));
    return { consumed: "cmod relay" };
  });
  const unknownTo = async (what) => new Error(`Session ${await claude.session.id()} runs cmod ${coreVersion}, which has no ${what}.`);
  const refuse = async (relay) => {
    if (!isObject(relay) || typeof relay["id"] !== "string" || typeof relay["from"] !== "string")
      return;
    await post(relay["from"], { kind: "answer", id: relay["id"], deny: (await unknownTo(`"${String(relay["kind"])}" relay`)).message });
  };
  const received = async (relay) => {
    if (relay.kind === "answer") {
      const waiting = asked.get(relay.id);
      if (relay.deny === undefined)
        waiting?.resolve(relay.value);
      else
        waiting?.reject(new Error(relay.deny));
      return;
    }
    if (relay.kind === "watch")
      return readWatchers();
    if (relay.kind === "goal") {
      await starting;
      changeGoal(relay.task, relay.text);
      return;
    }
    if (relay.kind === "taskEnd") {
      await starting;
      dispatch(session, conversation.endTask(relay.task, relay.task.closedAt ?? new Date().toISOString()));
      return;
    }
    const answered = async (run) => {
      try {
        await post(relay.from, { kind: "answer", id: relay.id, value: await run() ?? null });
      } catch (error) {
        await post(relay.from, { kind: "answer", id: relay.id, deny: messageOf(error) });
      }
    };
    if (relay.kind === "act")
      return answered(async () => isAct(relay.action) ? perform(relay.caller, relay.action, relay.input, relay.task) : Promise.reject(await unknownTo(`"${String(relay.action)}" action`)));
    return answered(() => askHere(relay.mod, relay.event, relay.change, relay.from, relay.project === project()));
  };
  const perform = async (caller, action, input, task) => {
    await starting;
    if (action === "abort")
      return abortTurn(input, task);
    if (task !== undefined)
      return performInTask(caller, action, input, task);
    if (action === "usage")
      return usageOf(claude);
    if (action === "surfaces")
      return [...await claude.session.surfaces()];
    if (action === "send") {
      const { type, text, as } = input;
      if (as === Session)
        throw new Error(`session ${session} cannot send as itself to itself.`);
      const delivered = type === Note ? await claude.session.append({ message: { type: "user", content: [{ type: "text", text: modNote(caller, text) }] } }) : await claude.prompt.submit({ text, ...as === Person ? { asUser: true } : {} });
      if ("deny" in delivered && typeof delivered.deny === "string")
        throw new Error(`Claude Code refused the note: ${delivered.deny}`);
      if ("drop" in delivered && typeof delivered.drop === "string")
        throw new Error(`Claude Code dropped the prompt: ${delivered.drop}`);
      return null;
    }
    if (action === "startTask")
      return spawnTask(claude, input);
    if (action === "fork")
      return spawnTask(claude, input, session);
    if (action === "startBackgroundTask")
      return startBackground(input);
    if (action === "clone")
      return startBackground(input, session);
    const { name, input: toolInput } = input;
    return resultOf(place(), { name, input: toolInput, cwd: await claude.session.cwd() }, await claude.tool.call({ ...toolInput, tool: name }));
  };
  const abortTurn = async (input, task) => {
    const turnId = engineTurns.get(task ?? "");
    if (turnId === undefined)
      throw new Error(`no turn is running in ${task === undefined ? `session ${session}` : `task ${task}`}.`);
    const asked = isObject(input) ? input["turn"] : undefined;
    const open = task === undefined ? conversation.state.turn : conversation.state.taskTurns[task];
    if (open?.prompt.id !== asked)
      throw new Error(`turn ${String(asked)} has ended, so there is nothing to abort.`);
    await claude.turn.abort({ turnId });
    return null;
  };
  const performInTask = async (caller, action, input, task) => {
    const running = conversation.state.tasks[task];
    if (action === "usage")
      return json(["history", "usage", session, "--task", task]);
    if (action === "surfaces")
      return running === undefined || running.closedAt !== undefined ? [] : [...await claude.session.surfaces()];
    if (action !== "send")
      throw new Error(`cmod: ${action} runs only on a session's own main loop.`);
    if (running === undefined || running.closedAt !== undefined)
      throw ended(task);
    const { type, text } = input;
    const sent = await claude.session.send({ to: { agentId: task }, text: type === Note ? modNote(caller, text) : text });
    if (sent.isDelivered !== true)
      throw ended(task);
    return null;
  };
  const startBackground = async (task, forkedFrom) => {
    if (task.title.trim() === "")
      throw new Error("a task needs a title.");
    if (task.name !== undefined)
      throw new Error("a background task takes no name.");
    const fresh = forkedFrom === undefined ? task : {};
    const asked = { id: "", title: task.title, ...forkedFrom === undefined ? {} : { forkedFrom }, ...fresh.agentType === undefined ? {} : { agentType: fresh.agentType }, ...fresh.model === undefined ? {} : { model: fresh.model }, openedBy: "", openedAt: new Date().toISOString(), isBackground: true };
    const answer = await wants(TaskStart) ? await decide()(TaskStart, { type: TaskStart, task: { ...asked, context: conversation.state.context } }) : undefined;
    if (answer?.refuse !== undefined)
      throw new Error(`a beforeTaskStart listener refused the task: ${answer.refuse}`);
    const owner = forkedFrom === undefined ? answer?.owner ?? {} : {};
    const folder = owner.cwd ?? fresh.cwd;
    const here = await claude.session.cwd();
    const args = [
      "task",
      "start",
      "--title",
      answer?.title ?? task.title,
      ...forkedFrom === undefined ? [] : ["--clone"],
      ...textArg("--agent", owner.agentType ?? fresh.agentType),
      ...textArg("--model", owner.model ?? fresh.model),
      "--cwd",
      folder === undefined ? here : ve(here, folder),
      "--json",
      "--",
      answer?.prompt ?? task.prompt
    ];
    const started = JSON.parse(await runCmod(claude, args, session));
    dispatch(session, conversation.startTask(started));
    return started;
  };
  const answerTask = async () => {
    const { env } = await claude.settings.read();
    const asked = isObject(env) ? env[taskVariable] : undefined;
    if (typeof asked !== "string")
      return;
    const answered = `cmod:task-answered:${session}`;
    if (await claude.store.get(answered) === true)
      return;
    await claude.store.set(answered, true);
    const { session: from, ...task } = JSON.parse(asked);
    const ended = { ...task, id: session, closedAt: new Date().toISOString() };
    await claude.fs.write(`${backgroundTasks}/${from}/${session}.json`, JSON.stringify(ended));
    await post(from, { kind: "taskEnd", task: ended }).catch((error) => claude.ui.warn("task:answered", `cmod: session ${from} did not hear that its task ${session} answered: ${messageOf(error)}`));
  };
  const actElsewhere = async (caller, target, action, input, task) => {
    const isLive = await isRunning(target);
    if (!isLive && action === "usage")
      return json(["history", "usage", target, ...task === undefined ? [] : ["--task", task]]);
    if (!isLive && action === "surfaces")
      return [];
    if (!isLive)
      throw ended(task ?? target);
    if (action === "send" && task === undefined && input.as === Session) {
      const sent = await claude.session.send({ to: { sessionId: target }, text: input.text });
      if (sent.isDelivered !== true)
        throw ended(target);
      return null;
    }
    return ask(target, { kind: "act", caller, action, input, ...task === undefined ? {} : { task } });
  };
  const merged = (saved, kept, key) => {
    const keptKeys = new Set(kept.map(key));
    return [...saved.filter((item) => !keptKeys.has(key(item))), ...kept];
  };
  const liveTurns = (task) => {
    const turn = typeof task === "string" ? conversation.state.taskTurns[task] : conversation.state.turn;
    return turn === undefined ? [] : [turn];
  };
  const liveTasks = () => Object.values(conversation.state.tasks).map((task) => ({
    id: task.id,
    title: task.title,
    ...task.agentType === undefined ? {} : { agentType: task.agentType },
    ...task.model === undefined ? {} : { model: task.model },
    openedBy: task.openedBy,
    openedAt: task.openedAt,
    ...task.closedAt === undefined ? {} : { closedAt: task.closedAt },
    ...task.parent === undefined ? {} : { parent: task.parent },
    ...task.forkedFrom === undefined ? {} : { forkedFrom: task.forkedFrom },
    ...task.isBackground === true ? { isBackground: true } : {}
  }));
  const liveContext = (task) => {
    if (typeof task === "string") {
      const running = conversation.state.tasks[task];
      return running === undefined ? [] : [{ number: running.context, openedAt: running.contextOpenedAt ?? running.openedAt, task, ...running.closedAt === undefined ? {} : { closedAt: running.closedAt } }];
    }
    const { context, contextOpenedAt } = conversation.state;
    return context === 0 ? [] : [{ number: context, openedAt: contextOpenedAt }];
  };
  const lastOf = (items, last) => typeof last === "number" ? items.slice(-last) : [...items];
  const isHeld = (kept, last) => typeof last === "number" && kept.length >= last;
  const methods = {
    async[conversationMethods.sessions](request) {
      const found = await json(["history", "sessions", ...scopeArgs(request), ...request["running"] === true ? ["--running"] : []]);
      return found.map((each) => each.id === session ? { ...each, isRunning: true } : each);
    },
    async[conversationMethods.search](request) {
      const before = isObject(request["before"]) ? request["before"] : undefined;
      const record = [...textArg("--session", request["session"]), ...textArg("--task", request["task"]), ...textArg("--turn", request["turn"]), ...countArg("--context", request["context"]), ...request["isAgent"] === true ? ["--agent"] : []];
      return json(["history", "search", String(request["text"]), ...scopeArgs(request), ...record, ...request["running"] === true ? ["--running"] : [], ...before === undefined ? [] : ["--before", `${String(before["session"])}:${String(before["id"])}`]]);
    },
    async[conversationMethods.messages](request) {
      const id = String(request["session"]);
      const filters = [...textArg("--turn", request["turn"]), ...textArg("--task", request["task"]), ...textArg("--after", request["after"])];
      const saved = () => json(["history", "messages", id, ...filters, ...countArg("--last", request["last"])]);
      if (id !== session)
        return saved();
      await starting;
      const fits = (message) => (request["turn"] === undefined || message.turn === request["turn"]) && message.task === request["task"];
      const after = typeof request["after"] === "string" ? live.findIndex((message) => message.id === request["after"]) : -1;
      const kept = live.slice(after + 1).filter(fits);
      if (after >= 0 || isHeld(kept, request["last"]))
        return lastOf(kept, request["last"]);
      return lastOf(merged(await saved(), kept, (message) => message.id), request["last"]);
    },
    async[conversationMethods.turns](request) {
      const id = String(request["session"]);
      const saved = () => json(["history", "turns", id, ...textArg("--task", request["task"]), ...countArg("--context", request["context"]), ...countArg("--last", request["last"])]);
      if (id !== session)
        return saved();
      await starting;
      const kept = liveTurns(request["task"]).filter((turn) => request["context"] === undefined || turn.context === request["context"]);
      if (isHeld(kept, request["last"]))
        return lastOf(kept, request["last"]);
      return lastOf(merged(await saved(), kept, (turn) => turn.prompt.id), request["last"]);
    },
    async[conversationMethods.contexts](request) {
      const id = String(request["session"]);
      const saved = await json(["history", "contexts", id, ...textArg("--task", request["task"])]).catch((error) => {
        if (id === session && typeof request["task"] === "string")
          return [];
        throw error;
      });
      if (id !== session)
        return saved;
      await starting;
      return merged(saved, liveContext(request["task"]), (context) => String(context.number));
    },
    async[conversationMethods.tasks](request) {
      const id = String(request["session"]);
      const isNested = request["all"] === true;
      const saved = await json(["history", "tasks", id, ...isNested ? ["--nested"] : textArg("--task", request["task"])]);
      if (id !== session)
        return saved;
      await starting;
      const kept = liveTasks().filter((task) => isNested || task.parent === request["task"]);
      const running = await claude.agent.list().catch((error) => (claude.ui.warn("tasks:status", `cmod: the tasks show no status, because Claude Code listed no agents: ${messageOf(error)}`), []));
      const background = saved.flatMap(({ id, status }) => status === undefined ? [] : [{ id, status }]);
      return tasksWithAgents(merged(saved, kept, (task) => task.id), [...running, ...background]);
    },
    async[conversationMethods.goal](request) {
      const id = String(request["session"]);
      const task = typeof request["task"] === "string" ? request["task"] : undefined;
      if (id === session && task === undefined) {
        await starting;
        const text = conversation.state.goal;
        if (text !== undefined)
          return { text };
      }
      return json(["history", "goal", id, ...textArg("--task", task)]);
    },
    async[conversationMethods.updateGoal](request) {
      const id = String(request["session"]);
      const task = typeof request["task"] === "string" ? request["task"] : undefined;
      const text = String(request["text"]);
      await claude.fs.write(`${goals}/${task ?? id}.txt`, text);
      await starting;
      if (id === session)
        changeGoal(task, text);
      else {
        dispatch(id, [{ type: GoalChange, goal: { text, ...task === undefined ? {} : { task } } }]);
        await post(id, { kind: "goal", ...task === undefined ? {} : { task }, text }).catch((error) => claude.ui.warn("goal:tell", `cmod: session ${id} keeps its goal until it starts again: ${messageOf(error)}`));
      }
      return null;
    },
    async[conversationMethods.subscribe](request, caller) {
      if (caller === undefined)
        throw new Error("cmod hears no caller for this subscription.");
      const id = String(request["session"]);
      const list = Array.isArray(request["subscriptions"]) ? request["subscriptions"] : [];
      hear(caller, id, list);
      follow();
      await saveListeners();
      return null;
    },
    async[conversationMethods.watchBefore](request, caller) {
      if (caller === undefined)
        throw new Error("cmod hears no caller for this before listener.");
      const target = String(request["session"]);
      const list = Array.isArray(request["subscriptions"]) ? request["subscriptions"] : [];
      ownWatches.set(`${caller}
${target}`, { mod: caller, target, project: project(), events: [...new Set(list.map(({ event }) => event))], refusing: list.filter((each) => each.onFailure === "refuse") });
      await publishWatches();
      return null;
    },
    async[conversationMethods.act](request, caller) {
      if (caller === undefined)
        throw new Error("cmod hears no caller for this action.");
      const target = String(request["session"]);
      const action = String(request["action"]);
      const task = typeof request["task"] === "string" ? request["task"] : undefined;
      if (!isAct(action))
        throw new Error(`cmod takes no action named ${action}.`);
      if (target === await claude.session.id())
        return perform(caller, action, request["input"], task);
      return actElsewhere(caller, target, action, request["input"], task);
    }
  };
  return {
    turnClosedBy: (rowId) => closings.get(rowId),
    color: () => color,
    onColor(listener) {
      onColor = listener;
    },
    moved() {
      for (const [key, watch] of ownWatches)
        ownWatches.set(key, { ...watch, project: project() });
      publishWatches().catch((error) => report("before", "Kept its before listeners on the project from before", error));
      reloadWatchers();
      follow();
    },
    async answer(e) {
      const method = methods[e.method];
      if (method === undefined)
        return;
      const input = isObject(e.input) ? e.input : {};
      try {
        return { value: await method(input, e.caller) };
      } catch (error) {
        return { deny: messageOf(error) };
      }
    }
  };
}
function scopeArgs(request) {
  return [...typeof request["since"] === "string" ? ["--since", request["since"]] : [], ...request["everyProject"] === true ? ["--all"] : []];
}
function countArg(flag, value) {
  return typeof value === "number" ? [flag, String(value)] : [];
}
function textArg(flag, value) {
  return typeof value === "string" ? [flag, value] : [];
}

// node_modules/@cmodjs/core/runtime/engine.js
var engines = new WeakMap;
function keepEngine(mod, engine) {
  engines.set(mod, engine);
}
function engineOf(mod) {
  const engine = engines.get(mod);
  if (engine === undefined)
    throw new Error("This mod has not started, so it reaches no Claude Code calls yet.");
  return engine;
}

// node_modules/@cmodjs/core/utils/metadata.js
class MetadataError extends Error {
  line;
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}
var markdown = ["md", "markdown", "mdx"];
var hashComments = ["sh", "bash", "zsh", "fish", "py", "rb", "pl", "r", "yaml", "yml", "toml", "ps1", "nu", "tcl", "mk", "conf", "cfg", "env"];
var slashComments = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "rs", "swift", "kt", "kts", "java", "c", "h", "cc", "cpp", "hpp", "cs", "scala", "dart", "zig", "jsonc", "json5"];
var dashComments = ["lua", "sql", "hs", "elm"];
var hashCommentNames = ["Makefile", "Dockerfile", "Brewfile", "Gemfile", "Rakefile", "Justfile", "justfile"];
var sidecarSuffix = ".meta";
function formatOf(path, firstLine) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (markdown.includes(extension))
    return { type: "frontmatter" };
  if (hashComments.includes(extension) || hashCommentNames.includes(name))
    return { type: "comment", prefix: "#" };
  if (slashComments.includes(extension))
    return { type: "comment", prefix: "//" };
  if (dashComments.includes(extension))
    return { type: "comment", prefix: "--" };
  if (extension === "" && firstLine?.startsWith("#!") === true)
    return { type: "comment", prefix: "#" };
  return { type: "sidecar" };
}
function readMetadata(text, format) {
  const lines = text.split(`
`);
  if (format.type === "comment") {
    const region = commentRegion(lines, format.prefix);
    return { metadata: region === undefined ? {} : asRecord(mapEntries(region.lines, region.start + 2, 0)) };
  }
  const region = format.type === "frontmatter" ? frontmatterRegion(lines) : { start: -1, end: lines.length, lines };
  if (region === undefined)
    return { metadata: {} };
  const block = metadataBlock(region);
  const name = format.type === "frontmatter" ? topLevelScalar(region, "name") : undefined;
  return { metadata: block === undefined ? {} : asRecord(block.entries), ...name === undefined ? {} : { name } };
}
function writeMetadata(text, format, metadata) {
  const lines = text.split(`
`);
  const entries = Object.entries(metadata);
  if (format.type === "comment") {
    const { prefix } = format;
    const block = entries.length === 0 ? [] : [`${prefix} /// metadata`, ...entries.map(([key, value]) => `${prefix} ${scalar(key)}: ${scalar(value)}`), `${prefix} ///`];
    const region = commentRegion(lines, prefix);
    if (region !== undefined)
      return [...lines.slice(0, region.start), ...block, ...lines.slice(region.end + 1)].join(`
`);
    if (block.length === 0)
      return text;
    const at = lines[0]?.startsWith("#!") === true ? 1 : 0;
    return [...lines.slice(0, at), ...block, ...lines.slice(at)].join(`
`);
  }
  const map = entries.length === 0 ? [] : ["metadata:", ...entries.map(([key, value]) => `  ${scalar(key)}: ${scalar(value)}`)];
  if (format.type === "sidecar") {
    const block = metadataBlock({ start: -1, end: lines.length, lines });
    const rest = block === undefined ? lines : [...lines.slice(0, block.start), ...lines.slice(block.end)];
    const kept = rest.join(`
`).trim();
    return [...kept === "" ? [] : [kept], ...map].join(`
`) + (map.length === 0 && kept === "" ? "" : `
`);
  }
  const region = frontmatterRegion(lines);
  if (region === undefined)
    return map.length === 0 ? text : ["---", ...map, "---", ...lines].join(`
`);
  const block = metadataBlock(region);
  const inner = block === undefined ? [...region.lines, ...map] : [...lines.slice(region.start + 1, block.start), ...map, ...lines.slice(block.end, region.end)];
  if (inner.every((line) => line.trim() === ""))
    return lines.slice(region.end + 1).join(`
`);
  return [...lines.slice(0, region.start + 1), ...inner, ...lines.slice(region.end)].join(`
`);
}
function frontmatterRegion(lines) {
  if (lines[0]?.replace(/^\uFEFF/, "").trimEnd() !== "---")
    return;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1)
    throw new MetadataError(1, "the frontmatter starts with --- and never ends. Close it with a --- line.");
  return { start: 0, end, lines: lines.slice(1, end) };
}
function commentRegion(lines, prefix) {
  const start = lines.findIndex((line) => line.trimEnd() === `${prefix} /// metadata`);
  if (start === -1)
    return;
  const content = [];
  for (let index = start + 1;index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trimEnd();
    if (line === `${prefix} ///`)
      return { start, end: index, lines: content };
    if (line !== prefix && !line.startsWith(`${prefix} `))
      break;
    content.push(line.slice(prefix.length + 1));
  }
  throw new MetadataError(start + 1, `the metadata block never ends. Close it with a "${prefix} ///" line.`);
}
function metadataBlock(region) {
  const at = region.lines.findIndex((line) => /^metadata\s*:/.test(line));
  if (at === -1)
    return;
  const lineNumber = region.start + 2 + at;
  const rest = withoutComment((region.lines[at] ?? "").replace(/^metadata\s*:/, "")).trim();
  const start = region.start + 1 + at;
  if (rest.startsWith("{"))
    return { start, end: start + 1, entries: flowEntries(rest, lineNumber) };
  if (rest !== "")
    throw new MetadataError(lineNumber, "metadata holds a single value. Write a map of names to text, such as metadata: { mymod.key: value }.");
  let index = at + 1;
  while (index < region.lines.length && (/^\s/.test(region.lines[index] ?? "") || (region.lines[index] ?? "").trim() === ""))
    index += 1;
  while (index > at + 1 && (region.lines[index - 1] ?? "").trim() === "")
    index -= 1;
  const children = region.lines.slice(at + 1, index);
  return { start, end: region.start + 1 + index, entries: mapEntries(children, lineNumber + 1, indentOf(children)) };
}
function indentOf(lines) {
  const first = lines.find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  return first === undefined ? 0 : /^\s*/.exec(first)?.[0].length ?? 0;
}
function mapEntries(lines, firstLine, indent) {
  const entries = [];
  lines.forEach((raw, index) => {
    const lineNumber = firstLine + index;
    const line = withoutComment(raw);
    if (line.trim() === "")
      return;
    const depth = /^\s*/.exec(line)?.[0].length ?? 0;
    if (depth !== indent)
      throw new MetadataError(lineNumber, "a metadata value holds a list or a map. Each value is one line of text, and a list is one space-separated text.");
    const body = line.trim();
    if (body.startsWith("- "))
      throw new MetadataError(lineNumber, "metadata holds a list. Write a map of names to text, and a list as one space-separated text.");
    entries.push(entryOf(body, lineNumber));
  });
  return entries;
}
function flowEntries(text, lineNumber) {
  if (!text.endsWith("}"))
    throw new MetadataError(lineNumber, "the metadata map starts with { and does not end on the same line. Close it with }, or write one entry per line.");
  const body = text.slice(1, -1).trim();
  if (body === "")
    return [];
  return splitOutsideQuotes(body, ",", lineNumber).map((part) => part.trim()).filter((part) => part !== "").map((part) => entryOf(part, lineNumber));
}
function entryOf(text, lineNumber) {
  const [keyText, ...rest] = splitOutsideQuotes(text, ":", lineNumber, true);
  if (keyText === undefined || rest.length === 0)
    throw new MetadataError(lineNumber, `"${text}" has no ":". Write each entry as name: value.`);
  const valueText = rest.join(":").trim();
  if (valueText.startsWith("{") || valueText.startsWith("[") || valueText === "|" || valueText === ">")
    throw new MetadataError(lineNumber, `${keyText.trim()} holds a list or a map. Each value is one line of text, and a list is one space-separated text.`);
  return { key: unquoted(keyText.trim(), lineNumber), value: unquoted(valueText, lineNumber) };
}
function splitOutsideQuotes(text, separator, lineNumber, needsSpace = false) {
  const parts = [];
  let quote;
  let current = "";
  for (let index = 0;index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote)
        quote = undefined;
      continue;
    }
    const before = current.trimEnd().at(-1);
    if ((char === '"' || char === "'") && (before === undefined || before === ":"))
      quote = char;
    const next = text[index + 1];
    if (char === separator && (!needsSpace || next === undefined || next === " " || next === "\t")) {
      parts.push(current);
      current = "";
      if (needsSpace) {
        parts.push(text.slice(index + 1));
        return parts;
      }
      continue;
    }
    current += char;
  }
  if (quote !== undefined)
    throw new MetadataError(lineNumber, `a ${quote === '"' ? "double" : "single"} quote never closes.`);
  parts.push(current);
  return parts;
}
function withoutComment(line) {
  let quote;
  for (let index = 0;index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === "\\" && quote === '"')
        index += 1;
      else if (char === quote)
        quote = undefined;
      continue;
    }
    if (char === '"' || char === "'")
      quote = char;
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? "")))
      return line.slice(0, index);
  }
  return line;
}
function unquoted(text, lineNumber) {
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2)
      throw new MetadataError(lineNumber, `${text} opens a double quote that never closes.`);
    try {
      return JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError))
        throw error;
      throw new MetadataError(lineNumber, `${text} is not a double-quoted text. Escape a " inside it as \\".`);
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2)
      throw new MetadataError(lineNumber, `${text} opens a single quote that never closes.`);
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}
function topLevelScalar(region, key) {
  const at = region.lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at === -1)
    return;
  const text = withoutComment((region.lines[at] ?? "").slice(key.length + 1)).trim();
  if (text === "")
    return;
  try {
    return unquoted(text, region.start + 2 + at);
  } catch (error) {
    if (error instanceof MetadataError)
      return;
    throw error;
  }
}
function asRecord(entries) {
  return Object.freeze(Object.fromEntries(entries.map(({ key, value }) => [key, value])));
}
var plain = /^[A-Za-z0-9_./+~$%^()=\\][^#]*$/;
var special = /^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?|0x[0-9a-fA-F]+|\.inf|\.nan)$/i;
function scalar(text) {
  const isPlain = plain.test(text) && text === text.trim() && !text.includes(": ") && !text.endsWith(":") && !text.includes(" #") && !special.test(text) && !/["',{}[\]]/.test(text);
  return isPlain ? text : JSON.stringify(text);
}

// node_modules/@cmodjs/core/runtime/metadata.js
var skippedFolders = [".git", "node_modules"];
var ownKey = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
function resolvedPath(path, places) {
  const configured = /^~\/\.claude(?=\/|$)/.exec(path);
  if (configured !== null && places.configRoot !== undefined)
    return ve(`${places.configRoot}${path.slice(configured[0].length)}`);
  const prefix = homePrefix.exec(path)?.[0];
  if (prefix !== undefined) {
    if (places.home === undefined)
      throw new Error(`${path} starts with ${prefix}, and HOME is not set. Start Claude Code with HOME set.`);
    return ve(expandHome(path, places.home, places.configRoot));
  }
  return path.startsWith("/") ? ve(path) : ve(places.projectRoot(), path);
}
function createModFiles({ name, claude, places, report }) {
  const prefix = `${name}.`;
  const cache = new Map;
  const logged = new Set;
  const own = (all) => Object.freeze(Object.fromEntries(Object.entries(all).flatMap(([key, value]) => key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : [])));
  const locate = async (path) => {
    const stat = await claude.fs.stat(path, { resolve: true });
    if (stat.kind !== "file")
      throw new Error(`${path} is not a file, so it holds no metadata.`);
    const realPath = stat.realPath ?? path;
    const extensionless = !realPath.slice(realPath.lastIndexOf("/") + 1).includes(".");
    const firstLine = extensionless ? (await claude.fs.read(realPath)).split(`
`, 1)[0] : undefined;
    const format = formatOf(realPath, firstLine);
    const holder = format.type === "sidecar" ? `${realPath}${sidecarSuffix}` : realPath;
    const sidecar = format.type === "sidecar" ? await claude.fs.stat(holder).catch(ifMissing(undefined)) : undefined;
    return { realPath, format, holder, signature: `${stat.mtimeMs}:${stat.size}:${sidecar?.kind === "file" ? `${sidecar.mtimeMs}:${sidecar.size}` : ""}` };
  };
  const textOf = async (holder) => (await claude.fs.stat(holder).catch(ifMissing(undefined)))?.kind === "file" ? claude.fs.read(holder) : "";
  const skipped = (path, value) => (error) => {
    if (isMissing(error))
      return value;
    const reason = `${name}: fs.find skipped ${path}: ${messageOf(error)}`;
    if (!logged.has(reason))
      claude.ui.warn("fs:find", reason);
    logged.add(reason);
    return value;
  };
  const readEntry = async (path) => {
    const located = await locate(path);
    const cached = cache.get(path);
    if (cached?.signature === located.signature)
      return cached.read;
    let read;
    try {
      const { metadata, name: declared } = readMetadata(await textOf(located.holder), located.format);
      read = { metadata, ...declared === undefined ? {} : { name: declared } };
    } catch (error) {
      if (!(error instanceof MetadataError))
        throw error;
      const failure = `${located.holder} ${error.message}`;
      read = { metadata: {}, error: failure };
      if (!logged.has(failure))
        report({ id: `metadata:${located.holder}`, message: `Skips the metadata of ${located.holder}`, description: failure });
      logged.add(failure);
    }
    cache.set(path, { signature: located.signature, read });
    return read;
  };
  const matchesOf = async (pattern) => {
    const absolute = resolvedPath(pattern, places);
    const scanned = $s.scan(absolute);
    if (!scanned.isGlob)
      return (await claude.fs.stat(absolute).catch(skipped(absolute, undefined)))?.kind === "file" ? [absolute] : [];
    const isMatch = $s(absolute, { dot: true });
    const entersSkipped = skippedFolders.filter((folder) => scanned.glob.split("/").includes(folder));
    const maxDepth = scanned.glob.includes("**") ? Number.POSITIVE_INFINITY : scanned.glob.split("/").length;
    const found = [];
    const visited = new Set;
    const walk = async (folder, depth) => {
      const real = (await claude.fs.stat(folder, { resolve: true }).catch(skipped(folder, undefined)))?.realPath ?? folder;
      if (visited.has(real))
        return;
      visited.add(real);
      const entries = await claude.fs.list(folder).catch(skipped(folder, []));
      await Promise.all(entries.map(async (entry) => {
        const path = `${folder}/${entry.name}`;
        const kind = entry.isLink === true ? (await claude.fs.stat(path).catch(skipped(path, undefined)))?.kind : entry.kind;
        if (kind === "file" && isMatch(path))
          found.push(path);
        if (kind !== "dir" || depth + 1 >= maxDepth)
          return;
        if (skippedFolders.includes(entry.name) && !entersSkipped.includes(entry.name))
          return;
        await walk(path, depth + 1);
      }));
    };
    const base = scanned.base === "" ? "/" : scanned.base;
    if ((await claude.fs.stat(base).catch(skipped(base, undefined)))?.kind === "dir")
      await walk(base, 0);
    return found;
  };
  return {
    async find(glob) {
      const patterns = typeof glob === "string" ? [glob] : glob;
      const paths = [...new Set((await Promise.all(patterns.map(matchesOf))).flat())].sort();
      const kept = paths.filter((path) => !(path.endsWith(sidecarSuffix) && paths.includes(path.slice(0, -sidecarSuffix.length))));
      return Promise.all(kept.map(async (path) => {
        const read = await readEntry(path).catch((error) => ({ metadata: {}, error: `${path} ${messageOf(error)}` }));
        return { path, ...read.name === undefined ? {} : { name: read.name }, metadata: own(read.metadata), ...read.error === undefined ? {} : { error: read.error } };
      }));
    },
    async read(path) {
      const read = await readEntry(resolvedPath(path, places));
      if (read.error !== undefined)
        throw new Error(`${name}: ${read.error}`);
      return own(read.metadata);
    },
    async update(path, change) {
      const given = resolvedPath(path, places);
      const located = await locate(given);
      const text = await textOf(located.holder);
      let all;
      try {
        all = readMetadata(text, located.format).metadata;
      } catch (error) {
        throw new Error(`${name}: ${located.holder} ${messageOf(error)}`, { cause: error });
      }
      const edited = { ...own(all) };
      change(edited);
      for (const [key, value] of Object.entries(edited)) {
        if (!ownKey.test(key))
          throw new Error(`${name}: the metadata key "${key}" is not a name. Use letters, digits, "_", ".", and "-".`);
        if (typeof value !== "string")
          throw new Error(`${name}: the metadata key "${key}" holds ${JSON.stringify(value)}. Each value is text, and a list is one space-separated text.`);
        if (value.includes(`
`))
          throw new Error(`${name}: the metadata key "${key}" holds a line break. Each value is one line of text.`);
      }
      const next = {};
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(prefix))
          next[key] = value;
        else if (Object.hasOwn(edited, key.slice(prefix.length)))
          next[key] = edited[key.slice(prefix.length)];
      }
      for (const [key, value] of Object.entries(edited))
        next[`${prefix}${key}`] = value;
      if (JSON.stringify(next) === JSON.stringify(all))
        return;
      await claude.fs.write(located.holder, writeMetadata(text, located.format, next));
      cache.delete(given);
    }
  };
}

// node_modules/@cmodjs/core/ui/elements.js
var unbuilt = Symbol("an element built outside a render");
var drawing;
function drawWith(table, draw, markdown) {
  const outer = drawing;
  const current = { table, markdown };
  drawing = current;
  try {
    return built(current, draw());
  } finally {
    drawing = outer;
  }
}
function element(name) {
  const construct = (props) => drawing === undefined ? { [unbuilt]: { name, props } } : build(drawing, name, props);
  return construct;
}
function build(current, name, props) {
  const ready = "children" in props ? { ...props, children: built(current, props.children) } : props;
  if (name === "Markdown" && current.markdown !== undefined)
    return current.markdown(ready);
  return current.table[name](ready);
}
function built(current, value) {
  if (Array.isArray(value))
    return value.map((child) => built(current, child));
  if (typeof value !== "object" || value === null || !(unbuilt in value))
    return value;
  const { name, props } = value[unbuilt];
  return build(current, name, props);
}
function drawKeyed(keyPrefix, draw) {
  const outer = drawing;
  drawing = undefined;
  try {
    return keyed(draw(), keyPrefix);
  } finally {
    drawing = outer;
  }
}
function keyed(value, keyPrefix) {
  if (Array.isArray(value))
    return value.map((each) => keyed(each, keyPrefix));
  if (typeof value !== "object" || value === null || !(unbuilt in value))
    return value;
  const { name, props } = value[unbuilt];
  const prefixed = Object.fromEntries(Object.entries(props).map(([field, each]) => [field, field === "key" && typeof each === "string" ? `${keyPrefix}${each}` : keyed(each, keyPrefix)]));
  return { [unbuilt]: { name, props: prefixed } };
}
var elementKey = "$cmodElement";
var handlerKey = "$cmodHandler";
function elementData(value, handlers) {
  if (typeof value === "function")
    return { [handlerKey]: handlers.push(value) - 1 };
  if (Array.isArray(value))
    return value.map((each) => elementData(each, handlers));
  if (typeof value !== "object" || value === null)
    return value;
  if (unbuilt in value) {
    const { name, props } = value[unbuilt];
    if (name === "Client")
      throw new Error("Client draws only in panes and styles.");
    return { [elementKey]: name, props: elementData(props, handlers) };
  }
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("a widget draws only the elements of ui/elements.js and ui/components.js, text, numbers, and plain objects.");
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, elementData(each, handlers)]));
}
function elementOf(data, keyPrefix, press) {
  if (Array.isArray(data))
    return data.map((each) => elementOf(each, keyPrefix, press));
  if (typeof data !== "object" || data === null)
    return data;
  const fields = data;
  if (typeof fields[handlerKey] === "number") {
    const handler = fields[handlerKey];
    return (...args) => press(handler, JSON.parse(JSON.stringify(args)));
  }
  const name = fields[elementKey];
  if (name === undefined)
    return Object.fromEntries(Object.entries(fields).map(([key, each]) => [key, elementOf(each, keyPrefix, press)]));
  if (typeof name !== "string" || !Object.hasOwn(constructors, name))
    throw new Error(`a widget drew ${String(name)}, which is not an element of ui/elements.js.`);
  const props = elementOf(fields["props"], keyPrefix, press);
  return constructors[name](typeof props["key"] === "string" ? { ...props, key: `${keyPrefix}${props["key"]}` } : props);
}
var focusable = new Set(["Button", "Input", "Select"]);
function drawsFocusable(data, key) {
  if (typeof data !== "object" || data === null)
    return false;
  if (Array.isArray(data))
    return data.some((each) => drawsFocusable(each, key));
  const fields = data;
  const props = fields["props"];
  if (focusable.has(fields[elementKey]) && props?.["key"] === key)
    return true;
  return Object.values(fields).some((each) => drawsFocusable(each, key));
}
var Box = element("Box");
var Text = element("Text");
var Button = element("Button");
var Link = element("Link");
var Code = element("Code");
var Markdown = element("Markdown");
var Input = element("Input");
var Select = element("Select");
var Image = element("Image");
var Svg = element("Svg");
var Raster = element("Raster");
var Client = element("Client");
var constructors = { Box, Text, Button, Link, Code, Markdown, Input, Select, Image, Svg, Raster };

// node_modules/@cmodjs/core/runtime/buttons.js
function filledButton({ key, label, hotkey, variant = "secondary", onPress }) {
  const isPrimary = variant === "primary";
  return Button({
    plain: true,
    key,
    label,
    ...hotkey === undefined ? {} : { hotkey },
    onPress,
    children: Text({ backgroundColor: isPrimary ? "claude" : "userMessageBackground", color: isPrimary ? "inverseText" : "text", bold: isPrimary, children: ` ${label} ` })
  });
}

// node_modules/@cmodjs/core/ui/panes.js
var partId = /^[A-Za-z0-9_-]{1,64}$/;
var sizeKeys = ["columns", "rows"];
function checkPart(name, kind, id, title) {
  if (!partId.test(id))
    throw new Error(`${name}: "${id}" is not a ${kind} id. Use 1 to 64 letters, digits, "_", or "-".`);
  if (title.trim() === "")
    throw new Error(`${name}: the ${kind} "${id}" needs a title, the label its tab shows.`);
}
function checkPane(name, pane) {
  checkPart(name, "pane", pane.id, pane.title);
  for (const key of sizeKeys) {
    const size = pane[key];
    if (typeof size !== "function" && size !== undefined && (!Number.isInteger(size) || size <= 0))
      throw new Error(`${name}: the pane "${pane.id}" has ${key} ${size}. Use a whole number above 0, or leave it out.`);
  }
}

// node_modules/@cmodjs/core/runtime/ui.js
var partMethods = {
  list: "cmod:parts",
  draw: "cmod:draw",
  press: "cmod:press",
  shown: "cmod:shown",
  changed: "cmod:partsChanged",
  stylers: "cmod:markdownStylers"
};
var stalePress = "that button drew before the last redraw. Press the one it shows now.";
var unmeasuredColumns = 80;
function viewportColumns(e) {
  return e.viewport?.columns ?? unmeasuredColumns;
}
function styledAt(e, columns = viewportColumns(e)) {
  return { surface: e.surface, columns: Math.max(columns, 0) };
}
var bullet = "⏺";
function paneSize(pane, state) {
  const size = {};
  for (const key of sizeKeys) {
    const wanted = pane[key];
    const value = typeof wanted === "function" ? wanted(state) : wanted;
    if (value === undefined)
      continue;
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`the pane "${pane.id}" gets ${key} ${value} from its state. Return a whole number above 0, or undefined for Claude Code's default.`);
    size[key] = value;
  }
  return size;
}
function times(count) {
  return count === 1 ? "1 time" : `${count} times`;
}
function pieceProps(props, given, isFirst) {
  const merged = { ...props, ...given };
  return isFirst || !("isFirstOfReply" in merged) ? merged : { ...merged, isFirstOfReply: false };
}
function laterKeys(key) {
  let used = 0;
  return () => key === undefined ? undefined : `${key}:${used += 1}`;
}
function inheriting(props, draw, laterKey = laterKeys(props.key)) {
  const { dimColor, onLinkPress, pressableLinks } = props;
  const inherited = { ...dimColor === undefined ? {} : { dimColor }, ...onLinkPress === undefined ? {} : { onLinkPress }, ...pressableLinks === undefined ? {} : { pressableLinks } };
  let isKeyTaken = false;
  const keyOf = (left) => {
    if (left.key !== undefined)
      return left.key;
    if (isKeyTaken)
      return laterKey();
    isKeyTaken = true;
    return props.key;
  };
  return (left) => {
    const key = keyOf(left);
    return draw({ ...inherited, ...key === undefined ? {} : { key }, ...left });
  };
}
function threw(error) {
  return `threw, so Claude Code draws its own: ${messageOf(error)}`;
}
async function drawComponent(table, draw, drawDefault) {
  const calls = [];
  let first;
  try {
    first = drawWith(table, () => draw(({ children, ...props }) => {
      const drawing = table.Box({});
      calls.push({ given: props, drawing });
      return drawing;
    }));
  } catch (error) {
    return { failure: threw(error) };
  }
  if (calls.length === 0)
    return { drawing: first, isClaudesRow: false };
  const whole = calls.findIndex((call) => call.drawing === first);
  const pieces = await Promise.all(calls.map(({ given }, index) => drawDefault(given, index === whole)));
  let used = 0;
  let second;
  try {
    second = drawWith(table, () => draw(() => pieces[used++] ?? Box({})));
  } catch (error) {
    return { failure: threw(error) };
  }
  if (used !== pieces.length)
    return { failure: `used Default ${times(pieces.length)}, then ${times(used)}, so Claude Code draws its own. A render must draw the same for the same props.` };
  return { drawing: second, isClaudesRow: whole >= 0 };
}
function drawPieces(pieces, place) {
  const spaced = pieces.map(({ drawing, isClaudesRow }, index) => (index > 0 || place === "inReply") && !isClaudesRow ? Box({ marginTop: 1, children: drawing }) : drawing);
  const column = (drawings) => Box({ flexDirection: "column", children: drawings });
  const [opening, ...rest] = spaced;
  if (place !== "opensReply" || opening === undefined)
    return column(spaced);
  if (pieces[0]?.isClaudesRow !== true)
    return Box({ children: [Box({ minWidth: 2, children: Text({ color: "text", children: bullet }) }), column(spaced)] });
  return column([opening, Box({ paddingLeft: 2, children: column(rest) })]);
}
function merged(updates) {
  const parts = updates.findLast((update) => update.parts !== undefined)?.parts;
  const requests = updates.flatMap((update) => update.requests ?? []);
  const isRedrawn = updates.some((update) => update.redraw === true);
  return { ...parts === undefined ? {} : { parts }, ...isRedrawn ? { redraw: true } : {}, ...requests.length === 0 ? {} : { requests } };
}
var keptDrawInputs = 200;
function createUi({ name, claude, router, report, announce, mod, borrowed, nextDraw }) {
  const panes = new Map;
  const paneLogs = new Map;
  const openPanes = new Set;
  const paneStates = new Map;
  const syncPanes = async () => {
    const listed = new Map((await claude.ui.panes()).map((open) => [open.id, open]));
    for (const id of panes.keys()) {
      const open = listed.get(id);
      if (open?.isPlaced === true)
        openPanes.add(id);
      else
        openPanes.delete(id);
      if (open === undefined)
        paneStates.delete(id);
      else
        paneStates.set(id, { isShown: open.isShown, isFocused: open.isFocused });
    }
  };
  const readPanes = () => syncPanes().catch((error) => claude.ui.warn("panes:read", `${name} keeps its panes' open, shown, and focused state from before: ${messageOf(error)}`));
  const requestedSizes = new Map;
  const styles = new Set;
  const markdownRenders = new Map;
  let read;
  let stylers = [];
  let stylersSeen = 0;
  let isRouted = false;
  let isResizeQueued = false;
  const widgets = new Map;
  const widgetAreas = new Map;
  const pages = new Map;
  let shownPages = { open: [], shown: null, isFocused: false };
  const draws = new Map;
  const latestDraws = new Map;
  const failedDraws = new Set;
  let beforeStart = [];
  let askedDepth = 0;
  const askedCalls = new Set;
  let unheldRequests = 0;
  let collected;
  let collecting = 0;
  let queued;
  const partList = () => ({
    widgets: [...widgets.values()].map(({ id, title, areas: listed, place }) => ({ id, title, areas: listed, ...place === undefined ? {} : { place } })),
    pages: [...pages.values()].map(({ init: { id, title }, place }) => ({ id, title, place })),
    ...markdownRenders.size > 0 ? { stylesMarkdown: true } : {}
  });
  const hear = (listed, isRestyled) => {
    if (!Array.isArray(listed))
      return;
    const heard = listed.filter((styler) => typeof styler === "string" && styler !== name);
    if (!isRestyled && heard.join("\x00") === stylers.join("\x00"))
      return;
    stylers = heard;
    stylersSeen += 1;
    if (name === cmodPluginName || panes.size > 0)
      claude.ui.invalidate("ui.render");
  };
  const treeOf = (render, handlers) => {
    const drawn = render();
    return drawn === undefined ? null : elementData(drawn, handlers);
  };
  const isAnyDrawingChanged = () => {
    for (const [key, inputs] of latestDraws) {
      if (key === "markdown")
        continue;
      for (const sent of inputs.values()) {
        const handlers = [];
        try {
          if (JSON.stringify(treeOf(sent.render, handlers)) !== sent.tree)
            return true;
        } catch (error) {
          claude.ui.warn(`drawing:${key}`, `${name}: the ${key} drawing threw, so the cmod plugin asks for it again: ${messageOf(error)}`);
          return true;
        }
        const latest = sent.draws.at(-1);
        if (latest !== undefined && draws.has(latest))
          draws.set(latest, { id: key, handlers });
      }
    }
    return false;
  };
  const withNeededRedraw = ({ redraw, ...update }) => redraw === true && isAnyDrawingChanged() ? { ...update, redraw } : update;
  const send = (update) => {
    if (collected !== undefined)
      return void collected.push(update);
    if (beforeStart !== undefined)
      return void beforeStart.push(update);
    const isAsked = askedDepth > 0;
    if (queued !== undefined && !isAsked)
      return void queued.push(update);
    const batch = [update];
    if (!isAsked)
      queued = batch;
    const tell = async () => {
      if (queued === batch)
        queued = undefined;
      const needed = withNeededRedraw(merged(batch));
      if (Object.keys(needed).length === 0)
        return;
      const input = { ...needed, ...isAsked ? { isAsked: true } : {} };
      return claude.cmod.call({ to: cmodPluginName, method: partMethods.changed, input }).then((answer) => {
        if (isAsked && input.requests !== undefined && !(isObject(answer) && answer["isHeld"] === true))
          unheldRequests += 1;
        if (isObject(answer) && name !== cmodPluginName)
          hear(answer["stylers"], false);
      }, (error) => claude.ui.warn("parts:tell", `${name}: the cmod plugin did not hear about its pages and widgets: ${messageOf(error)}`));
    };
    if (!isAsked)
      return Promise.resolve().then(tell);
    const told = tell().finally(() => askedCalls.delete(told));
    askedCalls.add(told);
    return told;
  };
  const asked = async (run) => {
    askedDepth += 1;
    try {
      const value = await run();
      while (askedCalls.size > 0)
        await Promise.allSettled(askedCalls);
      return value;
    } finally {
      askedDepth -= 1;
    }
  };
  const collect = async (run) => {
    collecting += 1;
    collected ??= [];
    try {
      await run();
    } finally {
      collecting -= 1;
    }
    const mine = collected;
    collected = collecting === 0 ? undefined : [];
    return withNeededRedraw(merged(mine));
  };
  const logOnce = (what) => {
    let hasLogged = false;
    return (failure) => {
      if (!hasLogged)
        report({ id: `draw:${what}`, message: `The ${what} failed`, description: failure });
      hasLogged = true;
    };
  };
  const renderOf = (type) => markdownRenders.get(type);
  const drawnBlock = (piece, at, drawClaudes, keyPrefix, table) => {
    if ("text" in piece)
      return drawClaudes({ text: piece.text });
    const { render, props: block } = piece;
    const draw = () => drawKeyed(keyPrefix, () => render.Component({ ...block, ...at, Default: ({ source = block.source }) => drawClaudes({ text: source }) }));
    try {
      return table === undefined ? draw() : drawWith(table, draw, drawClaudes);
    } catch (error) {
      render.log(threw(error));
      return drawClaudes({ text: block.source });
    }
  };
  const othersFrom = (table, at, from, unkeyedScope) => (props, laterKey = laterKeys(props.key)) => {
    if (from >= stylers.length)
      return table.Markdown(props);
    const scope = props.key ?? unkeyedScope();
    for (const [index, styler] of stylers.entries()) {
      if (index < from)
        continue;
      const cached = `${stylersSeen}\x00${at.surface}\x00${at.columns}\x00${props.text}`;
      const next = othersFrom(table, at, index + 1, unkeyedScope);
      const drawn = drawWith(table, () => borrowed(styler, cached, { markdown: props.text, ...at }, scope), inheriting(props, (part) => next(part, laterKey), laterKey));
      if (drawn !== undefined)
        return drawn;
    }
    return table.Markdown(props);
  };
  const markdownIn = (table, at) => {
    const reader = read;
    let unkeyed = 0;
    const unkeyedScope = () => String(unkeyed++);
    const others = othersFrom(table, at, 0, unkeyedScope);
    if (reader === undefined)
      return stylers.length === 0 ? undefined : others;
    return (props) => {
      const pieces = reader(props.text, renderOf);
      if (pieces.every((piece) => ("text" in piece)))
        return others(props);
      const scope = props.key ?? unkeyedScope();
      const laterKey = laterKeys(props.key);
      const drawClaudes = inheriting(props, (part) => others(part, laterKey), laterKey);
      const drawings = pieces.map((piece, index) => drawnBlock(piece, at, drawClaudes, `${scope}:${index}:`, table));
      return drawPieces(drawings.map((drawing) => ({ drawing, isClaudesRow: false })), "pane");
    };
  };
  const markdownDrawing = (text, at) => {
    const pieces = read === undefined ? [] : read(text, renderOf);
    if (pieces.every((piece) => ("text" in piece)))
      return Markdown({ text });
    return drawPieces(pieces.map((piece, index) => ({ drawing: drawnBlock(piece, at, Markdown, `${index}:`), isClaudesRow: false })), "pane");
  };
  const routeMarkdown = (createReader) => {
    if (read !== undefined)
      return;
    const reader = createReader();
    read = reader;
    router.add("ui.render", async (e, next) => {
      if (e.component !== "AssistantMessage")
        return next(e);
      const pieces = reader(e.props.text, renderOf, e.requestId);
      if (pieces.every((piece) => ("text" in piece)))
        return next(e);
      const table = claude.ui.resolve(e);
      const drawClaudes = (text, isFirst) => next({ ...e, props: pieceProps(e.props, { text }, isFirst) });
      const drawn = await Promise.all(pieces.map(async (piece, index) => {
        if ("text" in piece)
          return { drawing: await drawClaudes(piece.text, index === 0), isClaudesRow: true };
        const { render, props: block } = piece;
        const component = await drawComponent(table, (Default) => drawKeyed(`${index}:`, () => render.Component({ ...block, ...styledAt(e), id: e.requestId, Default })), ({ source = block.source }, isClaudesRow) => drawClaudes(source, index === 0 && isClaudesRow));
        if (!("failure" in component))
          return component;
        render.log(component.failure);
        return { drawing: await drawClaudes(block.source, index === 0), isClaudesRow: true };
      }));
      return drawWith(table, () => drawPieces(drawn, e.props.isFirstOfReply ? "opensReply" : "inReply"));
    });
  };
  const openAt = (pane, size, focus) => {
    requestedSizes.set(pane.id, size);
    const { id, title, closeOnEscape, holdToasts } = pane;
    return claude.ui.open({ id, title, ...size, ...closeOnEscape === true ? { closeOnEscape } : {}, ...holdToasts === true ? { holdToasts } : {}, ...focus === true ? { focus } : {} });
  };
  const resize = async (pane) => {
    try {
      const size = paneSize(pane, mod().state);
      const requested = requestedSizes.get(pane.id);
      if (requested?.columns === size.columns && requested?.rows === size.rows)
        return;
      await openAt(pane, size);
    } catch (error) {
      claude.ui.warn(`pane:resize:${pane.id}`, `${name}: the ${pane.title} pane kept its size: ${messageOf(error)}`);
    }
  };
  const handle = async (pane, handler, run) => {
    try {
      await run();
    } catch (error) {
      report({ id: `pane:${pane.id}:${handler}`, message: `The ${pane.title} pane's ${handler} threw`, error });
    }
  };
  const routePanes = () => {
    if (isRouted)
      return;
    isRouted = true;
    router.add("ui.render", (e, next) => {
      const added = panes.get(e.requestId);
      if (added === undefined || e.component !== "Pane")
        return next(e);
      const { init } = added;
      openPanes.add(init.id);
      paneStates.set(init.id, { isShown: true, isFocused: e.props.isFocused });
      readPanes();
      const table = claude.ui.resolve(e);
      try {
        return drawWith(table, () => init.render(mod(), { ...e.props, surface: e.surface, params: added.params }), markdownIn(table, styledAt(e, e.props.bodyColumns)));
      } catch (error) {
        paneLogs.get(init.id)?.(`threw: ${messageOf(error)}`);
        return drawWith(table, () => Text({ color: "error", children: `The ${init.title} pane could not draw: ${messageOf(error)}` }));
      }
    });
    router.add("ui.scroll", async (e, next) => {
      const init = panes.get(e.requestId)?.init;
      const moved = await next(e);
      if (init?.onScroll === undefined || e.component !== "Pane" || moved.deny !== undefined)
        return moved;
      await handle(init, "onScroll", () => init.onScroll?.(mod(), e));
      return moved;
    });
    router.add("ui.close", async (e, next) => {
      openPanes.delete(e.id);
      paneStates.delete(e.id);
      const closed = await next(e);
      await readPanes();
      const init = panes.get(e.id)?.init;
      if (init?.onClose !== undefined)
        await handle(init, "onClose", () => init.onClose?.(mod(), e));
      return closed;
    });
  };
  const scrollIn = (id, target, options) => claude.ui.scroll({ to: target, in: id, ...options?.block === undefined ? {} : { block: options.block } }).then(({ deny }) => {
    if (deny !== undefined)
      throw new Error(`${name}: Claude Code did not scroll ${id}: ${deny}`);
  });
  const addPane = (init) => {
    checkPane(name, init);
    if (panes.has(init.id))
      throw new Error(`${name}: the pane "${init.id}" is already added. Give each pane its own id.`);
    const added = { init, params: undefined };
    panes.set(init.id, added);
    paneLogs.set(init.id, logOnce(`${init.title} pane`));
    announce(`the ${init.title} pane`);
    routePanes();
    const sized = init;
    const pane = {
      id: init.id,
      get isOpen() {
        return openPanes.has(init.id);
      },
      get isShown() {
        return paneStates.get(init.id)?.isShown ?? false;
      },
      get isFocused() {
        return paneStates.get(init.id)?.isFocused ?? false;
      },
      get params() {
        return added.params;
      },
      async open(...[options]) {
        if (options !== undefined && "params" in options)
          added.params = options.params;
        const { isPlaced } = await openAt(sized, paneSize(sized, mod().state), options?.focus);
        if (isPlaced)
          openPanes.add(init.id);
        await syncPanes();
        claude.ui.invalidate("ui.render");
      },
      async close() {
        await claude.ui.close({ id: init.id });
        openPanes.delete(init.id);
        paneStates.delete(init.id);
        await syncPanes();
      },
      toggle: (options) => openPanes.has(init.id) ? pane.close() : pane.open(options),
      scrollTo: (target, options) => scrollIn(init.id, target, options),
      async focus(key) {
        const { deny } = await claude.ui.focus({ requestId: init.id, key });
        if (deny !== undefined)
          throw new Error(`${name}: Claude Code did not focus "${key}" in the ${init.title} pane: ${deny}`);
      },
      remove() {
        if (panes.get(init.id) !== added)
          return;
        panes.delete(init.id);
        paneLogs.delete(init.id);
        if (openPanes.has(init.id))
          claude.ui.close({ id: init.id }).catch((error) => claude.ui.warn(`pane:close:${init.id}`, `${name}: the ${init.title} pane stayed open: ${messageOf(error)}`));
        openPanes.delete(init.id);
        paneStates.delete(init.id);
      }
    };
    return pane;
  };
  const pageEntry = (id) => shownPages.open.find((each) => each.id === id);
  const addPage = (place, init) => {
    checkPart(name, "page", init.id, init.title);
    if (pages.has(init.id))
      throw new Error(`${name}: the page "${init.id}" is already added. Give each page its own id.`);
    const added = { init, place, params: undefined };
    pages.set(init.id, added);
    announce(place === "settings" ? `the ${init.title} page in Settings` : `the ${init.title} page in the Sidebar`);
    send({ parts: partList() });
    const page = {
      id: init.id,
      get isOpen() {
        return place === "settings" ? shownPages.shown === init.id : pageEntry(init.id) !== undefined;
      },
      get isShown() {
        return shownPages.shown === init.id;
      },
      get isFocused() {
        return shownPages.shown === init.id && shownPages.isFocused;
      },
      get params() {
        return pageEntry(init.id)?.params ?? added.params;
      },
      async open(...[options]) {
        if (options !== undefined && "params" in options)
          added.params = options.params;
        await send({ requests: [{ open: init.id, ...added.params === undefined ? {} : { params: added.params }, ...options?.focus === true ? { focus: true } : {} }] });
      },
      toggle: (options) => page.isOpen ? page.close() : page.open(options),
      close: async () => {
        await send({ requests: [{ close: init.id }] });
      },
      scrollTo: async (target, options) => {
        await send({ requests: [{ scroll: init.id, to: target, ...options?.block === undefined ? {} : { block: options.block } }] });
      },
      focus: async (key) => {
        const latest = [...latestDraws.get(`page:${init.id}`)?.values() ?? []].at(-1);
        if (latest === undefined || !drawsFocusable(treeOf(latest.render, []), key))
          throw new Error(`${name}: the ${init.title} page draws no Button, Input, or Select with the key "${key}".`);
        await send({ requests: [{ focus: init.id, key }] });
      },
      remove() {
        if (pages.get(init.id) !== added)
          return;
        pages.delete(init.id);
        forgetDraws(`page:${init.id}`);
        send({ parts: partList(), requests: [{ close: init.id }] });
      }
    };
    return page;
  };
  const addWidget = (init) => {
    checkPart(name, "widget", init.id, init.title);
    if (widgets.has(init.id))
      throw new Error(`${name}: the widget "${init.id}" is already added. Give each widget its own id.`);
    widgets.set(init.id, init);
    announce(`the ${init.title} widget`);
    send({ parts: partList() });
    return {
      id: init.id,
      get area() {
        return widgetAreas.get(init.id);
      },
      remove() {
        if (widgets.get(init.id) !== init)
          return;
        widgets.delete(init.id);
        widgetAreas.delete(init.id);
        forgetDraws(`widget:${init.id}`);
        send({ parts: partList() });
      }
    };
  };
  const addStyle = ({ kind, render }) => {
    const markdown = typeof kind === "string" ? undefined : kind;
    const component = componentOf(kind);
    if (markdown === undefined && component === undefined)
      throw new Error(`${name}: ${String(kind)} is not a kind styles.add draws, such as ToolCall or CodeBlock.`);
    const feature = `the style of ${nameOf(kind)}`;
    if (styles.has(feature))
      throw new Error(`${name}: ${feature} is already added. Add one style per kind.`);
    styles.add(feature);
    announce(feature);
    const Component = (props) => render(mod(), props);
    const stop = (subscription) => () => {
      subscription?.remove();
      if (markdown !== undefined && markdownRenders.delete(markdown.markdown))
        send({ parts: partList() });
      styles.delete(feature);
      claude.ui.invalidate("ui.render");
    };
    if (markdown !== undefined) {
      markdownRenders.set(markdown.markdown, { Component, log: logOnce(`${nameOf(kind)} style`) });
      routeMarkdown(markdown.createReader);
      send({ parts: partList() });
      return { kind, remove: stop() };
    }
    const log = logOnce(`${nameOf(kind)} style`);
    const drawing = router.add("ui.render", async (e, next) => {
      if (e.component !== component)
        return next(e);
      const table = claude.ui.resolve(e);
      const drawn = await drawComponent(table, (Default) => Component({ ...e.props, ...styledAt(e), id: e.requestId, Default }), (given, isClaudesRow) => next({ ...e, props: pieceProps(e.props, given, isClaudesRow) }));
      if ("failure" in drawn) {
        log(drawn.failure);
        return next(e);
      }
      if (e.component !== "AssistantMessage")
        return drawn.drawing;
      return drawWith(table, () => drawPieces([drawn], e.props.isFirstOfReply ? "opensReply" : "inReply"));
    });
    return { kind, remove: stop(drawing) };
  };
  const forgetDraws = (key) => {
    for (const kept of latestDraws.get(key)?.values() ?? [])
      for (const draw of kept.draws)
        draws.delete(draw);
    latestDraws.delete(key);
  };
  const drawPart = (key, title, input, render) => {
    try {
      const pressed = [];
      const tree = treeOf(render, pressed);
      failedDraws.delete(key);
      const number = nextDraw();
      const inputs = latestDraws.get(key) ?? new Map;
      latestDraws.set(key, inputs);
      const drawnFor = JSON.stringify("turn" in input ? { ...input, turn: input.turn.prompt.id } : input);
      const earlier = inputs.get(drawnFor)?.draws ?? [];
      const kept = [...earlier, number].slice(-2);
      for (const draw of earlier)
        if (!kept.includes(draw))
          draws.delete(draw);
      inputs.delete(drawnFor);
      inputs.set(drawnFor, { draws: kept, tree: JSON.stringify(tree), render });
      const [oldest] = inputs;
      if (inputs.size > keptDrawInputs && oldest !== undefined) {
        for (const draw of oldest[1].draws)
          draws.delete(draw);
        inputs.delete(oldest[0]);
      }
      draws.set(number, { id: key, handlers: pressed });
      return { draw: number, tree };
    } catch (error) {
      if (!failedDraws.has(key))
        report({ id: key, message: `The ${title} could not draw`, error });
      failedDraws.add(key);
      throw error;
    }
  };
  const draw = (input) => {
    if ("markdown" in input)
      return drawPart("markdown", "markdown style", input, () => markdownDrawing(input.markdown, { surface: input.surface, columns: input.columns }));
    if ("page" in input) {
      const added = pages.get(input.page);
      if (added === undefined)
        throw new Error(`${name} has no ${input.page} page.`);
      return drawPart(`page:${input.page}`, `${added.init.title} page`, input, () => added.init.render(mod(), { params: input.params, isFocused: input.isFocused, columns: input.columns }));
    }
    const widget = widgets.get(input.widget);
    if (widget === undefined || !widget.areas.includes(input.area))
      return null;
    widgetAreas.set(widget.id, input.area);
    const context = input.area === TurnEnd && input.turn !== undefined ? { area: input.area, columns: input.columns, turn: input.turn } : { area: input.area, columns: input.columns };
    return drawPart(`widget:${widget.id}`, `${widget.title} widget`, input, () => widget.render(mod(), context));
  };
  const press = async ({ draw: drawn, handler, args }, caller) => {
    const known = draws.get(drawn);
    const run = known?.handlers[handler];
    if (known === undefined || run === undefined)
      throw new Error(`${name}: ${stalePress}`);
    if (caller !== cmodPluginName && known.id !== "markdown")
      throw new Error(`${name}: ${caller} pressed a button only the cmod plugin draws.`);
    const pressed = async () => {
      try {
        await run(...args);
      } catch (error) {
        report({ id: known.id, message: "Its button failed", error, isCritical: true });
      }
    };
    if (caller === cmodPluginName)
      return collect(pressed);
    await pressed();
    return null;
  };
  return {
    panes: { add: addPane },
    sidebar: { add: (init) => addPage("sidebar", init) },
    settings: {
      add: (init) => addPage("settings", init),
      open: async () => {
        await send({ requests: [{ settings: true }] });
      }
    },
    widgets: { add: addWidget },
    styles: { add: addStyle },
    asked,
    async answerInput(run, passOn) {
      const before = unheldRequests;
      const answer = await asked(run);
      if (unheldRequests > before)
        await passOn();
      return answer;
    },
    answer(method, input, caller) {
      const isMarkdown = method === partMethods.draw && isObject(input) && typeof input["markdown"] === "string";
      if (caller !== cmodPluginName && !isMarkdown && method !== partMethods.press)
        return;
      if (method === partMethods.list)
        return Promise.resolve({ value: partList() });
      if (method === partMethods.draw)
        return Promise.resolve().then(() => ({ value: draw(input) }));
      if (method === partMethods.press)
        return press(input, caller).then((value) => ({ value }));
      if (method === partMethods.shown) {
        shownPages = input;
        return Promise.resolve({ value: null });
      }
      if (method === partMethods.stylers) {
        hear(input, true);
        return Promise.resolve({ value: null });
      }
      return;
    },
    markdownIn,
    restyled: (stylers) => hear(stylers, true),
    started() {
      const held = merged(beforeStart ?? []);
      beforeStart = undefined;
      send({ ...held, parts: partList() });
    },
    changed() {
      if (widgets.size > 0 || pages.size > 0)
        send({ redraw: true });
      if (panes.size === 0 && styles.size === 0)
        return;
      claude.ui.invalidate("ui.render");
      if (isResizeQueued)
        return;
      isResizeQueued = true;
      Promise.resolve().then(() => {
        isResizeQueued = false;
        for (const { init } of panes.values()) {
          if (openPanes.has(init.id))
            resize(init);
        }
      });
    },
    async restorePanes() {
      if (panes.size > 0)
        await syncPanes();
    }
  };
}

// node_modules/@cmodjs/core/runtime/installer.js
var installPage = "cmod:install";
var keptDraws = 8;
function createInstaller(name, claude, waiting, nextDraw) {
  let question;
  let isOpen = false;
  let isSeen = false;
  let waitingForShow = [];
  let collected;
  const draws = new Map;
  const send = async (update) => {
    if (collected !== undefined)
      return void collected.push(update);
    await withBareRefusals(claude()).cmod.call({ to: cmodPluginName, method: partMethods.changed, input: update });
  };
  const log = (what) => (error) => claude().ui.warn("installer:page", `${name}: ${what}: ${messageOf(error)}`);
  const open = (isAsked) => send({ requests: [{ open: installPage, focus: true }], ...isAsked ? { isAsked: true } : {} });
  const show = async (build, cancelled) => {
    question?.cancel();
    const answer = new Promise((resolve) => {
      let isAnswered = false;
      const done = (value) => {
        if (isAnswered)
          return;
        isAnswered = true;
        waiting.hide();
        claude().clock.after(0, () => resolve(value));
      };
      question = { ...build(done), cancel: () => done(cancelled) };
    });
    waiting.show(() => open(true));
    if (isOpen) {
      await send({ redraw: true }).catch(log("the installer did not redraw"));
    } else {
      isOpen = true;
      await open(false).catch((error) => {
        isOpen = false;
        waiting.hide();
        throw error;
      });
    }
    for (const resolve of waitingForShow)
      resolve();
    waitingForShow = [];
    return answer;
  };
  const redraw = () => void send({ redraw: true }).catch(log("the installer did not redraw"));
  const actions = (...buttons) => Box({ gap: 2, flexShrink: 0, children: buttons });
  const dialog = (title, ...children) => Box({ flexDirection: "column", gap: 1, children: [title, ...children] });
  const draw = (columns, isFocused) => {
    if (question === undefined && !isOpen)
      claude().clock.after(0, () => void send({ requests: [{ close: installPage }] }).catch(log("a leftover install page stayed open")));
    const handlers = [];
    const tree = elementData(question?.draw({ params: undefined, isFocused, columns }) ?? Text({ dimColor: true, children: `${name} needs nothing from you now.` }), handlers);
    const drawn = nextDraw();
    draws.set(drawn, handlers);
    for (const kept of draws.keys())
      if (draws.size > keptDraws)
        draws.delete(kept);
    return { draw: drawn, tree };
  };
  const collect = async (run) => {
    const outer = collected;
    const mine = [];
    collected = mine;
    try {
      await run();
    } finally {
      collected = outer;
    }
    return merged(mine);
  };
  const press = async ({ draw: drawn, handler, args }) => {
    const run = draws.get(drawn)?.[handler];
    if (run === undefined)
      throw new Error(`${name}: ${stalePress}`);
    return collect(() => run(...args));
  };
  return {
    answer(method, input) {
      if (method === partMethods.draw && isObject(input) && input["page"] === installPage)
        return Promise.resolve({ value: draw(Number(input["columns"]), input["isFocused"] === true) });
      if (method === partMethods.press && isObject(input) && typeof input["draw"] === "number" && draws.has(input["draw"]))
        return press(input).then((value) => ({ value }));
      return;
    },
    hear(shown) {
      if (shown.open.some((each) => each.id === installPage)) {
        isSeen = isOpen;
        return;
      }
      if (!isSeen)
        return;
      isOpen = false;
      isSeen = false;
      question?.cancel();
    },
    options(missing, save) {
      const saved = new Map;
      const failures = new Map;
      return show((answer) => ({
        draw: () => dialog(Text({ bold: true, children: `Set up ${name}` }), Text({ children: `${name} needs ${missing.length === 1 ? "one setting" : `${missing.length} settings`}:` }), ...missing.map(([key, option]) => {
          const label = Box({ flexDirection: "column", children: [Text({ bold: true, children: option.title }), ...option.description === "" ? [] : [Text({ dimColor: true, wrap: "wrap", children: option.description })]] });
          if (option.type === "secret") {
            return Box({ flexDirection: "column", children: [label, Text({ dimColor: true, wrap: "wrap", children: `${secretFix} Then press Next.` }), filledButton({ key: `secret:${key}`, label: "Open /config", onPress: () => void claude().command.run({ command: "config" }) })] });
          }
          const failure = failures.get(key);
          const field = Input({
            key: `option:${key}`,
            label: "Value",
            placeholder: option.type === "choice" ? (option.choices ?? []).join(", ") : option.type === "toggle" ? "true or false" : option.type === "list" ? "comma-separated" : "",
            value: saved.get(key) ?? "",
            submitLabel: "save",
            onSubmit: (value) => void save(key, value).then((refused) => {
              if (refused === undefined) {
                saved.set(key, value);
                failures.delete(key);
              } else
                failures.set(key, refused);
            }).catch((error) => failures.set(key, messageOf(error))).finally(redraw)
          });
          const status = failure !== undefined ? [Text({ color: "error", wrap: "wrap", children: failure })] : saved.has(key) ? [Text({ color: "success", children: "✓ saved" })] : [];
          return Box({ flexDirection: "column", children: [label, field, ...status] });
        }), actions(filledButton({ key: "next", hotkey: "x", variant: "primary", label: "Next", onPress: () => answer(true) }), filledButton({ key: "not-now", hotkey: "n", label: "Not now", onPress: () => answer(false) })))
      }), false);
    },
    step(mod, step, index, total) {
      let notice;
      return show((answer) => ({
        draw: (props) => {
          let body;
          try {
            body = step.render(mod, props);
          } catch (error) {
            body = Text({ color: "error", wrap: "wrap", children: `The ${step.title} step could not draw: ${messageOf(error)}` });
          }
          const next = async () => {
            try {
              if (await step.isDone(mod))
                return answer(true);
              notice = { color: "warning", text: `Finish ${step.title} first.` };
            } catch (error) {
              notice = { color: "error", text: `The ${step.title} step's isDone failed: ${messageOf(error)}` };
            }
            await send({ redraw: true });
          };
          return dialog(Text({ children: [Text({ bold: true, children: step.title }), Text({ dimColor: true, children: `  (${index} of ${total})` })] }), body, ...notice === undefined ? [] : [Text({ color: notice.color, wrap: "wrap", children: notice.text })], actions(filledButton({ key: "next", hotkey: "x", variant: "primary", label: index === total ? "Finish" : "Next", onPress: () => void next() }), filledButton({ key: "not-now", hotkey: "n", label: "Not now", onPress: () => answer(false) })));
        }
      }), false);
    },
    async close() {
      question?.cancel();
      question = undefined;
      if (!isOpen)
        return;
      isOpen = false;
      isSeen = false;
      await send({ requests: [{ close: installPage }] }).catch(log("the install page stayed open"));
    },
    shown: () => new Promise((resolve) => void waitingForShow.push(resolve)),
    collect
  };
}

// node_modules/@cmodjs/core/runtime/options.js
class MissingOptions extends Error {
  keys;
  titles;
  constructor(keys, titles) {
    super(`it needs ${listed(titles)}`);
    this.keys = keys;
    this.titles = titles;
  }
}
function createOptions({ name, declared, fromClaude, claude, report, changed }) {
  let values = merged2(declared, fromClaude, {}, new Set);
  let locked;
  let loadedRoot;
  const readLocked = async () => {
    if (Object.keys(declared).length === 0)
      return new Set;
    const rows = await claude.config.list().catch((error) => {
      claude.ui.warn("options:config", `${name} could not read /config, so a project's options.json may override a value your organization set: ${messageOf(error)}`);
      return [];
    });
    return new Set(rows.filter((row) => row.isLocked && row.key.startsWith(`${name}.`)).map((row) => row.key.slice(name.length + 1)));
  };
  const readProject = async (root) => {
    const env = { HOME: await claude.env.home(), CLAUDE_CONFIG_DIR: await claude.env.configHome() };
    const project = configFolders(env, name, root).find(({ tier }) => tier === "project");
    if (project === undefined)
      return {};
    const path = `${project.folder}/options.json`;
    if (!await claude.fs.exists(path))
      return {};
    const { values: kept, ignored } = projectOptionsOf(name, declared, await claude.fs.read(path));
    for (const reason of ignored)
      report({ id: `options:${path} ${reason}`, message: `Ignores part of ${path}`, description: `${path} ${reason}` });
    return kept;
  };
  return {
    get values() {
      return values;
    },
    get missing() {
      return Object.entries(declared).filter(([key, option]) => option.default === undefined && isUnset(values[key])).map(([key]) => key);
    },
    async load(root) {
      if (Object.keys(declared).length === 0)
        return;
      locked ??= await readLocked();
      const project = await readProject(root);
      const isFirst = loadedRoot === undefined;
      loadedRoot = root;
      const next = merged2(declared, fromClaude, project, locked);
      if (!isFirst && JSON.stringify(next) === JSON.stringify(values))
        return;
      values = next;
      if (!isFirst)
        changed();
    }
  };
}
function merged2(declared, fromClaude, project, locked) {
  return Object.freeze(Object.fromEntries(Object.entries(declared).map(([key, option]) => [key, valueOf(key, option, fromClaude[key], project, locked)])));
}
function valueOf(key, option, own, project, locked) {
  if (locked.has(key))
    return own;
  if (Object.hasOwn(project, key))
    return project[key];
  if (!isUnset(own) && fitsOption(option, own) === undefined)
    return Array.isArray(own) ? Object.freeze([...own]) : own;
  return option.default ?? (option.type === "list" ? Object.freeze([]) : option.type === "number" ? undefined : "");
}

// node_modules/@cmodjs/core/runtime/router.js
var unaborted = new AbortController().signal;
function createRouter() {
  const routes = new Map;
  return {
    add(event, hook, failed) {
      const route = { hook, ...failed === undefined ? {} : { failed } };
      routes.set(event, [...routes.get(event) ?? [], route]);
      return {
        remove() {
          const chain = (routes.get(event) ?? []).filter((each) => each !== route);
          if (chain.length === 0)
            routes.delete(event);
          else
            routes.set(event, chain);
        }
      };
    },
    dispatch(event, e, next, signal = unaborted) {
      const chain = routes.get(event);
      const call = async (index, current) => {
        const route = chain?.[index];
        if (route === undefined)
          return next(current);
        return route.hook(current, Object.assign((passed) => call(index + 1, passed), { signal }));
      };
      return call(0, e);
    },
    dispatchFailure(event, e, error, next, called) {
      const chain = routes.get(event);
      const fail = async (index, current) => {
        const route = chain?.[index];
        if (route === undefined)
          return next(current);
        const answer = await route.failed?.(current, error, Object.assign((passed) => fail(index + 1, passed), { signal: unaborted, called }));
        return answer === undefined ? fail(index + 1, current) : answer;
      };
      return fail(0, e);
    }
  };
}

// node_modules/@cmodjs/core/runtime/state.js
var lifetimes = ["memory", "session", "project", "global"];
var keptProjects = 20;
var listeners = new WeakMap;
function sessionKeyOf(name, key, session) {
  return `${name}.${key}.sessions.${session}`;
}
async function sessionsWith(claude, name, key, value) {
  const prefix = sessionKeyOf(name, key, "");
  const found = [];
  for (const stored of (await claude.store.keys()).filter((each) => each.startsWith(prefix))) {
    if (await claude.store.get(stored) === value)
      found.push(stored.slice(prefix.length));
  }
  return found;
}
function createState({ name, initial, session, root, claude, report, changed: redraw, forkParent }) {
  const changed = () => {
    redraw();
    for (const listener of listeners.get(state) ?? [])
      listener();
  };
  const declared = declaredGroups(name, initial);
  const current = copied(declared);
  let projectRoot = root;
  let sessionId = session;
  let turn = Promise.resolve();
  const inTurn = (task) => {
    const run = turn.then(task);
    turn = Promise.allSettled([run]);
    return run;
  };
  const ownersKey = (lifetime, key) => lifetime === "project" ? `${name}.${key}.projects.` : sessionKeyOf(name, key, "");
  const storeKey = (lifetime, key, owner) => lifetime === "global" ? `${name}.${key}` : `${ownersKey(lifetime, key)}${owner}`;
  const read = (lifetime, key, owner) => claude.store.get(storeKey(lifetime, key, owner));
  const write = async (lifetime, key, value, owner) => {
    if (lifetime !== "project")
      return claude.store.set(storeKey(lifetime, key, owner), value);
    await claude.store.delete(storeKey(lifetime, key, owner));
    await claude.store.set(storeKey(lifetime, key, owner), value);
    const owners = (await claude.store.keys()).filter((stored) => stored.startsWith(ownersKey(lifetime, key)));
    for (const oldest of owners.slice(0, -keptProjects))
      await claude.store.delete(oldest);
  };
  const transcriptsKey = `${name}.$transcripts.`;
  const forgetEndedSessions = async (current) => {
    const stored = await claude.store.keys();
    const ended = async (recorded) => {
      const transcript = await claude.store.get(recorded);
      return typeof transcript !== "string" || !await claude.fs.exists(transcript);
    };
    const owners = stored.filter((key) => key.startsWith(transcriptsKey) && key !== `${transcriptsKey}${current}`);
    await Promise.all(owners.map(async (recorded) => {
      if (!await ended(recorded))
        return;
      const owner = recorded.slice(transcriptsKey.length);
      await Promise.all(stored.filter((key) => key.startsWith(`${name}.`) && key.endsWith(`.sessions.${owner}`)).map((value) => claude.store.delete(value)));
      await claude.store.delete(recorded);
    }));
  };
  const loadGroups = async (only, next) => {
    const loaded = [];
    for (const lifetime of only) {
      for (const key of Object.keys(declared[lifetime]))
        loaded.push([lifetime, key, lifetime === "memory" ? undefined : await read(lifetime, key, lifetime === "project" ? next.root : next.session)]);
    }
    projectRoot = next.root;
    sessionId = next.session;
    for (const [lifetime, key, saved] of loaded)
      current[lifetime][key] = saved === undefined ? declared[lifetime][key] : frozen(name, `${lifetime}.${key}`, saved);
    changed();
  };
  const copySession = async (from, to) => {
    for (const key of Object.keys(declared.session)) {
      const saved = await read("session", key, from);
      if (saved !== undefined)
        await write("session", key, saved, to);
    }
  };
  const hasSaved = async (owner) => (await claude.store.keys()).some((key) => key.startsWith(`${name}.`) && key.endsWith(`.sessions.${owner}`));
  const group = (lifetime) => new Proxy(current[lifetime], {
    set(target, key, value) {
      if (typeof key !== "string")
        throw new Error(`${name}: mod.state.${lifetime} keys are text, not ${String(key)}.`);
      if (!Object.hasOwn(declared[lifetime], key))
        throw new Error(`${name}: mod.state.${lifetime}.${key} is not declared. Add it to state.${lifetime} in defineMod with its starting value.`);
      if (Object.is(target[key], value))
        return true;
      target[key] = frozen(name, `${lifetime}.${key}`, value);
      if (lifetime !== "memory") {
        const owner = lifetime === "project" ? projectRoot : sessionId;
        inTurn(() => write(lifetime, key, value, owner)).catch((error) => {
          report({ id: `state:${lifetime}.${key}`, message: `Could not keep state.${lifetime}.${key}`, error });
        });
      }
      changed();
      return true;
    }
  });
  const state = Object.freeze(Object.fromEntries(Object.keys(initial).map((lifetime) => [lifetime, group(lifetime)])));
  return {
    state,
    get root() {
      return projectRoot;
    },
    changed,
    load: () => inTurn(async () => {
      if (Object.keys(declared.session).length > 0 && !await hasSaved(sessionId)) {
        const parent = await forkParent();
        if (parent !== undefined)
          await copySession(parent, sessionId);
      }
      return loadGroups(lifetimes, { root: projectRoot, session: sessionId });
    }),
    moveTo: (nextRoot) => inTurn(async () => nextRoot === projectRoot ? undefined : loadGroups(["project"], { root: nextRoot, session: sessionId })),
    switchSession: (nextSession, source, transcript) => inTurn(async () => {
      if (Object.keys(declared.session).length > 0) {
        await claude.store.set(`${transcriptsKey}${nextSession}`, transcript);
        forgetEndedSessions(nextSession).catch((error) => report({ id: "state:sessions", message: "Could not forget the session values of ended sessions", error }));
      }
      if (nextSession === sessionId)
        return;
      if (source === "fork")
        await copySession(sessionId, nextSession);
      return loadGroups(["memory", "session"], { root: projectRoot, session: nextSession });
    })
  };
}
function declaredGroups(name, initial) {
  const groups = { memory: {}, session: {}, project: {}, global: {} };
  for (const [lifetime, values] of Object.entries(initial)) {
    if (!isLifetime(lifetime))
      throw new Error(`${name}: state.${lifetime} is not a lifetime. Put each value in state.memory, state.session, state.project, or state.global.`);
    if (!isPlainObject(values))
      throw new Error(`${name}: state.${lifetime} is not an object of values. Write state: { ${lifetime}: { key: value } }.`);
    for (const [key, value] of Object.entries(values))
      groups[lifetime][key] = frozen(name, `${lifetime}.${key}`, value);
  }
  return groups;
}
function copied(groups) {
  return { memory: { ...groups.memory }, session: { ...groups.session }, project: { ...groups.project }, global: { ...groups.global } };
}
function isLifetime(group) {
  return lifetimes.includes(group);
}
function frozen(name, path, value) {
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value))
    return value;
  const copy = isArray ? value.map((item) => frozen(name, path, item)) : Object.fromEntries(Object.entries(value).map(([field, item]) => [field, frozen(name, path, item)]));
  const example = isArray ? `mod.state.${path} = [...mod.state.${path}, item]` : `mod.state.${path} = { ...mod.state.${path}, field: value }`;
  const refuse = () => {
    throw new Error(`${name}: mod.state.${path} cannot change in place. Assign it a new value, such as ${example}, so the mod redraws and keeps it.`);
  };
  return new Proxy(Object.freeze(copy), { set: refuse, defineProperty: refuse, deleteProperty: refuse });
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// node_modules/@cmodjs/core/runtime/toaster.js
var failedMethod = "cmod:failed";
var githubRepository = /^https:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:\/issues)?\/?$/;
var linkLimit = 2048;
var hiddenKey = "cmod:hidden-failures";
var failedCallMs = 30000;
var defaultDuration = 4000;
var visibleToasts = 3;
var spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
var spinnerMs = 100;
var spinFrames = 1e4 / spinnerMs;
var still = "…";
var icons = {
  default: { glyph: " " },
  success: { glyph: "✓", color: "success" },
  info: { glyph: "ℹ", color: "suggestion" },
  warning: { glyph: "⚠", color: "warning" },
  error: { glyph: "✗", color: "error" }
};
function createToaster(claude, name, version) {
  const entries = new Map;
  const hidden = new Map;
  const sent = new Map;
  claude.store.get(hiddenKey).then((saved) => {
    if (typeof saved !== "object" || saved === null)
      return;
    for (const [id, hides] of Object.entries(saved))
      if (typeof hides === "string" && !hidden.has(id))
        hidden.set(id, hides);
  }, (error) => warn("hidden:read", `${name}: could not read the failures you hid: ${messageOf(error)}`));
  let lastId = 0;
  let frame = 0;
  let spinning;
  let isHeld = false;
  let showsAll = false;
  let bandId;
  const isLoading = (entry) => entry.type === "loading" || entry.trying !== undefined;
  const isSpinning = (entry) => entry.spinsFrom !== undefined && frame - entry.spinsFrom < spinFrames;
  const changed = () => {
    for (const entry of entries.values())
      entry.spinsFrom = isLoading(entry) ? entry.spinsFrom ?? frame : undefined;
    const spins = [...entries.values()].some(isSpinning);
    if (spins && spinning === undefined) {
      spinning = claude.clock.every(spinnerMs, () => {
        frame += 1;
        changed();
      });
    }
    if (!spins && spinning !== undefined) {
      spinning.cancel();
      spinning = undefined;
    }
    if (entries.size <= visibleToasts)
      showsAll = false;
    claude.ui.invalidate("ui.render");
  };
  const disarm = (entry) => {
    entry.timer?.cancel();
    entry.timer = undefined;
  };
  const arm = (entry) => {
    const duration = entry.options.duration ?? defaultDuration;
    if (entry.timer !== undefined || entry.type === "loading" || entry.isOpen || !Number.isFinite(duration))
      return;
    entry.timer = claude.clock.after(duration, () => {
      entry.timer = undefined;
      if (isHeld)
        arm(entry);
      else
        dismiss(entry.id);
    });
  };
  const dismiss = (id) => {
    if (id === undefined)
      sent.clear();
    else
      sent.delete(String(id));
    for (const entry of entries.values()) {
      if (id !== undefined && entry.id !== id)
        continue;
      disarm(entry);
      entries.delete(entry.id);
    }
    changed();
  };
  const put = (type, message, options, actions, hides) => {
    const id = options.id ?? (lastId += 1);
    const previous = entries.get(id);
    if (previous?.trying !== undefined && type === "loading") {
      previous.trying = options.description ?? message;
      changed();
      return id;
    }
    if (previous !== undefined)
      disarm(previous);
    const reporting = hides !== undefined && previous?.hides === hides ? previous.reporting : undefined;
    const entry = { id, type, message, options, actions, ...hides === undefined ? {} : { hides }, at: new Date, isOpen: previous?.isOpen ?? false, reporting, timer: undefined };
    if (type === "error" && previous?.message !== message)
      claude.ui.log(`${name}: ${message}${typeof options.description === "string" ? `: ${options.description}` : ""}`, { to: "debug" });
    entries.set(id, entry);
    changed();
    return id;
  };
  const show = (type) => (message, options = {}) => put(type, message, options, options.action === undefined ? [] : [options.action]);
  const hide = (entry) => {
    dismiss(entry.id);
    if (entry.hides === undefined)
      return;
    hidden.set(String(entry.id), entry.hides);
    claude.store.set(hiddenKey, Object.fromEntries(hidden)).catch((error) => warn("hidden:write", `${name}: could not remember the failure you hid: ${messageOf(error)}`));
  };
  const toast = Object.assign(show("default"), {
    success: show("success"),
    info: show("info"),
    warning: show("warning"),
    error: show("error"),
    loading: show("loading"),
    dismiss,
    promise(task, messages) {
      const id = show("loading")(messages.loading);
      const settled = Promise.resolve().then(() => typeof task === "function" ? task() : task).then((value) => {
        show("success")(typeof messages.success === "function" ? messages.success(value) : messages.success, { id });
        return value;
      }, (error) => {
        show("error")(typeof messages.error === "function" ? messages.error(error) : messages.error, { id });
        throw error;
      });
      settled.catch(() => {
        return;
      });
      return { unwrap: () => settled };
    }
  });
  const copy = async (text) => {
    const copied = await claude.ui.copy({ text });
    if (!copied.isCopied)
      throw new Error(copied.reason);
  };
  const press = (entry, run) => () => void Promise.resolve().then(run).catch((error) => fail({ id: `press:${entry.id}`, message: `${entry.message}: the press failed`, error, isCritical: true }));
  const logFailure = (failure) => claude.cmod.call({ to: cmodPluginName, method: failedMethod, input: failure });
  const modVersion = () => claude.fs.read(`${claude.plugin.root}/.claude-plugin/plugin.json`).then((text) => String(JSON.parse(text).version)).catch((failure) => `unknown (${messageOf(failure)})`);
  const detailsOf = (version, at, text) => `${name} ${version}, @cmodjs/core ${coreVersion}, at ${at.toISOString()}
${text}`;
  const warned = new Map;
  const warn = (id, text) => {
    claude.ui.log(text, { to: "debug" });
    const at = new Date;
    const repeat = `${text}
${at.toISOString().slice(0, 16)}`;
    if (warned.get(id) === repeat)
      return;
    warned.set(id, repeat);
    claude.clock.after(0, () => {
      (async () => {
        const version = await modVersion();
        await logFailure({ mod: name, id, message: text, details: detailsOf(version, at, text), at: at.toISOString(), isCritical: false, root: claude.plugin.root, level: "warning", version, core: coreVersion });
      })().catch(() => {
        return;
      });
    });
  };
  const showsToast = async (failure, isShown) => {
    try {
      const logged = logFailure(failure);
      const answer = await (isShown ? logged : beforeDeadline(claude, { ms: failedCallMs }, failedMethod, logged));
      if (isObject(answer) && typeof answer["showsToast"] === "boolean")
        return answer["showsToast"];
      throw new Error(`cmod answered ${answer === undefined ? "nothing" : JSON.stringify(answer)}, not { showsToast: true or false }`);
    } catch (error) {
      claude.ui.log(`${name}: cmod kept no Log of ${failure.id}, so it shows the toast: ${messageOf(error)}`, { to: "debug" });
      return;
    }
  };
  const fail = ({ id, message, error, description = error === undefined || describe(error) === message ? undefined : describe(error), retry, isCritical = false }) => {
    const hides = `${version() ?? ""}
${message}
${error === undefined ? "" : describe(error)}`;
    const at = new Date;
    const repeat = `${hides}
${description ?? ""}
${at.toISOString().slice(0, 16)}`;
    if (sent.get(id) === repeat)
      return id;
    sent.set(id, repeat);
    const stack = error instanceof Error && error.stack !== undefined ? `

${error.stack}` : "";
    const details = async (failedAt) => detailsOf(await modVersion(), failedAt, `${message}${description === undefined ? "" : `
${description}`}${stack}`);
    const logged = async () => {
      const contact = await contactOf(claude);
      const version = await modVersion();
      const failure = { mod: name, id, message, details: detailsOf(version, at, `${message}${description === undefined ? "" : `
${description}`}${stack}`), at: at.toISOString(), isCritical, root: claude.plugin.root, ...contact === undefined ? {} : { contact }, level: "error", version, core: coreVersion };
      const shows = await showsToast(failure, isCritical);
      if (isCritical)
        return;
      if (shows !== false)
        return show();
      claude.ui.log(`${name}: ${message}${description === undefined ? "" : `: ${description}`}`, { to: "debug" });
    };
    const show = () => {
      if (hidden.get(id) === hides)
        return;
      hidden.delete(id);
      const shown = entries.get(id);
      if (shown?.hides === hides && shown.trying === undefined && shown.options.description === description) {
        const previous = clockTime(shown.at);
        shown.at = new Date;
        if (clockTime(shown.at) !== previous)
          changed();
        return;
      }
      const actions = [...fixes, ...retry === undefined ? [] : [{ label: "Retry", onClick: tryAgain }], { label: "Report", onClick: startReporting }];
      put("error", message, { id, ...description === undefined ? {} : { description }, duration: Infinity }, actions, hides);
    };
    const startReporting = async () => {
      const shown = entries.get(id);
      if (shown === undefined)
        return;
      shown.reporting = { contact: await contactOf(claude), details: await details(shown.at) };
      disarm(shown);
      changed();
      if (bandId === undefined)
        return;
      const focused = await claude.ui.focus({ requestId: bandId, key: `toast:${id}:ask-claude` });
      if ("deny" in focused)
        warn("report:focus", `${name}: the Report choices did not take the keys: ${String(focused.deny)}`);
    };
    const tryAgain = async () => {
      const shown = entries.get(id);
      if (shown === undefined || retry === undefined || shown.trying !== undefined)
        return;
      shown.trying = "Starting";
      changed();
      try {
        await retry();
      } finally {
        if (entries.get(id) === shown) {
          shown.trying = undefined;
          changed();
        }
      }
    };
    const fixes = [
      { sentence: installFix, label: "Plugins", onClick: () => claude.command.run({ command: "plugin" }) },
      { sentence: secretFix, label: "Open /config", onClick: () => claude.command.run({ command: "config" }) }
    ].filter(({ sentence }) => `${message}
${description ?? ""}`.includes(sentence));
    if (isCritical)
      show();
    claude.clock.after(0, () => void logged());
    return id;
  };
  const toggle = (entry) => () => {
    entry.isOpen = !entry.isOpen;
    disarm(entry);
    changed();
  };
  const row = (entry, columns) => {
    const { description } = entry.options;
    const isText = typeof description === "string";
    const icon = entry.type === "loading" || entry.trying !== undefined ? { glyph: isSpinning(entry) ? spinner[frame % spinner.length] : still, color: "claude" } : icons[entry.type];
    const message = isText ? Button({ plain: true, key: `toast:${entry.id}:open`, label: entry.message, onPress: toggle(entry) }) : Text({ children: entry.message });
    const details = !isText ? description : Text({ dimColor: true, wrap: entry.isOpen ? "wrap" : "truncate-end", children: entry.isOpen ? description : firstLine(description) });
    const fixed = (child) => Box({ flexShrink: 0, children: child });
    const close = Button({ plain: true, dimColor: true, key: `toast:${entry.id}:close`, label: entry.hides === undefined ? "✕" : "Hide", onPress: () => hide(entry) });
    const actions = entry.actions.map((action, index) => Button({ plain: true, key: `toast:${entry.id}:${index === 0 ? "action" : `action-${index}`}`, label: action.label, onPress: press(entry, action.onClick) }));
    const buttons = Box({ gap: 2, flexWrap: "wrap", children: [...actions, Text({ dimColor: true, children: clockTime(entry.at) })].map(fixed) });
    const trying = entry.trying === undefined ? undefined : Box({ gap: 1, children: [Text({ dimColor: true, children: "Trying again:" }), typeof entry.trying === "string" ? Text({ dimColor: true, wrap: "truncate-end", children: entry.trying }) : entry.trying] });
    const text = details === undefined ? [message] : [message, trying ?? details];
    const under = trying !== undefined && details === undefined ? [trying] : entry.reporting === undefined ? [buttons] : reportChoices(entry, entry.reporting);
    return Box({
      width: columns,
      gap: 2,
      justifyContent: "space-between",
      children: [
        Box({
          gap: 2,
          flexShrink: 1,
          children: [
            fixed(Text({ ...icon.color === undefined ? {} : { color: icon.color }, children: icon.glyph })),
            fixed(Text({ dimColor: true, children: name })),
            Box({ flexDirection: "column", flexShrink: 1, children: entry.hides === undefined ? text : [...text, ...under] })
          ]
        }),
        Box({ gap: 2, flexShrink: 0, alignSelf: "flex-end", children: entry.hides === undefined ? [...actions, close] : [close] })
      ]
    });
  };
  const reportChoices = (entry, { contact, details, status }) => {
    const say = (said) => {
      entry.reporting = { contact, details, status: said };
      changed();
    };
    const back = () => {
      entry.reporting = undefined;
      changed();
    };
    const askClaude = async () => {
      await claude.prompt.submit({ text: reportPrompt(name, contact, details), asUser: true });
      back();
    };
    const copyError = async () => {
      const copied = await claude.ui.copy({ text: details });
      say(copied.isCopied ? "Copied the error." : `Could not copy it: ${copied.reason}`);
    };
    const report = contact === undefined ? [] : [reportLink(contact, name, entry.message, details)];
    return [
      Text({ dimColor: true, children: "Claude writes up the problem and files it with your tools. You approve each step before anything is posted." }),
      Box({
        gap: 2,
        flexWrap: "wrap",
        children: [
          Button({ plain: true, key: `toast:${entry.id}:ask-claude`, label: "Ask Claude to report it", onPress: press(entry, askClaude) }),
          ...report,
          Button({ plain: true, key: `toast:${entry.id}:copy`, label: "Copy the error", onPress: press(entry, copyError) }),
          Button({ plain: true, dimColor: true, key: `toast:${entry.id}:back`, label: "Back", onPress: back })
        ]
      }),
      ...status === undefined ? [] : [Text({ dimColor: true, children: status })]
    ];
  };
  return {
    toast,
    copy,
    fail,
    warn,
    get shown() {
      return [...entries.values()].map(({ type, message, options }) => ({ type, message, ...typeof options.description === "string" ? { description: options.description } : {} }));
    },
    draw(drawn, table, band, drawnIn) {
      bandId = drawnIn;
      isHeld = band.hasSurvey === true;
      if (isHeld || entries.size === 0)
        return drawn;
      const all = [...entries.values()];
      const hidden = showsAll ? 0 : Math.max(all.length - visibleToasts, 0);
      for (const entry of all.slice(hidden))
        arm(entry);
      const more = Button({
        plain: true,
        dimColor: true,
        key: "toasts:more",
        label: `+${hidden} more`,
        onPress: () => {
          showsAll = true;
          changed();
        }
      });
      return drawWith(table, () => Box({ flexDirection: "column", children: [drawn, ...hidden > 0 ? [more] : [], ...all.slice(hidden).map((entry) => row(entry, band.bodyColumns))] }));
    }
  };
}
function describe(error) {
  const messages = [];
  for (let cause = error;cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) {
    const text = messageOf(cause);
    if (!messages.some((earlier) => earlier.includes(text) || text.includes(earlier)))
      messages.push(text);
  }
  return messages.join(`
`);
}
async function contactOf(claude) {
  const manifest = await claude.fs.read(`${claude.plugin.root}/.claude-plugin/plugin.json`).then((text) => JSON.parse(text)).catch((error) => {
    claude.ui.log(`${claude.plugin.name}: could not read whom to report to: ${messageOf(error)}`, { to: "debug" });
    return {};
  });
  const repositoryUrl = isObject(manifest["repository"]) ? manifest["repository"]["url"] : manifest["repository"];
  const repository = [manifest["supportUrl"], repositoryUrl].map((url) => typeof url === "string" ? githubRepository.exec(url)?.[1] : undefined).find((found) => found !== undefined);
  if (repository !== undefined)
    return { kind: "github", repository };
  const author = manifest["author"];
  const address = isObject(author) ? author["email"] : undefined;
  return typeof address === "string" && address !== "" ? { kind: "email", address } : undefined;
}
function reportLink(contact, name, message, details) {
  const title = `${name}: ${message}`.slice(0, 120);
  const linkOf = (body) => contact.kind === "github" ? `https://github.com/${contact.repository}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}` : `mailto:${contact.address}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  let body = details;
  while (linkOf(body).length > linkLimit && body.length > 0)
    body = `${body.slice(0, Math.floor(body.length * 0.8))}…`;
  return Link({ href: linkOf(body), label: contact.kind === "github" ? "Report it on GitHub (opens your browser)" : "Email the author (opens your mail app)" });
}
function reportPrompt(name, contact, details) {
  const where = contact === undefined ? `${name} names no place to report it, so find its author from its plugin.json or its marketplace.` : contact.kind === "github" ? `Report it as an issue on https://github.com/${contact.repository}.` : `Email it to ${contact.address}.`;
  return `The ${name} mod failed. Report it to its author. ${where} First check whether it is reported already, and add to that report instead of filing a new one. Show me the report before you post it.

${details}`;
}
function clockTime(at) {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// node_modules/@cmodjs/core/runtime/hotkeys.js
async function readCombos(claude, configRoot) {
  if (configRoot === undefined)
    return new Map;
  const text = await claude.fs.read(`${configRoot}/keybindings.json`).catch(ifMissing("{}"));
  try {
    return boundCombos(JSON.parse(text));
  } catch (error) {
    claude.ui.warn("hotkeys:read", `${configRoot}/keybindings.json is not JSON, so cmod reads no combos from it: ${messageOf(error)}`);
    return new Map;
  }
}
async function createHotkeys({ name, declared, configRoot, claude, router, answerInput, report }) {
  if (name === cmodPluginName) {
    router.add("command.describe", async (e, next) => {
      const described = await next(e);
      return e.command.startsWith(hotkeyCommand(e.provider.plugin.replace(/@[^@]*$/, ""), "")) ? { ...described, isHidden: true } : described;
    });
  }
  const entries = Object.entries(declared);
  if (entries.length === 0)
    return {};
  const combos = await readCombos(claude, configRoot);
  const listeners = new Map;
  const commands = new Map;
  for (const [hotkey, { title }] of entries) {
    listeners.set(hotkey, new Set);
    claude.command.register({ name: hotkeyCommand(name, hotkey), description: title, immediate: true }).then(({ command }) => void commands.set(command, hotkey), (error) => report({ id: `hotkey:${hotkey}`, message: `The ${title} hotkey is not added`, error }));
  }
  router.add("command.run", async (e, next) => {
    const hotkey = commands.get(e.command);
    if (hotkey === undefined)
      return next(e);
    return answerInput(async () => {
      for (const listener of listeners.get(hotkey) ?? []) {
        try {
          await listener();
        } catch (error) {
          report({ id: `hotkey:${hotkey}`, message: `The ${declared[hotkey]?.title ?? hotkey} hotkey failed`, error, isCritical: true });
        }
      }
      return {};
    }, () => next(e));
  });
  return Object.fromEntries(entries.map(([hotkey, { title }]) => [
    hotkey,
    {
      title,
      combo: combos.get(hotkeyCommand(name, hotkey)),
      onPress(listener) {
        listeners.get(hotkey)?.add(listener);
        return { remove: () => void listeners.get(hotkey)?.delete(listener) };
      }
    }
  ]));
}

// node_modules/@cmodjs/core/runtime/pages.js
var askedWaitMs = 1000;
function pagesOf(input) {
  const listed = isObject(input) && Array.isArray(input["pages"]) ? input["pages"] : [];
  return listed.filter(isObject).flatMap((each) => typeof each["id"] === "string" && typeof each["title"] === "string" && (each["place"] === "sidebar" || each["place"] === "settings") ? [{ id: each["id"], title: each["title"], place: each["place"] }] : []);
}
function servePages({ claude, router, report, widgets, parts, tellStylers }) {
  const declared = new Map;
  const stylers = new Set;
  const asking = new Map;
  const pressing = new Set;
  let waiting = [];
  let inputDepth = 0;
  let applyTo = async () => {
    return;
  };
  const run = (mod, requests) => applyTo(mod, requests).catch((error) => report(`pages:${mod}`, `Could not show the page ${mod} asked for`, error));
  const takeWaiting = async () => {
    const taken = waiting;
    waiting = [];
    for (const { mod, requests } of taken)
      await run(mod, requests);
  };
  const settle = async (earlier) => {
    const own = () => [...pressing].filter((pending) => !earlier.has(pending));
    for (let pending = own();pending.length > 0; pending = own())
      await Promise.allSettled(pending);
    await takeWaiting();
  };
  const wrapped = async (next) => {
    inputDepth += 1;
    const earlier = new Set(pressing);
    try {
      const answer = await next();
      await settle(earlier);
      return answer;
    } finally {
      inputDepth -= 1;
    }
  };
  router.add("command.run", (e, next) => wrapped(async () => waiting.length > 0 ? {} : next(e)));
  router.add("ui.press", (e, next) => wrapped(() => next(e)));
  const ask = (mod) => {
    const pending = asking.get(mod) ?? claude.cmod.call({ to: mod, method: partMethods.list, input: null }).then((parts) => void declared.set(mod, pagesOf(parts)), (error) => {
      if (!isNotInstalled(mod, error))
        claude.ui.warn(`pages:list:${mod}`, `cmod: ${mod} did not list its pages: ${messageOf(error)}`);
    }).finally(() => asking.delete(mod));
    asking.set(mod, pending);
    return pending;
  };
  const restyle = (mod, isStyler) => {
    if (!isStyler && !stylers.delete(mod))
      return;
    if (isStyler)
      stylers.add(mod);
    parts.forget(mod);
    const listed = [...stylers];
    tellStylers(listed);
    for (const told of declared.keys()) {
      if (told !== cmodPluginName)
        claude.cmod.call({ to: told, method: partMethods.stylers, input: listed }).catch((error) => claude.ui.warn(`pages:stylers:${told}`, `cmod: ${told} did not hear which mods style markdown: ${messageOf(error)}`));
    }
  };
  const update = (mod, { parts: listing, redraw, requests, isAsked }) => {
    if (listing !== undefined)
      declared.set(mod, pagesOf(listing));
    if (listing !== undefined)
      restyle(mod, isObject(listing) && listing["stylesMarkdown"] === true);
    const isRedrawn = redraw === true || requests?.some((request) => ("open" in request)) === true;
    if (listing !== undefined || isRedrawn)
      widgets.update(mod, { ...listing === undefined ? {} : { parts: listing }, ...isRedrawn ? { redraw: true } : {} });
    if (requests === undefined || requests.length === 0)
      return false;
    if (isAsked !== true)
      return void run(mod, requests), false;
    waiting.push({ mod, requests });
    if (inputDepth > 0)
      return true;
    claude.clock.after(askedWaitMs, () => void takeWaiting());
    return false;
  };
  const press = (mod, input) => {
    const pending = claude.cmod.call({ to: mod, method: partMethods.press, input }).then((answer) => void update(mod, isObject(answer) ? answer : {}), (error) => {
      parts.forget(mod);
      claude.ui.invalidate("ui.render");
      if (messageOf(error).includes(stalePress))
        claude.ui.log(`cmod: ${mod} draws its page again, because the button pressed was from an older drawing:${messageOf(error)}`, { to: "debug" });
      else
        report(`press:${mod}`, `${mod} did not take the press`, error);
    }).finally(() => pressing.delete(pending));
    pressing.add(pending);
    if (inputDepth === 0)
      pending.then(takeWaiting);
  };
  const lastDrawn = new Map;
  const plain = (data) => JSON.parse(JSON.stringify(data));
  return {
    declared: () => [...declared].map(([mod, pages]) => ({ mod, pages })),
    stylers: () => [...stylers],
    element(mod, page, params, columns, isFocused) {
      if (!declared.has(mod))
        ask(mod);
      const given = JSON.stringify(params ?? null);
      const cached = `${page}\x00${given}\x00${columns}\x00${isFocused}`;
      const name = `The ${page} page of ${mod}`;
      const keyPrefix = `${mod}/${page}:`;
      parts.fill(mod, cached, { page, params: plain(params ?? null), columns, isFocused }, name)?.then(() => claude.ui.invalidate("ui.render"));
      const failure = parts.failure(mod, cached);
      const drawnAt = (key) => parts.element(mod, key, keyPrefix, name, `page:${mod}/${page}`);
      const last = lastDrawn.get(keyPrefix);
      const drawn = drawnAt(cached);
      if (drawn !== undefined)
        lastDrawn.set(keyPrefix, { params: given, cached });
      return drawn ?? (last?.params === given ? drawnAt(last.cached) : undefined) ?? (failure === undefined ? undefined : Text({ color: "error", children: `${name} could not draw: ${failure}` }));
    },
    press,
    update,
    tell(mod, shown) {
      claude.cmod.call({ to: mod, method: partMethods.shown, input: plain(shown) }).catch((error) => claude.ui.warn(`pages:shown:${mod}`, `cmod: ${mod} did not hear which of its pages show: ${messageOf(error)}`));
    },
    apply(listener) {
      applyTo = listener;
    }
  };
}

// node_modules/@cmodjs/core/runtime/parts.js
var keptDrawings = 200;
function drawnParts({ claude, report, press }) {
  const drawn = new Map;
  const drawing = new Map;
  const generations = new Map;
  const keyOf = (mod, cached) => `${mod}\x00${cached}`;
  const generationOf = (mod) => generations.get(mod) ?? 0;
  return {
    fill(mod, cached, input, name) {
      const key = keyOf(mod, cached);
      const generation = generationOf(mod);
      if (drawn.get(key)?.generation === generation)
        return;
      const keep = (data, failure) => {
        drawn.delete(key);
        drawn.set(key, { data, ...failure === undefined ? {} : { failure }, generation });
        const [oldest] = drawn.keys();
        if (drawn.size > keptDrawings && oldest !== undefined)
          drawn.delete(oldest);
        if (generationOf(mod) !== generation)
          claude.ui.invalidate("ui.render");
      };
      const pending = drawing.get(key) ?? claude.cmod.call({ to: mod, method: partMethods.draw, input }).then((data) => keep(data ?? null), (error) => {
        report(`draw:${mod}`, `${name} drew nothing`, error);
        keep(drawn.get(key)?.data ?? null, messageOf(error));
      }).finally(() => drawing.delete(key));
      drawing.set(key, pending);
      return pending;
    },
    element(mod, cached, keyPrefix, name, reportId) {
      const key = keyOf(mod, cached);
      const entry = drawn.get(key);
      if (entry === undefined)
        return;
      drawn.delete(key);
      drawn.set(key, entry);
      const { data } = entry;
      if (data === null || data.tree === null)
        return;
      try {
        return elementOf(data.tree, keyPrefix, (handler, args) => press(mod, { draw: data.draw, handler, args }));
      } catch (error) {
        report(reportId, `${name} could not draw`, error);
        return;
      }
    },
    failure(mod, cached) {
      return drawn.get(keyOf(mod, cached))?.failure;
    },
    forget(mod) {
      generations.set(mod, generationOf(mod) + 1);
    }
  };
}

// node_modules/@cmodjs/core/runtime/watches.js
var watchMs = 500;
var missingEvery = 4;
var watchedFiles = 2000;
function createWatches(claude, report) {
  const watches = new Set;
  let polling;
  let isPolling = false;
  let ticks = 0;
  const stampsOf = async (watch) => {
    const { paths } = watch;
    const stamps = new Map;
    const missing = new Set;
    const skipped = ticks % missingEvery === 0 ? new Set : watch.missing;
    const visit = async (path) => {
      const stat = await claude.fs.stat(path).catch(ifMissing(undefined));
      if (stat === undefined)
        return;
      if (stat.kind !== "dir") {
        if (stamps.size === watchedFiles)
          throw new Error(`fs.onChange watches at most ${watchedFiles} files, and ${paths.join(", ")} holds more, so it stopped. Watch a smaller folder.`);
        return void stamps.set(path, stat.mtimeMs);
      }
      for (const entry of await claude.fs.list(path).catch(ifMissing([])))
        await visit(`${path}/${entry.name}`);
    };
    for (const path of paths) {
      if (skipped.has(path)) {
        missing.add(path);
        continue;
      }
      await visit(path);
      if (![...stamps.keys()].some((seen) => seen === path || seen.startsWith(`${path}/`)))
        missing.add(path);
    }
    watch.missing = missing;
    return stamps;
  };
  const stop = (watch) => {
    watches.delete(watch);
    if (watches.size > 0)
      return;
    polling?.cancel();
    polling = undefined;
  };
  const stampsOrStop = (watch) => stampsOf(watch).catch((error) => {
    stop(watch);
    report({ id: "fs:onChange", message: "Could not read the files fs.onChange watches", error });
    return;
  });
  const poll = async () => {
    if (isPolling)
      return;
    isPolling = true;
    ticks += 1;
    try {
      for (const watch of watches) {
        const now = await stampsOrStop(watch);
        if (now === undefined)
          continue;
        const before = watch.seen;
        watch.seen = now;
        if (before === undefined)
          continue;
        const changes = [
          ...[...now].filter(([path, at]) => before.has(path) && before.get(path) !== at).map(([path]) => ({ path, type: "change" })),
          ...[...now.keys()].filter((path) => !before.has(path)).map((path) => ({ path, type: "add" })),
          ...[...before.keys()].filter((path) => !now.has(path)).map((path) => ({ path, type: "unlink" }))
        ];
        for (const change of changes)
          await Promise.resolve().then(() => watch.listener(change)).catch((error) => report({ id: "fs:onChange", message: "The fs.onChange listener failed", error }));
      }
    } finally {
      isPolling = false;
    }
  };
  return {
    add(paths, listener) {
      const watch = { paths, listener, seen: undefined, missing: new Set };
      watches.add(watch);
      stampsOrStop(watch).then((stamps) => void (watch.seen ??= stamps));
      polling ??= claude.clock.every(watchMs, () => void poll());
      return { remove: () => stop(watch) };
    }
  };
}

// node_modules/@cmodjs/core/runtime/widgets.js
var claudeHint = "claude/hint";
var claudeModes = "claude/modes";
var builtInWidgets = [
  { key: claudeHint, mod: "claude", title: "Claude Code's hint", areas: [BelowPrompt] },
  { key: claudeModes, mod: "claude", title: "Claude Code's mode labels", areas: [BelowPrompt] }
];
var promptIndent = 4;
var transcriptIndent = 2;
var widgetSizes = { fit: { flexShrink: 0 }, fill: { flexGrow: 1, flexShrink: 1, minWidth: 0 } };
var separator = "";
function layoutOf(value) {
  const keys = (list) => Array.isArray(list) ? list.filter((key) => typeof key === "string") : [];
  const rowsOf = (list) => Array.isArray(list) ? list.filter(isObject).map((row) => ({ ...row, left: keys(row["left"]), right: keys(row["right"]) })) : [];
  const stored = isObject(value) && isObject(value["areas"]) ? value["areas"] : {};
  return { areas: Object.fromEntries(areas.map((area) => [area, rowsOf(stored[area])])), hidden: isObject(value) ? keys(value["hidden"]) : [] };
}
var stringsIn = (value) => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : isObject(value) ? Object.values(value).flatMap(stringsIn) : [];
var holds = (row, key) => row.left.includes(key) || row.right.includes(key);
function placedIn(layout, key) {
  return areas.find((area) => layout.areas[area].some((row) => holds(row, key)));
}
function toggled(layout, key) {
  return { ...layout, hidden: layout.hidden.includes(key) ? layout.hidden.filter((each) => each !== key) : [...layout.hidden, key] };
}
function moved(layout, widget, move) {
  const area = placedIn(layout, widget.key);
  if (area === undefined)
    return layout;
  const rows = layout.areas[area];
  const at = rows.findIndex((row) => holds(row, widget.key));
  const row = rows[at];
  const side = row.left.includes(widget.key) ? "left" : "right";
  const withAreas = (changed) => ({ ...layout, areas: { ...layout.areas, ...Object.fromEntries(Object.entries(changed).map(([name, list]) => [name, list.filter((each) => stringsIn(each).length > 0)])) } });
  if (move === "left" || move === "right") {
    const sequence = [...row.left, separator, ...row.right];
    const from = sequence.indexOf(widget.key);
    const to = move === "left" ? from - 1 : from + 1;
    if (to < 0 || to >= sequence.length)
      return layout;
    [sequence[from], sequence[to]] = [sequence[to], widget.key];
    const split = sequence.indexOf(separator);
    return withAreas({ [area]: rows.map((each, index) => index === at ? { ...each, left: sequence.slice(0, split), right: sequence.slice(split + 1) } : each) });
  }
  const without = rows.map((each, index) => index === at ? { ...each, left: each.left.filter((key) => key !== widget.key), right: each.right.filter((key) => key !== widget.key) } : each);
  const added = (target) => ({ ...target, left: target?.left ?? [], right: target?.right ?? [], [side]: [...target?.[side] ?? [], widget.key] });
  const target = at + (move === "up" ? -1 : 1);
  if (target >= 0 && target < rows.length)
    return withAreas({ [area]: without.map((each, index) => index === target ? added(each) : each) });
  if (move === "down" && row.left.length + row.right.length > 1)
    return withAreas({ [area]: [...without, added(undefined)] });
  const next = (move === "up" ? areas.slice(0, areas.indexOf(area)).reverse() : areas.slice(areas.indexOf(area) + 1)).find((each) => widget.areas.includes(each));
  if (next === undefined)
    return layout;
  const nextRows = layout.areas[next];
  const landing = move === "up" ? [...nextRows.slice(0, -1), added(nextRows.at(-1))] : [added(nextRows[0]), ...nextRows.slice(1)];
  return withAreas({ [area]: without, [next]: landing });
}
function declarationsOf(input) {
  const listed = isObject(input) && Array.isArray(input["widgets"]) ? input["widgets"] : [];
  return listed.filter(isObject).flatMap((each) => {
    const known = Array.isArray(each["areas"]) ? each["areas"].filter((area) => areas.includes(area)) : [];
    const { side, size } = isObject(each["place"]) ? each["place"] : {};
    const place = { ...side === "left" || side === "right" ? { side } : {}, ...size === "fit" || size === "fill" ? { size } : {} };
    return typeof each["id"] === "string" && typeof each["title"] === "string" && known.length > 0 ? [{ id: each["id"], title: each["title"], areas: known, place }] : [];
  });
}
function serveWidgets({ claude, router, store, report, turnClosedBy, parts, markdownIn }) {
  const path = widgetsPath(store);
  const declared = new Map;
  let stored = layoutOf({});
  let layout = stored;
  let saving = Promise.resolve();
  let placedKeys = new Set;
  const readFile = async () => {
    const file = JSON.parse(await claude.fs.read(path).catch(ifMissing("{}")));
    placedKeys = new Set(stringsIn(isObject(file) ? file["areas"] : undefined));
    return file;
  };
  const read = async () => layoutOf(await readFile());
  const redraw = () => claude.ui.invalidate("ui.render");
  const placed = () => [...builtInWidgets, ...[...declared].flatMap(([mod, list]) => list.map(({ id, title, areas: listed, place }) => ({ key: `${mod}/${id}`, mod, title, areas: listed, ...place === undefined ? {} : { place } })))];
  const change = (edit) => {
    saving = saving.then(async () => {
      const file = await readFile();
      stored = layoutOf(file);
      const current = withNewWidgets(stored);
      const next = edit(current);
      if (next !== current) {
        const kept = isObject(file) ? file : {};
        await claude.fs.write(path, `${JSON.stringify({ ...kept, ...next, areas: { ...isObject(kept["areas"]) ? kept["areas"] : {}, ...next.areas } }, null, 2)}
`);
        await claude.fs.write(storeChangedPath(store), "");
        stored = next;
      }
      place();
    }).catch((error) => report("widgets:layout", "Could not save the widget layout", error));
    return saving;
  };
  const place = () => {
    layout = withNewWidgets(stored);
    redraw();
  };
  const withNewWidgets = (current) => placed().filter(({ key, mod }) => mod !== "claude" && placedIn(current, key) === undefined && !placedKeys.has(key)).reduce((next, { key, areas: [area = AbovePrompt], place }) => {
    const [first, ...rest] = next.areas[area];
    const row = { ...first, left: first?.left ?? [], right: first?.right ?? [] };
    const side = place?.side ?? "left";
    return { ...next, areas: { ...next.areas, [area]: [{ ...row, [side]: [...row[side], key] }, ...rest] } };
  }, current);
  const ask = async (mod) => {
    try {
      declared.set(mod, declarationsOf(await claude.cmod.call({ to: mod, method: partMethods.list, input: null })));
    } catch (error) {
      declared.delete(mod);
      if (!isNotInstalled(mod, error))
        claude.ui.warn(`widgets:list:${mod}`, `cmod: ${mod} did not list its widgets: ${messageOf(error)}`);
    }
  };
  const recheck = async () => {
    const mods = [...declared.keys()];
    await Promise.all(mods.map(ask));
    for (const mod of mods)
      parts.forget(mod);
    redraw();
  };
  const reload = async () => {
    stored = await read();
    if (JSON.stringify(withNewWidgets(stored)) !== JSON.stringify(layout))
      place();
  };
  saving = (async () => {
    const recorded = (await claude.fs.list(`${store}/records`).catch(ifMissing([]))).map((entry) => entry.name).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
    stored = await read().catch((error) => {
      report("widgets:layout", "Could not read the widget layout", error);
      return stored;
    });
    const named = areas.flatMap((area) => stored.areas[area].flatMap((row) => [...row.left, ...row.right])).map((key) => key.slice(0, key.indexOf("/")));
    await Promise.all([...new Set([...recorded, ...named])].filter((mod) => mod !== cmodPluginName && mod !== "claude" && !declared.has(mod)).map(ask));
    place();
  })().catch((error) => report("widgets:layout", "Could not list the widgets of the mods", error));
  const widgetOf = (key) => placed().find((widget) => widget.key === key);
  const cacheKey = (key, area, columns, turn) => `${key}\x00${area}\x00${columns}\x00${turn?.prompt.id ?? ""}`;
  const nameOf = (widget) => `The ${widget.title} widget of ${widget.mod}`;
  const fill = (key, area, columns, turn) => {
    const widget = widgetOf(key);
    if (widget === undefined || !widget.areas.includes(area))
      return;
    return parts.fill(widget.mod, cacheKey(key, area, columns, turn), { widget: key.slice(widget.mod.length + 1), area, columns, ...turn === undefined ? {} : { turn } }, nameOf(widget));
  };
  const elementFor = (key, area, columns, turn) => {
    const widget = widgetOf(key);
    if (widget === undefined)
      return;
    const element = parts.element(widget.mod, cacheKey(key, area, columns, turn), `${key}:`, nameOf(widget), `widget:${key}`);
    return element === undefined ? undefined : Box({ ...widgetSizes[widget.place?.size ?? "fit"], children: element });
  };
  const isHidden = (key) => layout.hidden.includes(key);
  const shown = (keys) => keys.filter((key) => !isHidden(key));
  const rowsNow = (area, columns, turn) => layout.areas[area].flatMap((row) => {
    const side = (keys) => shown(keys).map((key) => elementFor(key, area, columns, turn)).filter((each) => each !== undefined);
    const left = side(row.left);
    const right = side(row.right);
    const group = (keys, children) => Box({ flexShrink: shown(keys).some((key) => widgetOf(key)?.place?.size === "fill") ? 1 : 0, minWidth: 0, columnGap: 2, children });
    return left.length + right.length === 0 ? [] : [Box({ justifyContent: "space-between", width: columns, columnGap: 2, children: [group(row.left, left), group(row.right, right)] })];
  });
  const keysIn = (area) => layout.areas[area].flatMap((row) => shown([...row.left, ...row.right]));
  const draw = async (area, table, at, turn) => {
    await Promise.all(keysIn(area).map((key) => fill(key, area, at.columns, turn)));
    return drawWith(table, () => rowsNow(area, at.columns, turn), markdownIn(table, at));
  };
  const rows = (area, columns) => {
    const started = keysIn(area).flatMap((key) => fill(key, area, columns, undefined) ?? []);
    if (started.length > 0)
      Promise.all(started).then(redraw);
    return rowsNow(area, columns, undefined);
  };
  const column = (table, children) => drawWith(table, () => Box({ flexDirection: "column", children }));
  const below = (table, above, added) => added.length === 0 ? above : column(table, [above, ...added]);
  router.add("ui.render", async (e, next) => {
    const table = claude.ui.resolve(e);
    const inTranscript = styledAt(e, viewportColumns(e) - transcriptIndent);
    if (e.component === "AbovePrompt")
      return e.props.hasSurvey ? next(e) : below(table, await next(e), await draw(AbovePrompt, table, styledAt(e, e.props.bodyColumns)));
    if (e.component === "PromptHint") {
      const added = await draw(BelowPrompt, table, styledAt(e, viewportColumns(e) - promptIndent));
      return isHidden(claudeHint) ? column(table, added) : below(table, await next(e), added);
    }
    if (e.component === "SessionMode")
      return isHidden(claudeModes) ? column(table, []) : next(e);
    if (e.component === "Spinner")
      return below(table, await next(e), await draw(Working, table, inTranscript));
    if (e.component === "TurnDuration") {
      const turn = turnClosedBy(e.requestId);
      return below(table, await next(e), turn === undefined ? [] : await draw(TurnEnd, table, inTranscript, turn));
    }
    return next(e);
  });
  return {
    update(mod, { parts: listing, redraw }) {
      if (listing === undefined && redraw !== true)
        return;
      parts.forget(mod);
      if (listing !== undefined) {
        const listed = declarationsOf(listing);
        const isNewList = JSON.stringify(listed) !== JSON.stringify(declared.get(mod) ?? []);
        declared.set(mod, listed);
        if (isNewList)
          return place();
      }
      claude.ui.invalidate("ui.render");
    },
    widgets: placed,
    layout: () => layout,
    change,
    reload,
    recheck,
    rows,
    draw
  };
}

// node_modules/@cmodjs/core/ui/components.js
function Panel({ title, children }) {
  return Box({
    flexDirection: "column",
    flexGrow: 1,
    children: [
      Box({ flexDirection: "column", flexGrow: 1, minWidth: [...title].length + 6, borderStyle: "round", borderColor: "subtle", paddingX: 1, children }),
      Box({ position: "absolute", top: 0, left: 2, children: Text({ bold: true, wrap: "truncate-end", children: ` ${title} ` }) })
    ]
  });
}
function Progress({ value, width = 24 }) {
  const filled = Math.round(Math.min(Math.max(value, 0), 100) / 100 * width);
  return Text({ children: [Text({ color: "claude", children: "█".repeat(filled) }), Text({ color: "subtle", children: "░".repeat(width - filled) })] });
}

// node_modules/@cmodjs/core/runtime/lifecycle.js
var listenMethods = [conversationMethods.subscribe, conversationMethods.watchBefore];
var announcedKey = "cmod:announced";
var cmodUpdatedKey = "cmod:cmod-updated-for";
var installId = "cmod:install";
var askingId = "cmod:asking";
var recordId = "cmod:record";
var installRetrySeconds = [2, 4, 8, 16, 32, 64, 128];
var cmodCheckMs = 1000;
var recordCheckMs = 1000;
var drawsPerMs = 1000;
var cmodWaitMs = 60000;
var cmodSlowCheckMs = 1e4;
var hookMs = 1e4;
var startHoldMs = hookMs - 1000;
var dependencyCallMs = 30000;
var stallTicks = 3;
var stallMs = 60000;
var shellTools = ["Bash", "PowerShell"];
async function readPlugin(claude) {
  const { name, root } = claude.plugin;
  const read = async (path) => {
    const stat = await claude.fs.stat(path).catch(ifMissing(undefined));
    return stat?.kind === "file" ? claude.fs.read(path) : undefined;
  };
  const manifest = await readJson(read, `${root}/.claude-plugin/plugin.json`);
  const version = typeof manifest?.version === "string" ? manifest.version : undefined;
  const store = storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() });
  const steps = readSteps(await readJson(read, `${root}/package.json`)) ?? {};
  if (name === cmodPluginName) {
    const installed = await newestCmodVersion(claude);
    return { name, root, version, store, steps, isInstalled: version !== undefined && installed !== undefined && isAtLeast(installed, version), shouldRecord: false };
  }
  const plugin = { name, root, version, store, steps };
  const record = await readRecord(read, store, name);
  if (Object.keys(steps).length === 0)
    return { ...plugin, isInstalled: true, shouldRecord: record?.version !== version };
  const scripts = await scriptsSha256(steps, {
    read: (path) => read(`${root}/${path}`),
    list: (folder) => filesBelow(claude, `${root}/${folder}`)
  });
  if (version === undefined || record?.scriptsSha256 !== scripts)
    return { ...plugin, isInstalled: false, shouldRecord: false };
  const isInstalled = record.version === version || record.root === root;
  const programModifiedMs = record.program === null ? undefined : (await claude.fs.stat(programPath(store, record.program, record.version)).catch(ifMissing(undefined)))?.mtimeMs;
  return { ...plugin, isInstalled, shouldRecord: isInstalled && (record.version !== version || isProgramNewer(record, programModifiedMs)) };
}
async function filesBelow(claude, folder) {
  const entries = await claude.fs.list(folder);
  const paths = await Promise.all(entries.map(async ({ name, kind, isLink }) => {
    if (kind === "file" || isLink)
      return [name];
    if (kind === "dir")
      return (await filesBelow(claude, `${folder}/${name}`)).map((path) => `${name}/${path}`);
    return [];
  }));
  return paths.flat();
}
async function readJson(read, path) {
  const text = await read(path);
  if (text === undefined)
    return;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON (${messageOf(error)}). Fix it, then press Retry.`);
  }
}
function createLifecycle(definition, permissionRoutes = () => {
  return;
}, options = {}, asksPerson = true) {
  let router = createRouter();
  let startingRouter;
  let phase = "starting";
  let runtime;
  let programs;
  let plugin;
  let activation;
  let mod;
  const openSettings = async () => {
    await claude().cmod.call({ to: cmodPluginName, method: partMethods.changed, input: { requests: [{ settings: true }], isAsked: true } });
  };
  let imports;
  let raise;
  let failure;
  let pluginOptions = options;
  let drawCount = 0;
  const nextDraw = () => drawCount += 1;
  const installer = createInstaller(definition.name, () => claude(), {
    show: (open) => {
      if (phase !== "active")
        runtime?.toaster.toast.dismiss(installId);
      runtime?.toaster.toast.info("Installing", { id: askingId, description: "Waiting for your answer", duration: Infinity, action: { label: "Answer", onClick: open } });
    },
    hide: () => runtime?.toaster.toast.dismiss(askingId)
  }, nextDraw);
  let shouldRecord = false;
  let recording;
  let missedSessionStart;
  let hasHeardSessionStart = false;
  const heldListens = new Map;
  let settleStart = () => {
    return;
  };
  const startSettled = new Promise((resolve) => settleStart = resolve);
  const claude = () => {
    if (runtime === undefined)
      throw new Error(`${definition.name}: the lifecycle has not started. registerMod(addHook, mod, options) starts it at session.start.`);
    return runtime.claude;
  };
  const installing = (description) => runtime?.toaster.toast.loading("Installing", { id: installId, ...description === undefined ? {} : { description } });
  const toastFailure = (shown) => runtime?.toaster.fail(shown);
  const fail = (reason, fix, retry, error) => {
    phase = "failed";
    failure ??= new Error(`${definition.name}: ${reason}${/[.!?]$/.test(reason) ? "" : "."}${fix === undefined ? "" : ` ${fix}`}`, { cause: error });
    const again = retry === undefined ? {} : { retry: () => (failure = undefined, stopRetrying(), retry().catch(report)) };
    toastFailure({ id: installId, message: reason, ...fix === undefined ? {} : { description: fix }, ...error === undefined ? {} : { error }, ...again, isCritical: true });
    watchRecord();
  };
  const notSetUp = () => {
    const why = failure === undefined ? "" : messageOf(failure);
    const own = `${definition.name}: `;
    return why === "" ? `${definition.name} is not set up.` : `${definition.name} is not set up: ${why.startsWith(own) ? why.slice(own.length) : why}`;
  };
  const installAgain = () => install();
  const updateAgain = () => claude().store.delete(cmodUpdatedKey).then(installAgain);
  let retrying;
  const retryLater = (next) => {
    const seconds = installRetrySeconds[Math.min(next.tries, installRetrySeconds.length - 1)];
    retrying?.timer.cancel();
    retrying = { ...next, tries: next.tries + 1, timer: claude().clock.after(seconds * 1000, () => void retryInBackground().catch(report)) };
    fail(next.reason, `Trying again in ${seconds} s.`, installAgain);
  };
  const stopRetrying = () => {
    retrying?.timer.cancel();
    retrying = undefined;
  };
  const failInstall = (reason, when) => {
    if (when === undefined) {
      stopRetrying();
      return fail(reason, undefined, installAgain);
    }
    retryLater({ when, tries: retrying?.when === when ? retrying.tries : 0, reason });
  };
  const retryInBackground = async () => {
    if (phase !== "failed" || retrying === undefined)
      return;
    if (await recover()) {
      stopRetrying();
      return whenActive();
    }
    await install(true);
    await whenActive();
  };
  const finish = async () => {
    await programs?.refresh();
    phase = "ready";
    activation ??= new Promise((resolve) => claude().clock.after(0, () => resolve(activate().catch(report))));
    claude().ui.invalidate("ui.render");
  };
  const recordThroughCmod = async () => {
    if (plugin === undefined || await newestCmodVersion(claude()) === undefined)
      return;
    let failed;
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ["cmod", "setup", plugin.root, "--events"] }), (text) => {
      const event = parseEvent(text);
      if (event.type === "done")
        shouldRecord = false;
      if (event.type === "failed")
        failed = event.message;
    });
    if (!shouldRecord) {
      runtime?.toaster.toast.dismiss(recordId);
      return programs?.refresh();
    }
    if (failed !== undefined)
      return void toastFailure({ id: recordId, message: failed, retry: record, isCritical: true });
    throw new Error(`cmod setup ${formatExit(code, lastError)}`);
  };
  const record = () => {
    recording ??= recordThroughCmod().catch((error) => claude().ui.warn("record", `${definition.name} has no cmod record yet: ${messageOf(error)}`)).finally(() => {
      recording = undefined;
    });
  };
  const saveOption = async (key, text) => {
    const option = definition.options?.[key];
    if (option === undefined || plugin === undefined)
      return `${definition.name} has no option ${key}.`;
    const value = option.type === "number" ? Number(text) : option.type === "toggle" ? text.trim() === "true" : option.type === "list" ? text.split(",").map((item) => item.trim()).filter((item) => item !== "") : text;
    const misfit = option.type === "toggle" && !["true", "false"].includes(text.trim()) ? "takes true or false" : fitsOption(option, value);
    if (misfit !== undefined)
      return `${option.title} ${misfit}.`;
    const saved = await claude().process.run(["cmod", "option", plugin.name, key, Array.isArray(value) ? value.join(",") : String(value)]);
    return saved.exitCode === 0 ? undefined : cmodError(saved.stderr, "option") || `cmod option ${formatExit(saved.exitCode, "")}.`;
  };
  const askOptions = async (missing) => {
    if (!asksPerson || plugin === undefined || (await claude().session.surfaces()).length === 0)
      return false;
    const declared = definition.options ?? {};
    const asked = missing.keys.flatMap((key) => {
      const option = declared[key];
      return option === undefined ? [] : [[key, option]];
    });
    if (!await installer.options(asked, saveOption))
      return false;
    const prefix = `${plugin.name}.`;
    const rows = await claude().config.list();
    pluginOptions = { ...pluginOptions, ...Object.fromEntries(rows.filter((row) => row.key.startsWith(prefix)).map((row) => [row.key.slice(prefix.length), row.value])) };
    return true;
  };
  const isStepDone = async (active, step) => {
    try {
      return await step.isDone(active);
    } catch (error) {
      toastFailure({ id: `step:${step.title}`, message: `The ${step.title} step's isDone failed`, error });
      return false;
    }
  };
  const pendingSteps = async (active) => {
    const pending = [];
    for (const step of definition.installer ?? [])
      if (!await isStepDone(active, step))
        pending.push(step.title);
    return pending;
  };
  const runSteps = async (active) => {
    const steps = asksPerson ? definition.installer ?? [] : [];
    try {
      for (const [index, step] of steps.entries()) {
        if (await isStepDone(active, step))
          continue;
        const isAnswered = (await claude().session.surfaces()).length > 0 && await installer.step(active, step, index + 1, steps.length);
        if (!isAnswered) {
          runtime?.toaster.toast.warning(steps.length - index === 1 ? "Needs one more step" : `Needs ${steps.length - index} more steps`, {
            id: "cmod:steps",
            description: `Starting with ${step.title}.`,
            duration: Infinity,
            action: { label: "Finish", onClick: () => runSteps(active) }
          });
          break;
        }
      }
    } finally {
      await installer.close();
    }
  };
  const activate = async () => {
    if (runtime === undefined || plugin === undefined)
      return;
    const activeRouter = createRouter();
    startingRouter = activeRouter;
    const active = await createMod(definition, { ...runtime, router: activeRouter, dataFolder: dataFolder(plugin.store, plugin.name), store: plugin.store, permissionRoutes, options: pluginOptions, nextDraw }).catch(async (error) => {
      if (error instanceof MissingOptions && await askOptions(error))
        return;
      await installer.close();
      fail(messageOf(error), error instanceof MissingOptions ? `Retry asks for ${error.keys.length === 1 ? "it" : "them"}.` : undefined, begin, error);
      throw error;
    }).finally(() => {
      startingRouter = undefined;
    });
    if (active === undefined)
      return activate();
    const { added } = active;
    mod = active.mod;
    imports = active.imports;
    raise = active.raise;
    router = activeRouter;
    phase = "active";
    stopWatchingRecord();
    const held = [...heldListens.values()];
    heldListens.clear();
    for (const call of held) {
      const failed = (error) => void toastFailure({ id: `listens:${String(call.caller)}`, message: `${String(call.caller)} hears nothing from this session`, error });
      activeRouter.dispatch("cmod.call", call, async () => ({ deny: `${definition.name} has no method ${call.method}.` })).then((answer) => ("deny" in answer) ? failed(new Error(answer.deny)) : undefined, failed);
    }
    runtime.claude.ui.invalidate("ui.render");
    if (definition.name === cmodPluginName)
      runtime.claude.ui.invalidate("command.describe");
    runSteps(active.mod).catch((error) => toastFailure({ id: "cmod:steps", message: "Its installer stopped", error, isCritical: true }));
    const missed = missedSessionStart;
    missedSessionStart = undefined;
    if (missed !== undefined)
      await replaySessionStart(missed);
    if (await runtime.claude.store.get(announcedKey) !== undefined) {
      runtime.toaster.toast.dismiss(installId);
      return;
    }
    await runtime.claude.store.set(announcedKey, { version: plugin.version ?? "" });
    const { toaster } = runtime;
    announcementOf(runtime.claude, plugin, added, openSettings).then(({ message, ...options }) => toaster.toast.success(message, { id: installId, duration: announcementMs, ...options })).catch((error) => toastFailure({ id: installId, message: "Could not say what it installed", error }));
  };
  const replaySessionStart = async (e) => {
    hasHeardSessionStart = true;
    const answer = await router.dispatch("classic.SessionStart", e, async () => ({})).catch((error) => {
      toastFailure({ id: "classic.SessionStart", message: "The SessionStart hook failed", error });
      return {};
    });
    const { additionalContext, ...unread } = answer;
    for (const text of additionalContext ?? []) {
      const added = await claude().session.append({ message: { type: "user", content: [{ type: "text", text }] } });
      if (added.deny !== undefined)
        claude().ui.warn("session-start:note", `${definition.name}: Claude Code refused its SessionStart note: ${added.deny}`);
    }
    if (Object.keys(unread).length > 0) {
      claude().ui.warn("session-start:late", `${definition.name} started after Claude Code's SessionStart, so Claude Code did not read ${Object.keys(unread).join(", ")} from its SessionStart hooks.`);
    }
  };
  const install = async (isQuiet = false) => {
    if (plugin === undefined)
      return;
    if (plugin.name === cmodPluginName)
      return bootstrap(plugin.root);
    phase = "installing";
    const found = await newestCmodVersion(claude());
    if (!fits(found))
      return waitForcmod(found);
    if (!isQuiet)
      installing();
    let outcome;
    let retries;
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ["cmod", "setup", plugin.root, "--events"] }), (text) => {
      const event = parseEvent(text);
      if (event.type === "progress" && !isQuiet)
        installing(progressOf(event));
      if (event.type === "retries")
        retries = event.when;
      if (event.type === "done" || event.type === "failed")
        outcome = event;
    });
    if (outcome?.type === "done") {
      stopRetrying();
      return finish();
    }
    return failInstall(outcome?.type === "failed" ? outcome.message : `cmod setup ${formatExit(code, lastError)}`, retries);
  };
  const fits = (found) => found !== undefined && isAtLeast(found, oldestCmodVersion);
  const waitForcmod = (found) => {
    phase = "waiting";
    installing("Waiting for cmod");
    let latest = found;
    let check;
    const stop = () => {
      timer.cancel();
      longWait.cancel();
    };
    const poll = (ms) => claude().clock.every(ms, () => {
      check ??= newestCmodVersion(claude()).then((version) => {
        check = undefined;
        latest = version;
        if (!fits(version))
          return;
        stop();
        return install();
      }).catch((error) => {
        stop();
        report(error);
      });
    });
    let timer = poll(cmodCheckMs);
    const longWait = claude().clock.after(cmodWaitMs, () => {
      timer.cancel();
      timer = poll(cmodSlowCheckMs);
      if (latest === undefined)
        return installing("Still waiting for cmod to download cmod. See cmod's own line.");
      const found = latest;
      const tried = `${found} to ${oldestCmodVersion}`;
      return claude().store.get(cmodUpdatedKey).then(async (updated) => {
        if (updated === tried) {
          stop();
          return fail(`${definition.name} needs cmod ${oldestCmodVersion} or later, and the newest cmod is ${found}.`, undefined, updateAgain);
        }
        await claude().store.set(cmodUpdatedKey, tried);
        installing(`${definition.name} needs cmod ${oldestCmodVersion} or later, and this computer has cmod ${found}, so cmod is updating itself.`);
        const { code, lastError } = await readLines(claude().process.spawn({ argv: ["cmod", "update", "cmod"] }), () => {
          return;
        });
        if (code === 0)
          return;
        stop();
        fail(`${definition.name} needs cmod ${oldestCmodVersion} or later, and updating cmod ${found} ${formatExit(code, lastError)}`, undefined, updateAgain);
      }).catch(report);
    });
  };
  const bootstrap = async (root) => {
    installing();
    phase = "installing";
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ["sh", "-c", "./setup/bootstrap.sh"], cwd: root }), (text) => {
      const event = parseEvent(text);
      if (event.type === "progress")
        installing(progressOf(event));
    });
    if (code === 0)
      return finish();
    fail(`bootstrap ${formatExit(code, lastError)}`, undefined, () => bootstrap(root));
  };
  const begin = async () => {
    if (readStarted === undefined)
      return;
    const started = await readStarted(claude());
    plugin = started;
    recordMs = await stampOf(recordPath(started.store, started.name));
    if (started.isInstalled) {
      shouldRecord = started.shouldRecord;
      if (shouldRecord)
        record();
      activation = undefined;
      return activate();
    }
    if (started.version === undefined)
      return fail("no version to install", 'Its author adds "version" to .claude-plugin/plugin.json.');
    install().catch(report);
  };
  const report = (error) => {
    failure = error;
    if (phase !== "failed")
      fail(messageOf(error), undefined, begin, error);
  };
  const stampOf = async (path) => {
    const stat = await claude().fs.stat(path).catch(ifMissing(undefined));
    return stat?.kind === "file" ? stat.mtimeMs : 0;
  };
  let recordMs = 0;
  let readStarted;
  const isNewlyInstalled = async () => {
    if (plugin === undefined || readStarted === undefined)
      return false;
    const modifiedMs = await stampOf(recordPath(plugin.store, plugin.name));
    if (modifiedMs === recordMs)
      return false;
    recordMs = modifiedMs;
    const current = await readStarted(claude());
    if (!current.isInstalled)
      return false;
    plugin = current;
    return true;
  };
  const recover = async () => {
    if (phase !== "failed" || !await isNewlyInstalled())
      return false;
    failure = undefined;
    activation = undefined;
    await finish();
    return true;
  };
  let recordCheck;
  let checking;
  let startingSession;
  const watchRecord = () => {
    recordCheck ??= claude().clock.every(recordCheckMs, () => {
      checking ??= recover().then(() => {
        return;
      }).catch((error) => claude().ui.warn("record:watch", `${definition.name} could not read whether another cmod installed it: ${messageOf(error)}`)).finally(() => {
        checking = undefined;
      });
    });
  };
  const stopWatchingRecord = () => {
    recordCheck?.cancel();
    recordCheck = undefined;
  };
  const whenActive = async () => {
    if (phase === "ready")
      activation ??= activate().catch(report);
    if (activation !== undefined && phase !== "active")
      await activation;
  };
  const held = (work, signal) => runtime === undefined ? work.then(() => false) : new Promise((resolve) => {
    const limit = claude().clock.after(startHoldMs, () => resolve(true));
    if (signal?.aborted === true)
      resolve(false);
    signal?.addEventListener("abort", () => resolve(false), { once: true });
    work.then(() => {
      limit.cancel();
      resolve(false);
    });
  });
  const holdUntilStarted = (signal) => held(startSettled.then(whenActive), signal);
  const holdUntilActive = (signal) => {
    const activating = whenActive();
    return activation !== undefined && phase !== "active" ? held(activating, signal) : activating.then(() => false);
  };
  const routed = async (event, e, next, signal) => {
    if (imports !== undefined)
      bind(imports);
    const asked = e;
    if (event === "cmod.call" && asked.to === definition.name && asked.caller === cmodPluginName) {
      if (asked.method === partMethods.shown)
        installer.hear(asked.input);
      const answered = installer.answer(asked.method, asked.input);
      if (answered !== undefined)
        return await answered.catch((error) => ({ deny: `${definition.name}: ${messageOf(error)}` }));
      if (asked.method === partMethods.shown && phase !== "active")
        return { value: null };
    }
    if (event === "classic.SessionStart") {
      missedSessionStart = undefined;
      hasHeardSessionStart = true;
    }
    if (event === "classic.SessionStart" && runtime === undefined) {
      missedSessionStart = e;
      return next(e);
    }
    if (shouldRecord && event === "classic.UserPromptSubmit")
      record();
    if (event === "classic.UserPromptSubmit" || event === "classic.SessionStart")
      await recover().catch((error) => claude().ui.warn("recover", `${definition.name} stays stopped: ${messageOf(error)}`));
    const tool = e.tool;
    const isCallToThisMod = event === "cmod.call" && e.to === definition.name || event === "tool.call" && typeof tool === "string" && tool.startsWith(`mcp__${definition.name}__`);
    if (event === "cmod.call" && !isCallToThisMod)
      return next(e);
    const isLate = await (event === "classic.SessionStart" || event === "session.append" || isCallToThisMod ? holdUntilStarted(signal) : holdUntilActive(signal));
    if (event === "classic.SessionStart" && phase !== "active") {
      missedSessionStart = e;
      return next(e);
    }
    if (isCallToThisMod && phase !== "active") {
      if (event === "cmod.call" && listenMethods.includes(asked.method)) {
        heldListens.set(`${asked.caller}
${asked.method}
${String(asked.input.session)}`, asked);
        return { value: null };
      }
      return { deny: phase === "failed" ? notSetUp() : `${definition.name} is installing. Try again when it's ready.` };
    }
    if (isLate && phase !== "active")
      return (startingRouter ?? router).dispatchFailure(event, e, new Error(`it was still starting after ${startHoldMs / 1000} s`), next, false);
    const call = e;
    if (event === "cmod.call" && call.to === definition.name && mod !== undefined) {
      if (call.method === pendingStepsMethod)
        return { value: await pendingSteps(mod) };
      if (call.method === finishStepsMethod) {
        const active = mod;
        const opened = await installer.collect(() => Promise.race([runSteps(active).catch((error) => void toastFailure({ id: "cmod:steps", message: "Could not finish the setup", error, isCritical: true })), installer.shown()]));
        return { value: opened };
      }
    }
    if (event === "classic.UserPromptSubmit" && phase === "active" && !hasHeardSessionStart) {
      const { session_id, transcript_path, cwd } = e;
      await replaySessionStart({ session_id, transcript_path, cwd, hook_event_name: "SessionStart", source: "resume" });
    }
    const answer = router.dispatch(event, e, next, signal);
    const render = e;
    if (event !== "ui.render" || render.component !== "AbovePrompt" || runtime === undefined)
      return answer;
    return runtime.toaster.draw(await answer, runtime.claude.ui.resolve(render), render.props, render.requestId);
  };
  return {
    get phase() {
      return phase;
    },
    get mod() {
      return mod;
    },
    get failure() {
      return failure;
    },
    get toasts() {
      return runtime?.toaster.shown ?? [];
    },
    async raise(method, payload) {
      if (raise === undefined || imports === undefined)
        throw new Error(`${definition.name} has not started, so ${method} has no listener yet.`);
      bind(imports);
      return raise(method, payload, unaborted);
    },
    async start(claudeCalls, read) {
      if (runtime !== undefined)
        return;
      const naming = {
        ...claudeCalls,
        ui: { ...claudeCalls.ui, warn: (id, text) => runtime === undefined ? claudeCalls.ui.warn(id, text) : runtime.toaster.warn(id, text) },
        session: { ...claudeCalls.session, id: async () => startingSession ?? claudeCalls.session.id() }
      };
      programs = locatingPrograms(naming);
      const callingCmod = {
        ...naming,
        cmod: {
          async call(input) {
            if (input.to === definition.name)
              await holdUntilStarted();
            return answeringOwnCalls(claudeCalls, router).cmod.call(input);
          }
        }
      };
      runtime = { claude: programs.claude, toaster: createToaster(callingCmod, definition.name, () => plugin?.version) };
      readStarted = read;
      try {
        drawCount = await claudeCalls.clock.now() * drawsPerMs;
        await programs.refresh();
        await begin().catch(report);
      } finally {
        settleStart();
      }
    },
    async route(event, e, next, signal) {
      if (event !== "classic.SessionStart")
        return settledAfterAbort(routed(event, e, next, signal), signal);
      const started = e.session_id;
      startingSession = started;
      try {
        return await settledAfterAbort(routed(event, e, next, signal), signal);
      } finally {
        if (startingSession === started)
          startingSession = undefined;
      }
    },
    async caught(event, e, next, { error: { kind, message }, called }) {
      const call = e;
      const isAsk = event === "cmod.call" && call.to === definition.name && beforeAskOf(call) !== undefined;
      const reasons = { timeout: `it ran past the ${hookMs / 1000} s Claude Code gives a hook`, throw: message ?? "it threw" };
      const reason = reasons[kind];
      if (reason === undefined)
        return isAsk ? { value: null } : next(e);
      const error = new Error(reason);
      const failedBeneath = called && kind === "throw" ? await next(e).then(() => {
        return;
      }, messageOf) : undefined;
      if (failedBeneath === undefined || failedBeneath !== message)
        toastFailure({ id: `stopped:${event}`, message: `Claude Code stopped its ${event.replace(/^classic\./, "")} hook`, error });
      return (startingRouter ?? router).dispatchFailure(event, e, error, next, called);
    }
  };
}
async function createMod(definition, runtime) {
  const { router, toaster } = runtime;
  const report = (failure) => void toaster.fail(failure);
  const claude = answeringOwnCalls(withBareRefusals(runtime.claude), router);
  const added = [];
  const announce = (feature) => {
    added.push(feature);
  };
  const [session, root, startCwd, home, configHome] = await Promise.all([claude.session.id(), claude.session.root(), claude.session.cwd(), claude.env.home(), claude.env.configHome()]);
  const configRoot = configHome ?? (home === undefined ? undefined : `${home}/.claude`);
  const places = { home, configRoot, projectRoot: () => modState.root };
  const files = createModFiles({ name: definition.name, claude, places, report });
  let cwd = startCwd;
  let loadedCwd = startCwd;
  let staleCwd;
  let forkedFrom;
  let parentAsked;
  let hasEarlierPrompts = true;
  let agentType;
  let parts;
  const borrowed = (styler, cached, input, scope) => {
    const name = `The markdown style of ${styler}`;
    parts?.fill(styler, cached, input, name)?.then(() => claude.ui.invalidate("ui.render"));
    return parts?.element(styler, cached, `${styler}/markdown:${scope}:`, name, `markdown:${styler}`);
  };
  const area = createUi({ name: definition.name, claude, router, report, announce, mod: () => mod, borrowed, nextDraw: runtime.nextDraw });
  const askParent = async () => {
    if (definition.name === cmodPluginName)
      return;
    try {
      const parent = await claude.cmod.call({ to: cmodPluginName, method: "forkParent", input: null });
      return typeof parent === "string" ? parent : undefined;
    } catch (error) {
      claude.ui.warn("fork:values", `${definition.name} starts without the session values of the conversation it was forked from: ${messageOf(error)}`);
      return;
    }
  };
  const forkParent = () => parentAsked ??= askParent().then((parent) => {
    forkedFrom = parent;
    return parent;
  });
  const modState = createState({ name: definition.name, initial: definition.state ?? {}, session, root, claude, report, changed: area.changed, forkParent });
  const modOptions = createOptions({ name: definition.name, declared: definition.options ?? {}, fromClaude: runtime.options, claude, report, changed: modState.changed });
  const hookOn = (hook, listener, failed) => router.add(`classic.${hook}`, classicHook(hook, listener, report), failed === undefined ? undefined : classicFailure(failed));
  const expand = (path) => homePrefix.test(path) ? resolvedPath(path, places) : path;
  const settingsFile = (source) => ({
    read: () => claude.settings.read({ source }),
    async update(values) {
      await claude.cmod.call({ to: cmodPluginName, method: "updateSettings", input: { mod: definition.name, source, project: modState.root, values } });
    }
  });
  const client = createSessionsClient({
    name: definition.name,
    claude,
    report: (id, message, error) => report({ id, message, error }),
    hookOn: (hook, listener, failed) => hookOn(hook, listener, failed),
    routeOn: (event, hook, failed) => router.add(event, hook, failed),
    permissionRoutes: runtime.permissionRoutes
  });
  let followed;
  const watches = createWatches(claude, report);
  const followFolders = (project, folder) => {
    if (followed === undefined)
      return;
    followed = { ...followed, project, cwd: folder };
    client.follow(followed);
  };
  let device;
  const imports = {
    sessions: client.sessions,
    commands: {
      list: async () => (await claude.command.list()).map(({ name, description, source, plugin }) => ({ name, description, source, ...plugin === undefined ? {} : { plugin } })),
      run: async (command, args) => {
        const { text, context } = await claude.command.run({ command, ...args === undefined ? {} : { args } });
        return { ...text === undefined ? {} : { text }, ...context === undefined || context.length === 0 ? {} : { note: context.join(`
`) } };
      },
      beforeRun: (...args) => client.listen("beforeRun", args),
      onRun: (...args) => client.listen("onRun", args)
    },
    config: {
      list: async () => (await claude.config.list()).map(({ key, label, description, kind, value, options, provider, isLocked }) => ({
        key,
        label,
        kind,
        value,
        isLocked,
        ...description === undefined ? {} : { description },
        ...options === undefined ? {} : { options },
        ...provider.plugin === "engine" ? {} : { plugin: provider.plugin }
      }))
    },
    settings: {
      user: settingsFile("user"),
      project: settingsFile("project"),
      local: settingsFile("local"),
      beforeFileChange: (matcherOrListener, maybeListener) => {
        const listener = maybeListener ?? matcherOrListener;
        const matcher = maybeListener === undefined ? undefined : matcherOrListener;
        return hookOn("ConfigChange", async ({ source, file_path }) => {
          const change = { source: source === "skills" ? "skills" : source.replace("_settings", ""), ...file_path === undefined ? {} : { path: file_path } };
          if (matcher !== undefined && !matches(change, matcher))
            return;
          const refuse = (await listener(change))?.refuse;
          return typeof refuse === "string" ? { block: refuse } : undefined;
        });
      }
    },
    model: { complete: (completion, options) => claude.model.complete(completion, options) },
    fs: {
      read: (path) => claude.fs.read(expand(path)),
      write: (path, text) => claude.fs.write(expand(path), text),
      exists: (path) => claude.fs.exists(expand(path)),
      find: (glob) => files.find(glob),
      list: async (path) => (await claude.fs.list(path === undefined ? undefined : expand(path))).map(({ name, kind, size, mtimeMs, isLink }) => ({ name, isFile: kind === "file", isFolder: kind === "dir", isLink, size, modifiedAt: mtimeMs })),
      async stat(path, options) {
        const { kind, size, mtimeMs, isLink, realPath } = await claude.fs.stat(expand(path), options);
        return { isFile: kind === "file", isFolder: kind === "dir", isLink, size, modifiedAt: mtimeMs, ...realPath === undefined ? {} : { realPath } };
      },
      onChange: ({ path }, listener) => watches.add([path].flat().map((each) => resolvedPath(each, places)), (change) => {
        bind(imports);
        return listener(change);
      })
    },
    metadata: {
      read: (path) => files.read(path),
      update: (path, change) => files.update(path, change)
    },
    process: {
      run: (argv, init) => claude.process.run(argv, init),
      spawn: (argv, init) => claude.process.spawn({ ...init, argv })
    },
    http: { fetch: (url, init) => claude.http.fetch(url, init) },
    device: {
      read: () => device ??= claude.device.read().catch((error) => {
        device = undefined;
        throw error;
      })
    },
    clipboard: {
      async write(text) {
        await toaster.copy(text);
      }
    },
    mods: {
      isLoaded: async (name) => await claude.cmod.call({ to: cmodPluginName, method: loadedMethod, input: { name } }) === true
    }
  };
  const timer = (ms, subject, repeats, listener) => {
    let isFiring = false;
    let isRunning = true;
    let firedAt = 0;
    let isStallTold = false;
    const tellStall = async () => {
      const ranMs = await claude.clock.now() - firedAt;
      if (isStallTold || ranMs < Math.max(checked * stallTicks, stallMs))
        return;
      isStallTold = true;
      claude.ui.warn(`${subject}:${ms}:stalled`, `${definition.name}: one run of its ${subject} ${ms} ms timer has gone on for ${Math.round(ranMs / 1000)} s, so the timer skipped every tick since. Give what the listener awaits a deadline.`);
    };
    const fire = () => {
      if (!repeats)
        isRunning = false;
      if (isFiring) {
        tellStall();
        return;
      }
      isFiring = true;
      isStallTold = false;
      Promise.resolve().then(async () => {
        firedAt = await claude.clock.now();
        bind(imports);
        return listener();
      }).catch((error) => report({ id: `${subject}:${ms}`, message: `The ${subject} ${ms} ms timer failed`, error })).finally(() => {
        isFiring = false;
      });
    };
    const checked = checkedMs(definition.name, `mod.${subject}`, ms);
    const started = repeats ? claude.clock.every(checked, fire) : claude.clock.after(checked, fire);
    return {
      get isRunning() {
        return isRunning;
      },
      stop() {
        isRunning = false;
        started.cancel();
      }
    };
  };
  const hotkeys = await createHotkeys({ name: definition.name, declared: definition.hotkeys ?? {}, configRoot, claude, router, answerInput: area.answerInput, report });
  const secret = async (action, key, value) => {
    const { exitCode, stdout, stderr } = await claude.process.run(["cmod", "secret", action, definition.name, key], value === undefined ? undefined : { stdin: value });
    if (exitCode !== 0)
      throw new Error(`${definition.name}: mod.secrets.${action}: ${cmodError(stderr, "secret") || `cmod secret ${formatExit(exitCode, "")}.`}`);
    return stdout;
  };
  const mod = {
    name: definition.name,
    folder: claude.plugin.root,
    dataFolder: runtime.dataFolder,
    secrets: {
      get: async (key) => await secret("get", key) || undefined,
      store: async (key, value) => void await secret("store", key, value),
      delete: async (key) => void await secret("delete", key)
    },
    state: modState.state,
    get options() {
      return modOptions.values;
    },
    hotkeys,
    every: (ms, listener) => timer(ms, "every", true, listener),
    after: (ms, listener) => timer(ms, "after", false, listener),
    use: (job) => job({ mod, announce, reserveName }),
    log: (text, options) => claude.ui.log(`${definition.name}: ${text}`, { to: options?.to ?? "debug" }),
    panes: area.panes,
    sidebar: area.sidebar,
    settings: area.settings,
    widgets: area.widgets,
    styles: area.styles,
    toast: toaster.toast,
    ask: (question, options) => claude.ui.ask(question, options),
    dependencies: dependencyCalls(claude, (call, task) => beforeDeadline(claude, { ms: dependencyCallMs }, call, task))
  };
  bind(imports);
  const followSession = async (isAfterCd = false) => {
    try {
      const [nextRoot, reportedCwd] = await Promise.all([claude.session.root(), claude.session.cwd()]);
      const oldCwd = cwd;
      const hasMovedRoot = nextRoot !== modState.root;
      if (isAfterCd && hasMovedRoot && relativePath(nextRoot, reportedCwd) === undefined)
        staleCwd = reportedCwd;
      if (reportedCwd !== staleCwd)
        staleCwd = undefined;
      const nextCwd = staleCwd === undefined ? reportedCwd : nextRoot;
      if (!hasMovedRoot && nextCwd === oldCwd)
        return;
      cwd = nextCwd;
      followFolders(nextRoot, nextCwd);
      await modState.moveTo(nextRoot).catch((error) => {
        if (cwd === nextCwd)
          cwd = loadedCwd;
        followFolders(modState.root, cwd);
        throw error;
      });
      if (hasMovedRoot)
        await modOptions.load(nextRoot);
      loadedCwd = nextCwd;
      if (!hasMovedRoot)
        area.changed();
      if (nextCwd === oldCwd)
        return;
      const moved = { session_id: await claude.session.id(), cwd: nextCwd, hook_event_name: "CwdChanged", old_cwd: oldCwd, new_cwd: nextCwd };
      await router.dispatch("classic.CwdChanged", moved, async () => ({}));
    } catch (error) {
      report({ id: "cmod:follow", message: `Keeps the state of ${modState.root} until the next prompt or folder move`, error });
    }
  };
  const followCurrent = async (id, title) => {
    const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()]);
    followed = { id, title: title ?? "", project: modState.root, cwd, model, startedAt: new Date(usage.startedAt).toISOString(), ...forkedFrom === undefined ? {} : { forkedFrom }, ...agentType === undefined ? {} : { agentType } };
    client.follow(followed);
  };
  router.add("classic.SessionStart", async (e, next) => {
    agentType = e.agent_id === undefined ? e.agent_type : agentType;
    const previous = followed?.id;
    if (e.source === "fork" && previous !== undefined && previous !== e.session_id)
      forkedFrom = previous;
    else if (e.session_id !== previous) {
      forkedFrom = undefined;
      parentAsked = undefined;
    }
    hasEarlierPrompts = e.source !== "startup" && e.source !== "clear";
    await followCurrent(e.session_id, e.session_title).catch((error) => report({ id: "cmod:current", message: "Kept the details of the session from before", error }));
    await modState.switchSession(e.session_id, e.source, e.transcript_path).catch((error) => {
      report({ id: "cmod:session", message: `Kept its session values from before the ${e.source}`, error });
    });
    return next(e);
  });
  router.add("classic.UserPromptSubmit", async (e, next) => {
    staleCwd = undefined;
    await followSession();
    const isPerson = e.source === undefined || e.source === "user" || e.source === "sdk";
    await followCurrent(e.session_id, e.session_title || (isPerson && !hasEarlierPrompts && client.sessions.current.title === "" ? firstLine(e.prompt) : undefined)).catch((error) => report({ id: "cmod:current", message: "Kept the details of the session from before", error }));
    return next(e);
  });
  for (const event of ["classic.PostToolUse", "classic.PostToolUseFailure"]) {
    router.add(event, async (e, next) => {
      if (shellTools.includes(e.tool_name))
        await followSession();
      return next(e);
    });
  }
  router.add("command.run", async (e, next) => {
    const answer = await next(e);
    if (e.command === "cd") {
      await followSession(true);
      conversations?.moved();
    }
    return answer;
  });
  router.add("skill.prompt", userSkillHook(claude));
  router.add("ui.press", (e, next) => area.asked(() => next(e)));
  let api = {};
  const conversations = definition.name === cmodPluginName ? serveConversations({ claude, router, store: runtime.store, project: () => modState.root, report: (id, message, error) => report({ id, message, error }), clear: (id) => toaster.toast.dismiss(id) }) : undefined;
  let pages;
  const reportPart = (id, message, error) => report({ id, message, error });
  const pressElsewhere = (to, input) => void claude.cmod.call({ to, method: partMethods.press, input }).catch((error) => {
    parts?.forget(to);
    claude.ui.invalidate("ui.render");
    reportPart(`press:${to}`, `${to} did not take the press`, error);
  });
  parts = drawnParts({ claude, report: reportPart, press: (to, input) => pages === undefined ? pressElsewhere(to, input) : pages.press(to, input) });
  const widgets = conversations === undefined ? undefined : serveWidgets({ claude, router, store: runtime.store, report: reportPart, turnClosedBy: (rowId) => conversations.turnClosedBy(rowId), parts, markdownIn: area.markdownIn });
  pages = widgets === undefined ? undefined : servePages({ claude, router, report: reportPart, widgets, parts, tellStylers: area.restyled });
  const tellColor = (to, told) => {
    if (told.session === "" || to === cmodPluginName)
      return;
    claude.clock.after(0, () => void claude.cmod.call({ to, method: conversationMethods.sessionColor, input: told }).catch((error) => claude.ui.warn("color:tell", `cmod: ${to} did not hear the session's color: ${messageOf(error)}`)));
  };
  conversations?.onColor((told) => {
    client.recolor(told);
    for (const { mod: to } of pages?.declared() ?? [])
      tellColor(to, told);
  });
  router.add("cmod.call", async (e, next) => {
    if (e.to !== definition.name)
      return next(e);
    const call = e;
    if (e.method === conversationMethods.changed && call.caller === cmodPluginName) {
      const { session: changedSession, change, isInProject } = e.input;
      client.changed(changedSession, change, isInProject !== false, next.signal);
      return { value: null };
    }
    if (e.method === conversationMethods.sessionColor && call.caller === cmodPluginName) {
      client.recolor(e.input);
      return { value: null };
    }
    const ask = beforeAskOf(call);
    if (ask !== undefined)
      return { value: await client.answerBefore(ask.session, ask.event, ask.change, ask.isInProject, next.signal) ?? null };
    if (e.method === partMethods.changed && call.caller !== undefined && pages !== undefined) {
      const update = e.input;
      if (update.parts !== undefined && conversations !== undefined)
        tellColor(call.caller, conversations.color());
      return { value: { isHeld: pages.update(call.caller, update), stylers: pages.stylers() } };
    }
    if (call.caller !== undefined) {
      const turn = e.method === partMethods.draw ? e.input.turn : undefined;
      const answered = area.answer(e.method, turn === undefined ? e.input : { ...e.input, turn: client.turn(turn) }, call.caller);
      if (answered !== undefined)
        return answered.catch((error) => ({ deny: `${definition.name}: ${messageOf(error)}` }));
    }
    const served = await conversations?.answer(call);
    return served ?? answerCall(definition.name, api, e);
  }, (e, error) => {
    if (e.to !== definition.name)
      return;
    const ask = beforeAskOf(e);
    return ask === undefined ? { deny: `${definition.name}: ${error.message}` } : { value: client.failedBefore(ask.session, ask.event, ask.change, ask.isInProject, error) ?? null };
  });
  const agents = toolCalls(claude, router);
  keepEngine(mod, {
    claude,
    router,
    toolCalls: agents,
    report,
    hasPermissionCheck: () => runtime.permissionRoutes() !== undefined,
    answerInput: area.answerInput,
    spawnCmod: (args, env) => spawnCmod(claude, args, session, env),
    watches,
    ...widgets === undefined ? {} : { widgets },
    ...pages === undefined ? {} : { pages }
  });
  const names = new Set;
  const reserveName = (type, name, taken) => {
    const key = `${type}:${name}`;
    if (names.has(key))
      throw new Error(taken);
    names.add(key);
    return { remove: () => void names.delete(key) };
  };
  await failsAs("its state did not load", () => modState.load());
  await failsAs("its options did not load", () => modOptions.load(root));
  const missing = modOptions.missing;
  if (missing.length > 0)
    throw new MissingOptions(missing, missing.map((key) => definition.options?.[key]?.title ?? key));
  await failsAs("the details of its session did not load", () => followCurrent(session, undefined));
  const returned = await failsAs("its setup function threw", () => definition.setup(mod));
  api = apiOf(definition.name, returned);
  await failsAs("its open panes did not load", () => area.restorePanes());
  area.started();
  return { mod, added, imports, raise: client.raise, area };
}
function apiOf(name, returned) {
  if (returned === undefined || returned === null)
    return {};
  if (typeof returned !== "object" || !Object.values(returned).every((method) => typeof method === "function"))
    throw new Error(`${name}: setup returns its API, an object of methods other mods call, or nothing. It returned ${typeof returned === "object" ? "an object with values that are not methods" : typeof returned}.`);
  return returned;
}
var longestTimerMs = 2147483647;
function checkedMs(name, subject, ms) {
  if (!Number.isInteger(ms) || ms <= 0 || ms > longestTimerMs)
    throw new Error(`${name}: ${subject} is ${ms}. Give a whole number of milliseconds above 0 and at most ${longestTimerMs}.`);
  return ms;
}
function beforeAskOf(call) {
  if (call.method !== conversationMethods.before || call.caller !== cmodPluginName)
    return;
  const { session, event, change, isInProject } = call.input;
  return { session, event, change, isInProject: isInProject !== false };
}
async function failsAs(subject, step) {
  try {
    return await step();
  } catch (error) {
    throw new Error(`${subject}: ${messageOf(error)}`, { cause: error });
  }
}
function progressOf({ done, total, label }) {
  return Box({ gap: 2, children: [Progress({ value: total > 0 ? done / total * 100 : 0 }), Text({ dimColor: true, wrap: "truncate-end", children: label })] });
}

// node_modules/@cmodjs/core/register.js
var lifecycle;
var permissionCheck;
var registered;
var lockedRetryMs = [100, 300, 600];
var heldLock = "Lock file is already being held";
var timers2 = globalThis;
async function whenUnlocked(write) {
  for (const waitMs of lockedRetryMs) {
    try {
      return await write();
    } catch (error) {
      if (!messageOf(error).includes(heldLock))
        throw error;
      await new Promise((resolve) => void timers2.setTimeout(resolve, waitMs));
    }
  }
  return write();
}
async function startMod($, eventInput, passOn) {
  const claude = {
    plugin: { name: $.plugin.name, root: $.plugin.root },
    ui: {
      log: (text, options) => $.ui.log(text, options),
      warn: (_id, text) => $.ui.log(text, { to: "debug" }),
      notice: (toolUseId, text) => $.ui.notice(toolUseId, text),
      toast: (text, options) => $.ui.toast(text, options),
      invalidate: (event) => $.ui.invalidate(event),
      ask: (question, options) => $.ui.ask(question, options),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      panes: () => $.ui.panes(),
      scroll: (args) => $.ui.scroll(args),
      copy: (args) => $.ui.copy(args),
      focus: (args) => $.ui.focus(args),
      resolve: (render) => $.ui.resolve(render)
    },
    process: {
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request)
    },
    fs: {
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: (path) => $.fs.list(path),
      exists: (path) => $.fs.exists(path),
      stat: (path, options) => $.fs.stat(path, options)
    },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    settings: { read: (args) => $.settings.read(args) },
    config: { list: () => $.config.list() },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => whenUnlocked(() => $.store.set(key, value)),
      delete: (key) => whenUnlocked(() => $.store.delete(key)),
      keys: () => $.store.keys()
    },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn)
    },
    session: {
      id: () => $.session.id(),
      root: () => $.session.root(),
      cwd: () => $.session.cwd(),
      model: () => $.session.model(),
      usage: () => $.session.usage(),
      surfaces: () => $.session.surfaces(),
      version: async () => (await $.session.version()).version,
      messages: (args) => args === undefined ? $.session.messages() : $.session.messages(args),
      append: (args) => $.session.append(args),
      send: (args) => $.session.send(args)
    },
    prompt: { submit: (args) => $.prompt.submit(args) },
    turn: { abort: (args) => $.turn.abort(args) },
    model: { complete: (request, options) => $.model.complete(request, options) },
    command: { register: (command) => $.command.register(command), list: () => $.command.list(), run: (args) => $.command.run(args) },
    tool: { register: (tool) => $.tool.register(tool), call: (input) => $.tool.call(input) },
    agent: {
      list: () => $.agent.list(),
      spawn: (args) => $.agent.spawn(args)
    },
    env: {
      home: () => $.env.get("HOME"),
      dataHome: () => $.env.get("XDG_DATA_HOME"),
      configHome: () => $.env.get("CLAUDE_CONFIG_DIR")
    },
    device: { read: () => readDevice(claude) },
    cmod: { call: (input) => $.cmod.call(input) }
  };
  const [, answer] = await settledAfterAbort(Promise.all([lifecycle.start(claude, readPlugin), passOn(eventInput)]), passOn.signal);
  return answer;
}
function routeToMod(_$, eventInput, passOn) {
  return lifecycle.route(passOn.event, eventInput, (passed) => passOn(passed), passOn.signal);
}
function routeFailure(_$, eventInput, passOn) {
  return lifecycle.caught(passOn.event, eventInput, (passed) => passOn(passed), passOn);
}
var withCaller = (eventInput, passOn) => ({ ...eventInput, caller: passOn.origin.plugin });
var withoutCaller = (passOn) => (passed) => passOn(Object.fromEntries(Object.entries(passed).filter(([key]) => key !== "caller")));
function routeCallToMod(_$, eventInput, passOn) {
  return lifecycle.route("cmod.call", withCaller(eventInput, passOn), withoutCaller(passOn), passOn.signal);
}
function routeCallFailure(_$, eventInput, passOn) {
  return lifecycle.caught("cmod.call", withCaller(eventInput, passOn), withoutCaller(passOn), passOn);
}
function registerMod(addHook, definition, options) {
  permissionCheck = undefined;
  registered = definition;
  lifecycle = createLifecycle(definition, () => permissionCheck, options);
  addHook("session.start", startMod);
  addHook("classic.Setup", routeToMod).catch(routeFailure);
  addHook("classic.SessionStart", routeToMod).catch(routeFailure);
  addHook("classic.SessionEnd", routeToMod).catch(routeFailure);
  addHook("classic.UserPromptSubmit", routeToMod).catch(routeFailure);
  addHook("classic.UserPromptExpansion", routeToMod).catch(routeFailure);
  addHook("classic.InstructionsLoaded", routeToMod).catch(routeFailure);
  addHook("classic.ConfigChange", routeToMod).catch(routeFailure);
  addHook("classic.DirectoryAdded", routeToMod).catch(routeFailure);
  addHook("classic.PreModelSwitch", routeToMod).catch(routeFailure);
  addHook("classic.PostModelSwitch", routeToMod).catch(routeFailure);
  addHook("classic.PermissionDenied", routeToMod).catch(routeFailure);
  addHook("classic.PostToolUse", routeToMod).catch(routeFailure);
  addHook("classic.PostToolUseFailure", routeToMod).catch(routeFailure);
  addHook("classic.PostToolBatch", routeToMod).catch(routeFailure);
  addHook("classic.MessageDisplay", routeToMod).catch(routeFailure);
  addHook("classic.SubagentStart", routeToMod).catch(routeFailure);
  addHook("classic.SubagentStop", routeToMod).catch(routeFailure);
  addHook("classic.TaskCreated", routeToMod).catch(routeFailure);
  addHook("classic.TaskCompleted", routeToMod).catch(routeFailure);
  addHook("classic.TeammateIdle", routeToMod).catch(routeFailure);
  addHook("classic.Elicitation", routeToMod).catch(routeFailure);
  addHook("classic.ElicitationResult", routeToMod).catch(routeFailure);
  addHook("classic.Notification", routeToMod).catch(routeFailure);
  addHook("classic.PreCompact", routeToMod).catch(routeFailure);
  addHook("classic.PostCompact", routeToMod).catch(routeFailure);
  addHook("classic.Stop", routeToMod).catch(routeFailure);
  addHook("classic.StopFailure", routeToMod).catch(routeFailure);
  addHook("classic.WorktreeCreate", routeToMod).catch(routeFailure);
  addHook("classic.WorktreeRemove", routeToMod).catch(routeFailure);
  addHook("tool.call", routeToMod).catch(routeFailure);
  addHook("prompt.submit", routeToMod).catch(routeFailure);
  addHook("prompt.context", routeToMod).catch(routeFailure);
  addHook("command.run", routeToMod).catch(routeFailure);
  addHook("session.measure", routeToMod).catch(routeFailure);
  addHook("skill.prompt", routeToMod).catch(routeFailure);
  if (definition.name === cmodPluginName)
    addHook("ui.render", { component: ["AbovePrompt", "PromptHint", "SessionMode", "Spinner", "TurnDuration", "Pane"] }, routeToMod).catch(routeFailure);
  else
    addHook("ui.render", routeToMod).catch(routeFailure);
  addHook("ui.press", routeToMod).catch(routeFailure);
  addHook("ui.scroll", routeToMod).catch(routeFailure);
  addHook("ui.close", routeToMod).catch(routeFailure);
  addHook("cmod.call", { to: definition.name }, routeCallToMod).catch(routeCallFailure);
  addHook("session.compact", routeToMod).catch(routeFailure);
  if (definition.name !== cmodPluginName)
    return;
  addHook("command.describe", { command: /--/ }, routeToMod).catch(routeFailure);
  addHook("session.append", routeToMod).catch(routeFailure);
  addHook("session.receive", routeToMod).catch(routeFailure);
  addHook("agent.spawn", routeToMod).catch(routeFailure);
  addHook("prompt.attachment", routeToMod).catch(routeFailure);
  addHook("turn.start", routeToMod).catch(routeFailure);
  addHook("turn.complete", routeToMod).catch(routeFailure);
}

// node_modules/@cmodjs/core/jobs/context.js
function withinDeadline(mod, deadline, subject, run) {
  return beforeDeadline(engineOf(mod).claude, deadline, subject, Promise.resolve().then(run));
}

// node_modules/@cmodjs/core/jobs/slash-command.js
var deadline = { ms: 30000, job: "slashCommand" };
var commandName = /^[A-Za-z0-9_-]{1,64}$/;
function slashCommand(options) {
  const { name, description, argumentHint, immediate, reply } = options;
  return (job) => {
    const { mod, announce, reserveName } = job;
    const { claude, router, report, answerInput } = engineOf(mod);
    if (!commandName.test(name))
      throw new Error(`${mod.name}: "${name}" is not a slash command name. Use 1 to 64 letters, digits, "_", or "-", without the slash.`);
    const reserved = reserveName("slashCommand", name, `${mod.name}: the slash command /${name} is already added. Give each slashCommand its own name.`);
    let registered;
    claude.command.register({ name, description, ...argumentHint === undefined ? {} : { argumentHint }, ...immediate === undefined ? {} : { immediate } }).then(({ command }) => {
      registered = command;
    }, (error) => {
      report({ id: `command:${name}`, message: `/${name} is not added`, error });
    });
    announce(`/${name}`);
    const answering = router.add("command.run", async (e, next) => {
      if (e.command !== registered)
        return next(e);
      try {
        return await answerInput(async () => answerOf(mod.name, await withinDeadline(mod, deadline, `/${name}`, () => reply({ args: e.args, positionals: splitWords(e.args) }, mod))), () => next(e));
      } catch (error) {
        return { text: `/${name} failed: ${oneLine(error)}` };
      }
    });
    return {
      name,
      remove() {
        answering.remove();
        reserved.remove();
      }
    };
  };
}
function answerOf(name, reply) {
  if (reply === undefined)
    return {};
  if (typeof reply === "string")
    return { text: reply };
  return { ...reply.text === undefined ? {} : { text: reply.text }, ...reply.note === undefined ? {} : { context: [modNote(name, reply.note)] } };
}
function splitWords(args) {
  return Dt(args, (key) => `$${key}`).flatMap((entry) => {
    if (typeof entry === "string")
      return [entry];
    if ("comment" in entry)
      return [];
    if (entry.op === "glob")
      return [entry.pattern];
    return [entry.op];
  });
}
function oneLine(error) {
  return messageOf(error).replace(/\s*\n\s*/g, " ");
}

// node_modules/@cmodjs/core/runtime/claude.js
var heldInput = "the session was stopped and nobody has sent input since";

// node_modules/@cmodjs/core/utils/changelog.js
var unreleased = "Unreleased";
var heading = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?\s*$/;
var linkReference = /^\[[^\]]+\]:\s/;
function changelogSections(markdown) {
  const sections = [];
  for (const line of markdown.split(`
`)) {
    const match = heading.exec(line);
    if (match !== null)
      sections.push({ version: match[1], date: match[2], lines: [] });
    else if (!linkReference.test(line))
      sections.at(-1)?.lines.push(line);
  }
  return sections.map(({ version, date, lines }) => ({ version, ...date === undefined ? {} : { date }, text: lines.join(`
`).trim() }));
}

// ../../../../../tmp/cmod-publish-cmod-IKLKJ1/release/src/settings.ts
var settingsMemory = { removing: null, views: [], log: [], reporting: null, preferences: parsePreferences(undefined, "preferences.json") };
var settingsSession = { selected: null, section: "options", pageParams: null, notice: null, widget: null };
var areaTitles = {
  [AbovePrompt]: "Above the prompt",
  [BelowPrompt]: "Below the prompt",
  [Working]: "While Claude works",
  [TurnEnd]: "When a turn ends",
  [Dashboard]: "On the Dashboard, in the Sidebar"
};
var moves = [
  { move: "left", hotkey: "h", label: "← left" },
  { move: "down", hotkey: "j", label: "↓ down" },
  { move: "up", hotkey: "k", label: "↑ up" },
  { move: "right", hotkey: "l", label: "→ right" }
];
var preferenceTitles = {
  showsInstalledModErrors: "Show errors from installed mods"
};
var pageSection = "page:";
var selectedColor = "userMessageBackground";
var statusColumns = 2;
var rowPadding = 2;
var panelColumns = 4;
var detailMinColumns = 40;
async function storeOf(mod) {
  const { claude } = engineOf(mod);
  return storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() });
}
async function setUpMods(mod) {
  const records = await fs.list(`${await storeOf(mod)}/records`).catch(ifMissing([]));
  return records.filter((entry) => entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -".json".length)).filter((name) => name !== mod.name);
}
async function configRootOf(mod) {
  const { claude } = engineOf(mod);
  const [configHome, home] = await Promise.all([claude.env.configHome(), claude.env.home()]);
  return configHome ?? (home === undefined ? undefined : `${home}/.claude`);
}
async function readJson2(path) {
  const text = await fs.read(path).catch(ifMissing(undefined));
  return text === undefined ? undefined : JSON.parse(text);
}
var isText = (value) => typeof value === "string";
var sameFailure = (left) => (right) => left.mod === right.mod && left.id === right.id;
async function readEntries(path) {
  const value = await readJson2(path).catch((error) => {
    throw new Error(`${path} is not JSON (${messageOf(error)}). Delete it, and cmod starts it again.`);
  });
  return parseLog(value, path);
}
async function readLog(mod) {
  const folder = logFolder(await storeOf(mod));
  const files = (await fs.list(folder).catch(ifMissing([]))).filter((file) => file.isFile && file.name.endsWith(".json")).toSorted((left, right) => right.modifiedAt - left.modifiedAt);
  const read = [];
  for (const file of files) {
    const oldestKept = newestLog(read)[loggedFailures - 1];
    if (oldestKept !== undefined && Date.parse(oldestKept.at) > file.modifiedAt)
      break;
    const entries = await readEntries(`${folder}/${file.name}`).catch((error) => {
      engineOf(mod).claude.ui.warn("log:read", `cmod: the Log skips a file: ${messageOf(error)}`);
      return [];
    });
    read.push(...entries);
  }
  return newestLog(read);
}
async function readPreferences(mod) {
  const path = preferencesPath(await storeOf(mod));
  return parsePreferences(await readJson2(path), path);
}
async function refreshPreferences(mod) {
  mod.state.memory.preferences = await readPreferences(mod);
}
function failureLog(mod) {
  const { claude } = engineOf(mod);
  let writing = Promise.resolve();
  const cmodVersion = fs.read(`${claude.plugin.root}/.claude-plugin/plugin.json`).then((text) => String(JSON.parse(text).version)).catch((error) => `unknown (${messageOf(error)})`);
  const versionsOf = async (failure) => {
    const program = await newestCmodVersion(claude).catch((error) => `unknown (${messageOf(error)})`);
    const claudeCode = await claude.session.version().catch((error) => `unknown (${messageOf(error)})`);
    return { ...failure.version === undefined ? {} : { mod: failure.version }, ...failure.core === undefined ? {} : { core: failure.core }, cmod: await cmodVersion, ...program === undefined ? {} : { program }, claudeCode };
  };
  const add = async (entry) => {
    const path = `${logFolder(await storeOf(mod))}/${entry.session}.json`;
    const earlier = await readEntries(path);
    const same = earlier.find(sameFailure(entry));
    const counted = { ...entry, count: (same?.count ?? 0) + 1, firstAt: same?.firstAt ?? same?.at ?? entry.at };
    const kept = [counted, ...earlier.filter((each) => !sameFailure(entry)(each))].slice(0, loggedFailures);
    await fs.write(path, `${JSON.stringify(kept, null, 2)}
`);
    mod.state.memory.log = [counted, ...mod.state.memory.log.filter((each) => !sameFailure(entry)(each))].slice(0, loggedFailures);
  };
  return async (failure) => {
    if (!isLogEntry(failure) || !isText(failure.root) || typeof failure.isCritical !== "boolean")
      throw new Error(`${failedMethod} takes the failure's mod, id, message, details, at, and root as text, and isCritical as true or false.`);
    const { mod: name, id, message, details, at, contact } = failure;
    const level = failure.level === "warning" ? "warning" : "error";
    const [session, versions] = await Promise.all([claude.session.id(), versionsOf(failure)]);
    const added = writing.then(() => add({ mod: name, id, level, message, details, at, session, versions, ...contact === undefined ? {} : { contact } }));
    writing = Promise.allSettled([added]);
    await added;
    if (level === "warning")
      return { showsToast: false };
    return { showsToast: failure.isCritical || marketplaceOf(failure.root, failure.mod) === undefined || (await readPreferences(mod)).showsInstalledModErrors };
  };
}
async function writePreference(mod, key, isOn) {
  const store = await storeOf(mod);
  const path = preferencesPath(store);
  const saved = await readJson2(path);
  parsePreferences(saved, path);
  await fs.write(path, `${JSON.stringify({ ...isObject(saved) ? saved : {}, [key]: isOn }, null, 2)}
`);
  await fs.write(storeChangedPath(store), "");
}
function timeOf(at) {
  const date = new Date(at);
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
function widgetsLayout(current, widgets) {
  const widgetFor = (key, area) => widgets.widgets().find((widget) => widget.key === key) ?? { key, mod: key.slice(0, key.indexOf("/")), title: key, areas: [area] };
  const chip = (key, area) => {
    const widget = widgetFor(key, area);
    const isRunning = widgets.widgets().some((each) => each.key === key);
    const isHidden = widgets.layout().hidden.includes(widget.key);
    const isSelected = current.state.session.widget === widget.key;
    const label = `${isSelected ? "▸ " : ""}${widget.title}${widget.mod === "claude" || widget.title === widget.key ? "" : ` (${widget.mod})`}${isRunning ? "" : " (not running)"}${isHidden ? " (hidden)" : ""}`;
    return Button({ plain: true, key: `widget:${widget.key}`, label, ...isHidden || !isRunning ? { dimColor: true } : {}, onPress: () => void (current.state.session.widget = widget.key) });
  };
  const layout = widgets.layout();
  const sections = areas.map((area) => {
    const rows = layout.areas[area].map((row, index) => Box({ key: `row:${area}:${index}`, columnGap: 2, flexWrap: "wrap", children: [...row.left.map((key) => chip(key, area)), Text({ dimColor: true, children: "│" }), ...row.right.map((key) => chip(key, area))] }));
    const builtIns = area === BelowPrompt ? [Box({ columnGap: 2, flexWrap: "wrap", children: builtInWidgets.map(({ key }) => chip(key, area)) })] : [];
    return Box({ flexDirection: "column", children: [Text({ bold: true, children: areaTitles[area] }), ...builtIns, ...rows.length === 0 ? [Text({ dimColor: true, children: "No widgets" })] : rows] });
  });
  const selected = current.state.session.widget;
  const area = selected === null ? undefined : placedIn(layout, selected);
  const isBuiltIn = builtInWidgets.some((widget) => widget.key === selected);
  const actions = selected === null || area === undefined && !isBuiltIn ? [Text({ dimColor: true, children: "Pick a widget to move it, hide it, or show it." })] : [
    Box({
      columnGap: 2,
      flexWrap: "wrap",
      children: [
        ...area === undefined ? [] : moves.map(({ move, hotkey, label }) => Button({ plain: true, key: `move:${move}`, hotkey, label, onPress: () => void widgets.change((now) => moved(now, widgetFor(selected, area), move)) })),
        Button({ plain: true, key: "hide", hotkey: "x", label: layout.hidden.includes(selected) ? "Show" : "Hide", onPress: () => void widgets.change((now) => toggled(now, selected)) })
      ]
    })
  ];
  return Box({ flexDirection: "column", gap: 1, children: [...sections, ...actions] });
}
function settings2(mod) {
  return (pane, changed) => {
    const { pages, widgets, claude } = engineOf(mod);
    if (pages === undefined || widgets === undefined)
      throw new Error("cmod draws no Settings, because the cmod plugin started without its pages and widgets.");
    const read = (path) => fs.read(path).catch(ifMissing(undefined));
    const viewOf = async (name, root, version, isOn, rows, combos) => {
      const manifest = await read(`${root}/package.json`).then((text) => text === undefined ? undefined : JSON.parse(text));
      const plugin = await read(`${root}/.claude-plugin/plugin.json`).then((text) => text === undefined ? undefined : JSON.parse(text));
      const steps = isObject(manifest) ? readSteps(manifest) : undefined;
      const ask = async (method) => {
        if (name === mod.name)
          return [];
        const answer = await claude.cmod.call({ to: name, method, input: null }).catch((error) => {
          claude.ui.warn(`settings:${name}:${method}`, `cmod: ${name} did not answer ${method}: ${messageOf(error)}`);
          return;
        });
        return Array.isArray(answer) ? answer : [];
      };
      return {
        name,
        version,
        description: isObject(plugin) && typeof plugin["description"] === "string" ? plugin["description"] : undefined,
        isOn,
        hotkeys: Object.entries(steps?.hotkeys ?? {}).map(([hotkey, { title }]) => ({ name: hotkey, title, combo: combos.get(hotkeyCommand(name, hotkey)) })),
        options: rows.filter((row) => row.key.startsWith(`${name}.`)),
        pendingSteps: await ask(pendingStepsMethod),
        changelog: changelogSections(await read(`${root}/CHANGELOG.md`) ?? "")
      };
    };
    const load = async () => {
      const store = await storeOf(mod);
      const rows = await claude.config.list();
      const combos = await readCombos(claude, await configRootOf(mod));
      const enabledPlugins = (await claude.settings.read())["enabledPlugins"];
      const enabled = Object.entries(isObject(enabledPlugins) ? enabledPlugins : {}).map(([id, isEnabled]) => ({ name: id.replace(/@[^@]*$/, ""), isEnabled }));
      const turnedOff = enabled.filter(({ name, isEnabled }) => isEnabled === false && !enabled.some((each) => each.name === name && each.isEnabled === true)).map(({ name }) => name);
      const records = (await Promise.all((await setUpMods(mod)).map((name) => readRecord(read, store, name)))).filter((record) => record !== undefined);
      const own = JSON.parse(await read(`${mod.folder}/.claude-plugin/plugin.json`) ?? "{}");
      const cmod = await viewOf(mod.name, mod.folder, own.version ?? "", true, [], combos);
      const views = await Promise.all(records.map((record) => viewOf(record.name, record.root, record.version, !turnedOff.includes(record.name), rows, combos)));
      return [cmod, ...views.sort((left, right) => left.name.localeCompare(right.name))];
    };
    let hasLoaded = false;
    const refresh = async () => {
      hasLoaded = true;
      const failed = (what) => (error) => void (mod.state.session.notice = `${what} did not load: ${messageOf(error)}`);
      await load().then((views) => void (mod.state.memory.views = views), failed("The mods"));
      await readLog(mod).then((log) => void (mod.state.memory.log = log), failed("The Log"));
      await readPreferences(mod).then((preferences) => void (mod.state.memory.preferences = preferences), failed("The preferences"));
    };
    const act = (task) => void task().then((notice) => {
      mod.state.session.notice = notice ?? null;
      return refresh();
    }).catch((error) => void (mod.state.session.notice = messageOf(error)));
    const runCmod = async (argv, done, timeoutMs) => {
      const { exitCode, stdout, stderr } = await process.run(["cmod", ...argv], timeoutMs === undefined ? {} : { timeoutMs });
      return exitCode === 0 ? done || stdout.trim() : `cmod ${argv.slice(0, 2).join(" ")} ${formatExit(exitCode, cmodError(stderr, argv[0]))}`;
    };
    const remove = (name) => act(async () => {
      mod.state.memory.removing = null;
      mod.state.session.notice = `Removing ${name}…`;
      return runCmod(["remove", name], `Removed ${name}.`, longestMs);
    });
    const turn = (name, isOn) => act(() => runCmod([isOn ? "enable" : "disable", name], `Turned ${name} ${isOn ? "on" : "off"}.`));
    const setOption = (name, row, text) => act(() => runCmod(["option", name, row.key.slice(name.length + 1), text.split(",").map((item) => item.trim()).join(",")], `Saved ${row.label}. ${name} reads it at its next start.`));
    const bind = (name, hotkey, combo) => act(() => runCmod(["hotkey", name, hotkey.name, combo.trim()], `Bound ${combo.trim()} to ${hotkey.title}.`));
    const sectionsOf = (view) => {
      const own = pages.declared().find((each) => each.mod === view.name)?.pages.filter((page) => page.place === "settings") ?? [];
      return [
        ...own.map((page) => ({ key: `${pageSection}${page.id}`, label: page.title })),
        ...view.name === mod.name ? [] : [{ key: "options", label: "Options" }],
        { key: "hotkeys", label: "Hotkeys" },
        ...view.name === mod.name ? [
          { key: "widgets", label: "Widgets" },
          { key: "log", label: "Log" },
          { key: "preferences", label: "Preferences" }
        ] : [],
        ...view.changelog.length === 0 ? [] : [{ key: "changelog", label: "Changelog" }]
      ];
    };
    const shownOf = () => {
      const { selected, section } = mod.state.session;
      const view = mod.state.memory.views.find((each) => each.name === selected) ?? mod.state.memory.views[0];
      const sections = view === undefined ? [] : sectionsOf(view);
      return { view, section: sections.some(({ key }) => key === section) ? section : sections[0]?.key ?? "hotkeys" };
    };
    const failuresLog = () => {
      const { log, reporting } = mod.state.memory;
      if (log.length === 0)
        return Text({ dimColor: true, children: "No mod has failed." });
      const copy = (entry) => act(async () => {
        await clipboard.write(logReport(entry));
        return "Copied the error.";
      });
      const askClaude = (entry) => act(async () => {
        mod.state.memory.reporting = null;
        await claude.prompt.submit({ text: reportPrompt(entry.mod, entry.contact, logReport(entry)), asUser: true });
        return;
      });
      return Box({
        flexDirection: "column",
        gap: 1,
        children: log.map((entry) => {
          const key = `${entry.mod}/${entry.id}`;
          const choices = reporting === key ? [
            Button({ plain: true, key: `ask-claude:${key}`, label: "Ask Claude to report it", onPress: () => askClaude(entry) }),
            ...entry.contact === undefined ? [] : [reportLink(entry.contact, entry.mod, entry.message, logReport(entry))],
            Button({ plain: true, dimColor: true, key: `back:${key}`, label: "Back", onPress: () => void (mod.state.memory.reporting = null) })
          ] : [
            Button({ plain: true, key: `copy:${key}`, label: "Copy", onPress: () => copy(entry) }),
            Button({ plain: true, key: `report:${key}`, label: "Report", onPress: () => void (mod.state.memory.reporting = key) })
          ];
          return Box({
            key: `log:${key}`,
            flexDirection: "column",
            children: [
              Text({
                wrap: "truncate-end",
                children: [
                  Text({ bold: true, children: entry.mod }),
                  ...entry.level === "warning" ? [Text({ color: "warning", children: " warning" })] : [],
                  Text({ dimColor: true, children: ` · ${timeOf(entry.at)}${(entry.count ?? 1) > 1 ? ` · ${entry.count} times since ${timeOf(entry.firstAt ?? entry.at)}` : ""}` })
                ]
              }),
              Text({ wrap: "wrap", children: entry.message }),
              ...entry.versions === undefined ? [] : [Text({ dimColor: true, wrap: "truncate-end", children: versionsLine(entry.versions) })],
              Box({ gap: 2, flexWrap: "wrap", children: choices })
            ]
          });
        })
      });
    };
    const drawSection = (view, section, columns, isFocused) => {
      if (section.startsWith(pageSection))
        return pages.element(view.name, section.slice(pageSection.length), mod.state.session.pageParams, columns, isFocused) ?? Text({ dimColor: true, children: "Drawing…" });
      if (section === "widgets")
        return widgetsLayout(mod, widgets);
      if (section === "log")
        return failuresLog();
      if (section === "preferences") {
        return Box({
          flexDirection: "column",
          children: Object.entries(preferenceTitles).map(([key, title]) => {
            const isOn = mod.state.memory.preferences[key];
            const turn = async () => {
              await writePreference(mod, key, !isOn);
              return;
            };
            return Button({ plain: true, key: `preference:${key}`, label: `${isOn ? "[x]" : "[ ]"} ${title}`, onPress: () => act(turn) });
          })
        });
      }
      if (section === "options") {
        if (view.options.length === 0)
          return Text({ dimColor: true, children: `${view.name} has no options.` });
        return Box({
          flexDirection: "column",
          gap: 1,
          children: view.options.map((row) => Box({
            flexDirection: "column",
            children: [
              Text({ children: [Text({ bold: true, children: row.label }), row.isLocked ? Text({ dimColor: true, children: "  set by your organization" }) : ""] }),
              row.isLocked ? Text({ children: String(row.value) }) : Input({ key: `option:${row.key}`, label: "Value", value: Array.isArray(row.value) ? row.value.join(", ") : String(row.value), submitLabel: "save", onSubmit: (text) => setOption(view.name, row, text) })
            ]
          }))
        });
      }
      if (section === "hotkeys") {
        if (view.hotkeys.length === 0)
          return Text({ dimColor: true, children: `${view.name} has no hotkeys.` });
        return Box({
          flexDirection: "column",
          gap: 1,
          children: view.hotkeys.map((hotkey) => Box({
            flexDirection: "column",
            children: [
              Text({ children: [Text({ bold: true, children: hotkey.title }), ...hotkey.combo === undefined ? [Text({ dimColor: true, children: " · unbound" })] : []] }),
              Input({ key: `hotkey:${hotkey.name}`, label: "Combo", value: hotkey.combo ?? "", placeholder: "none", submitLabel: "bind", onSubmit: (combo) => bind(view.name, hotkey, combo) })
            ]
          }))
        });
      }
      return Box({
        flexDirection: "column",
        gap: 1,
        children: view.changelog.map(({ version, date, text }) => Box({
          key: `changelog:${version}`,
          flexDirection: "column",
          children: [
            Text({ children: [Text({ bold: true, children: version }), Text({ dimColor: true, children: `${date === undefined ? "" : ` · ${date}`}${version === view.version ? " · installed" : ""}` })] }),
            Markdown({ text: text === "" ? "_No changes listed._" : text })
          ]
        }))
      });
    };
    return {
      draw(columns, isFocused) {
        if (!hasLoaded)
          refresh();
        const { removing, views } = mod.state.memory;
        const { notice } = mod.state.session;
        const { view, section: shownSection } = shownOf();
        if (view === undefined)
          return Text({ dimColor: true, children: notice ?? "Reading your mods…" });
        const sections = sectionsOf(view);
        const status = (each) => !each.isOn ? Text({ dimColor: true, children: "○ " }) : each.pendingSteps.length > 0 ? Text({ color: "warning", children: "● " }) : Text({ dimColor: true, children: "● " });
        const rowLabel = (each) => `${each.name}${each.isOn ? "" : " (off)"}`;
        const listColumns = Math.max(...views.map((each) => rowLabel(each).length)) + statusColumns + rowPadding + panelColumns;
        const isWide = columns - listColumns - 1 >= detailMinColumns;
        const mods = Panel({
          title: "Mods",
          children: Box({
            flexDirection: "column",
            children: views.map((each) => each === view ? Box({ backgroundColor: selectedColor, paddingX: 1, children: Text({ wrap: "truncate-end", children: [status(each), Text({ bold: true, children: rowLabel(each) })] }) }) : Box({
              paddingX: 1,
              children: Button({
                plain: true,
                dimColor: true,
                key: `mod:${each.name}`,
                onPress: () => {
                  mod.state.session.selected = each.name;
                  mod.state.session.pageParams = null;
                  mod.state.memory.removing = null;
                  changed();
                },
                children: [status(each), rowLabel(each)]
              })
            }))
          })
        });
        const actions = view.name === mod.name || removing === view.name ? [] : [
          Box({
            gap: 2,
            flexShrink: 0,
            children: [filledButton({ key: "turn", label: view.isOn ? "Turn off" : "Turn on", onPress: () => turn(view.name, !view.isOn) }), filledButton({ key: "remove", label: "Remove", onPress: () => void (mod.state.memory.removing = view.name) })]
          })
        ];
        const header = Box({
          flexDirection: "column",
          children: [
            Box({ justifyContent: "space-between", columnGap: 2, flexWrap: "wrap", children: [Text({ dimColor: true, children: view.version }), ...actions] }),
            ...view.description === undefined ? [] : [Text({ dimColor: true, wrap: "wrap", children: view.description })]
          ]
        });
        const removal = removing === view.name ? [
          Box({
            flexDirection: "column",
            children: [
              Text({ color: "warning", wrap: "wrap", children: `Remove ${view.name}? Its uninstall step runs, and Claude Code deletes it.` }),
              Box({ gap: 2, flexShrink: 0, children: [filledButton({ key: "keep", variant: "primary", label: "Keep", onPress: () => void (mod.state.memory.removing = null) }), filledButton({ key: "remove-confirmed", label: "Remove", onPress: () => remove(view.name) })] })
            ]
          })
        ] : [];
        const finishSetup = () => act(async () => {
          const opened = await claude.cmod.call({ to: view.name, method: finishStepsMethod, input: null });
          if (isObject(opened))
            pages.update(view.name, opened);
          return;
        });
        const attention = [
          ...view.isOn ? [] : [Text({ color: "warning", wrap: "wrap", children: "Off: Claude Code does not load it." })],
          ...view.pendingSteps.length === 0 ? [] : [Box({ flexDirection: "column", children: [Text({ color: "warning", wrap: "wrap", children: `Needs setup: ${view.pendingSteps.join(", ")}` }), filledButton({ key: "finish", variant: "primary", label: "Finish setup", onPress: finishSetup })] })]
        ];
        const row = Box({
          flexWrap: "wrap",
          children: sections.map(({ key, label }) => key === shownSection ? Text({ backgroundColor: selectedColor, bold: true, wrap: "truncate-end", children: ` ${label} ` }) : Box({
            paddingX: 1,
            flexShrink: 0,
            children: Button({
              plain: true,
              dimColor: true,
              key: `section:${key}`,
              label,
              onPress: () => {
                mod.state.session.section = key;
                mod.state.session.pageParams = null;
                changed();
              }
            })
          }))
        });
        const detailColumns = (isWide ? columns - listColumns - 1 : columns) - panelColumns;
        const details = Panel({
          title: view.name,
          children: Box({
            flexDirection: "column",
            gap: 1,
            children: [header, ...removal, ...attention, row, drawSection(view, shownSection, detailColumns, isFocused), ...notice === null ? [] : [Text({ dimColor: true, wrap: "wrap", children: notice })]]
          })
        });
        return isWide ? Box({ flexGrow: 1, columnGap: 1, children: [Box({ width: listColumns, flexShrink: 0, children: mods }), details] }) : Box({ flexDirection: "column", flexGrow: 1, gap: 1, children: [Box({ flexDirection: "column", flexShrink: 0, children: mods }), details] });
      },
      shownPage() {
        const { view, section } = shownOf();
        return view !== undefined && section.startsWith(pageSection) ? { mod: view.name, page: section.slice(pageSection.length) } : undefined;
      },
      closePage(name, page) {
        const view = mod.state.memory.views.find((each) => each.name === name);
        if (mod.state.session.selected !== name || mod.state.session.section !== `${pageSection}${page}` || view === undefined)
          return false;
        mod.state.session.section = sectionsOf(view).find(({ key }) => !key.startsWith(pageSection))?.key ?? "hotkeys";
        mod.state.session.pageParams = null;
        return true;
      },
      async show(name, section, params) {
        await refresh();
        const view = mod.state.memory.views.find((each) => each.name === name);
        if (view === undefined)
          throw new Error(`${name} is not a mod cmod set up.`);
        mod.state.session.selected = name;
        mod.state.memory.removing = null;
        mod.state.session.section = section ?? sectionsOf(view)[0]?.key ?? "hotkeys";
        mod.state.session.pageParams = params ?? null;
        if (section !== "changelog")
          return;
        const shown = view.changelog.some(({ version }) => version === view.version) ? view.version : unreleased;
        await pane.scrollTo({ key: `changelog:${shown}` }, { block: "start" });
      }
    };
  };
}

// ../../../../../tmp/cmod-publish-cmod-IKLKJ1/release/src/sidebar.ts
var dashboardTab = "dashboard";
var settingsTab = "settings";
var pageHotkeys = 8;
var barColor = "userMessageBackground";
var shownColor = "claude";
var focusedKeys = [
  ["↑↓", "scroll"],
  ["tab", "move"],
  ["esc", "hide"]
];
var unfocusedKeys = [["click", "focus"]];
var panelColumns2 = 4;
var tabText = ({ label, hotkey }) => hotkey === undefined ? label : `${hotkey}: ${label}`;
var closeGlyph = " × ";
var tabColumns = (each) => [...tabText(each)].length + 2 + (each.onClose === undefined ? 0 : 1 + [...closeGlyph].length);
var sidebarSession = { pages: [], shown: dashboardTab };
var keyOf = ({ mod, page }) => `${mod}/${page}`;
function sidebar(mod, settings) {
  const { pages, widgets } = engineOf(mod);
  if (pages === undefined || widgets === undefined)
    throw new Error("cmod draws no Sidebar, because the cmod plugin started without its pages and widgets.");
  const told = new Set;
  const titleOf = (open) => open.page === installPage ? `Install ${open.mod}` : pages.declared().find((each) => each.mod === open.mod)?.pages.find((page) => page.id === open.page)?.title ?? open.page;
  const tell = () => {
    const { pages: open, shown } = mod.state.session;
    const isShown = pane.isShown;
    const inSettings = isShown && shown === settingsTab ? view.shownPage() : undefined;
    const mods = new Set([...told, ...open.map((each) => each.mod), ...inSettings === undefined ? [] : [inSettings.mod]]);
    for (const name of mods) {
      const own = open.filter((each) => each.mod === name);
      const shownPage = inSettings?.mod === name ? inSettings.page : isShown ? own.find((each) => keyOf(each) === shown)?.page ?? null : null;
      pages.tell(name, { open: own.map(({ page, params }) => ({ id: page, params })), shown: shownPage, isFocused: shownPage !== null && pane.isFocused });
      if (own.length === 0 && shownPage === null)
        told.delete(name);
      else
        told.add(name);
    }
  };
  const show = (tab) => {
    mod.state.session.shown = tab;
    tell();
  };
  const closePage = async (key) => {
    const { pages: open, shown } = mod.state.session;
    const index = open.findIndex((each) => keyOf(each) === key);
    if (index === -1)
      return;
    const left = open.filter((each) => keyOf(each) !== key);
    mod.state.session.pages = left;
    if (shown !== key)
      return tell();
    const next = left[Math.min(index, left.length - 1)];
    if (next === undefined) {
      mod.state.session.shown = dashboardTab;
      await pane.close();
      return tell();
    }
    show(keyOf(next));
  };
  const tab = ({ key, label, hotkey, isShown, onClose }) => {
    const closes = onClose === undefined ? [] : [Button({ plain: true, key: `close:${key}`, onPress: onClose, children: Text({ ...isShown ? { color: shownColor, backgroundColor: "inverseText" } : { color: barColor, backgroundColor: "inactive" }, children: closeGlyph }) })];
    return Box({
      flexShrink: 0,
      paddingX: 1,
      columnGap: 1,
      ...isShown ? { backgroundColor: shownColor } : {},
      children: [isShown ? Text({ color: "inverseText", bold: true, children: tabText({ label, hotkey }) }) : Button({ plain: true, dimColor: true, key: `tab:${key}`, ...hotkey === undefined ? {} : { hotkey }, label, onPress: () => show(key) }), ...closes]
    });
  };
  const edge = (glyph, left, right, columns) => {
    const widths = left.map(tabColumns);
    const rightColumns = tabColumns(right);
    const leftColumns = widths.reduce((sum, width) => sum + width, 0);
    if (leftColumns + rightColumns > columns)
      return Text({ color: barColor, children: glyph.repeat(columns) });
    const shown = left.findIndex((each) => each.isShown);
    const start = shown === -1 ? columns - rightColumns : widths.slice(0, shown).reduce((sum, width) => sum + width, 0);
    const width = shown === -1 ? rightColumns : widths[shown] ?? 0;
    return Text({ children: [Text({ color: barColor, children: glyph.repeat(start) }), Text({ color: shownColor, children: glyph.repeat(width) }), Text({ color: barColor, children: glyph.repeat(columns - start - width) })] });
  };
  const arrangeWidgets = async () => {
    show(settingsTab);
    await view.show(mod.name, "widgets");
    tell();
  };
  const emptyDashboard = () => Box({
    flexDirection: "column",
    gap: 1,
    children: [
      Box({ flexDirection: "column", children: [Text({ children: "Nothing is on the Dashboard yet." }), Text({ dimColor: true, wrap: "wrap", children: "Place the widgets your mods add here, in Settings." })] }),
      filledButton({ key: "arrange-widgets", variant: "primary", label: "Arrange widgets", onPress: () => void arrangeWidgets() })
    ]
  });
  const body = (columns, isFocused) => {
    const { pages: open, shown } = mod.state.session;
    if (shown === settingsTab)
      return view.draw(columns, isFocused);
    const page = open.find((each) => keyOf(each) === shown);
    if (page === undefined) {
      const rows = widgets.rows(Dashboard, columns - panelColumns2);
      return Panel({ title: "Widgets", children: rows.length === 0 ? emptyDashboard() : Box({ flexDirection: "column", children: rows }) });
    }
    return Panel({ title: page.mod, children: pages.element(page.mod, page.page, page.params, columns - panelColumns2, isFocused) ?? Text({ dimColor: true, children: `Drawing ${titleOf(page)}…` }) });
  };
  const pane = mod.panes.add({
    id: "sidebar",
    title: "Sidebar",
    closeOnEscape: true,
    render(current, { bodyColumns, isFocused, placement, scroll }) {
      const { pages: open, shown } = current.state.session;
      const isPageShown = open.some((each) => keyOf(each) === shown);
      const shownTab = shown === settingsTab || isPageShown ? shown : dashboardTab;
      const left = [
        { key: dashboardTab, label: "Dashboard", hotkey: "0", isShown: shownTab === dashboardTab, onClose: undefined },
        ...open.map((each, index) => {
          const key = keyOf(each);
          return { key, label: titleOf(each), hotkey: index < pageHotkeys ? `${index + 1}` : undefined, isShown: key === shownTab, onClose: () => void closePage(key) };
        })
      ];
      const right = { key: settingsTab, label: "Settings", hotkey: "9", isShown: shownTab === settingsTab, onClose: undefined };
      const tabBar = Box({
        flexDirection: "column",
        children: [
          edge("▄", left, right, bodyColumns),
          Box({ backgroundColor: barColor, justifyContent: "space-between", children: [Box({ flexWrap: "wrap", flexShrink: 1, minWidth: 0, children: left.map(tab) }), tab(right)] }),
          edge("▀", left, right, bodyColumns)
        ]
      });
      const keyBar = Box({
        backgroundColor: barColor,
        paddingX: 1,
        columnGap: 2,
        flexWrap: "wrap",
        children: (isFocused ? focusedKeys : unfocusedKeys).map(([keys, does]) => Text({ wrap: "truncate-end", children: [keys, Text({ dimColor: true, children: ` ${does}` })] }))
      });
      return Box({
        flexDirection: "column",
        gap: 1,
        ...placement === "dock" ? { minHeight: scroll.bodyRows } : {},
        children: [tabBar, Box({ flexDirection: "column", flexGrow: 1, paddingX: 1, children: body(bodyColumns - 2, isFocused) }), keyBar]
      });
    },
    onClose: () => tell()
  });
  const view = settings(pane, () => tell());
  const placeOf = (name, page) => pages.declared().find((each) => each.mod === name)?.pages.find((each) => each.id === page)?.place;
  const apply = async (name, requests) => {
    for (const request of requests) {
      if ("open" in request && placeOf(name, request.open) === "settings") {
        show(settingsTab);
        await pane.open({ focus: true });
        await view.show(name, `page:${request.open}`, request.params);
      } else if ("open" in request) {
        const opened = { mod: name, page: request.open, params: request.params };
        const open = mod.state.session.pages;
        mod.state.session.pages = open.some((each) => keyOf(each) === keyOf(opened)) ? open.map((each) => keyOf(each) === keyOf(opened) ? opened : each) : [...open, opened];
        show(keyOf(opened));
        await pane.open(request.focus === true ? { focus: true } : {});
      } else if ("close" in request) {
        if (!view.closePage(name, request.close))
          await closePage(keyOf({ mod: name, page: request.close }));
      } else if ("scroll" in request) {
        const to = typeof request.to === "string" ? request.to : { key: `${name}/${request.scroll}:${request.to.key}` };
        await pane.scrollTo(to, request.block === undefined ? {} : { block: request.block });
      } else if ("focus" in request) {
        await pane.focus(`${name}/${request.focus}:${request.key}`);
      } else if ("settings" in request) {
        show(settingsTab);
        await pane.open({ focus: true });
        await view.show(name, request.tab);
      } else {
        engineOf(mod).claude.ui.warn(`page-request:${name}`, `cmod: ${name} sent a page request this cmod does not know, so it skips it: ${JSON.stringify(request)}`);
      }
    }
    tell();
  };
  pages.apply(apply);
  return {
    pane,
    async toggle() {
      await pane.toggle({ focus: true });
      tell();
    },
    async toggleSettings() {
      if (pane.isShown && mod.state.session.shown === settingsTab) {
        await pane.close();
        return tell();
      }
      show(settingsTab);
      await pane.open({ focus: true });
      tell();
    },
    async openSettings(name) {
      show(settingsTab);
      await pane.open({ focus: true });
      if (name !== undefined)
        await view.show(name);
      tell();
    }
  };
}

// node_modules/@cmodjs/core/jobs/tool.js
var toolName = /^[A-Za-z0-9_-]{1,64}$/;
function tool(options) {
  const { name, description, inputSchema, isDeferred, execute } = options;
  return (job) => {
    const { mod, announce, reserveName } = job;
    const { claude, router, report } = engineOf(mod);
    if (!toolName.test(name))
      throw new Error(`${mod.name}: "${name}" is not a tool name. Use 1 to 64 letters, digits, "_", or "-".`);
    const properties = inputSchema?.properties ?? {};
    const reserved = reservedKeys.filter((key) => Object.hasOwn(properties, key));
    if (reserved.length > 0)
      throw new Error(`${mod.name}: the ${name} tool's inputSchema has the property ${reserved.join(", ")}, which Claude Code keeps for itself. Rename it.`);
    const named = reserveName("tool", name, `${mod.name}: the tool ${name} is already added. Give each tool its own name.`);
    const validator = new rt(inputSchema ?? { type: "object" }, "2020-12", false);
    let registered;
    claude.tool.register({ name, description, ...inputSchema === undefined ? {} : { inputSchema }, ...isDeferred === undefined ? {} : { isDeferred } }).then((answer) => {
      registered = answer.tool;
    }, (error) => {
      report({ id: `tool:${name}`, message: `The ${name} tool is not added`, error });
    });
    announce(`the ${name} tool`);
    const answering = router.add("tool.call", async (e, next) => {
      if (e.tool !== registered)
        return next(e);
      const input = toolInputOf(e);
      const { valid, errors } = validator.validate(input);
      if (!valid)
        return { deny: `The ${name} tool input is not valid:
${errors.map((error) => `- ${error.instanceLocation}: ${error.error}`).join(`
`)}` };
      try {
        return { result: resultOf2(await withinDeadline(mod, toolDeadline, `the ${name} tool`, () => execute(input, mod))) };
      } catch (error) {
        return { deny: `The ${name} tool failed: ${messageOf(error)}` };
      }
    });
    return {
      name: `mcp__${claude.plugin.name}__${name}`,
      remove() {
        answering.remove();
        named.remove();
      }
    };
  };
}
function resultOf2(value) {
  if (value === undefined || typeof value === "string")
    return value;
  if (Array.isArray(value) && value.every((block) => typeof block === "object" && block !== null && ("type" in block)))
    return value;
  return JSON.stringify(value);
}

// ../../../../../tmp/cmod-publish-cmod-IKLKJ1/release/src/tools.ts
var carryOn = "The conversation was compacted. Carry on with the work from before the compaction.";
function addClaudeTools(mod) {
  const { report } = engineOf(mod);
  let compaction;
  const compact = async ({ keep }) => {
    try {
      await commands.run("compact", keep);
      await sessions.current.send({ type: Prompt, text: carryOn });
    } catch (error) {
      report({ id: "compact", message: "Could not compact the conversation", error });
    }
  };
  sessions.current.onTurnEnd(() => {
    const asked = compaction;
    compaction = undefined;
    if (asked !== undefined)
      mod.after(1, () => void compact(asked));
  });
  mod.use(tool({
    name: "compact",
    description: "Compact this conversation once your answer ends: a summary replaces the conversation so far, and a prompt then lets you carry on. Use it when the context window is filling up and the work so far fits in a summary.",
    inputSchema: {
      type: "object",
      properties: { keep: { type: "string", description: "What the summary must keep, such as the plan, the decisions, and the files changed." } },
      additionalProperties: false
    },
    execute: ({ keep }) => {
      compaction = keep === undefined ? {} : { keep };
      return "The conversation compacts once this answer ends, and a prompt then lets you carry on. End your answer now.";
    }
  }));
  mod.use(tool({
    name: "start_background_agent",
    description: "Start an agent in a new background Claude Code session. It works on the task on its own, sees none of this conversation, and keeps running after this session ends.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Everything the agent needs to do the task, because it sees none of this conversation." },
        title: { type: "string", description: "A few words that name the task." },
        agentType: { type: "string", description: "The agent definition the session runs, such as Explore. Leave it out for a plain session." },
        model: { type: "string", description: "The model the session runs on, such as sonnet. Leave it out for the default model." },
        cwd: { type: "string", description: "The folder the session works in. Leave it out for this session’s folder." }
      },
      required: ["task", "title"],
      additionalProperties: false
    },
    execute: async ({ task, title, agentType, model, cwd }) => {
      const started = await sessions.current.startTask({ prompt: task, title, isBackground: true, ...agentType === undefined ? {} : { agentType }, ...model === undefined ? {} : { model }, ...cwd === undefined ? {} : { cwd } });
      return `Started a background agent in session ${started.id}. It answers there, not in this conversation.`;
    }
  }));
}

// ../../../../../tmp/cmod-publish-cmod-IKLKJ1/release/src/mod.ts
var cmodGlobal = { installedPlugins: null, areHotkeysBound: false, pluginsCheckedAt: null };
var cmodSession = { tip: null, ...sidebarSession, ...settingsSession };
var nameOf2 = (id) => id.replace(/@[^@]*$/, "");
var loaded = {};
var unloaded = new Set;
var toldParts;
var loading = Promise.resolve();
var isLoaded = async (name) => {
  await loading;
  return Object.keys(loaded).some((id) => nameOf2(id) === name) || !unloaded.has(name) && toldParts?.declared().some((told) => told.mod === name) === true;
};
var newestMessages = 8;
var reloadDelayMs = 500;
var changesQuietMs = 2000;
var watchCheckMs = 1e4;
var watchStaleMs = 15000;
var reloadEcho = "<command-name>/reload-plugins</command-name>";
var reloadNote = "<local-command-caveat>cmod reloaded the plugins.</local-command-caveat>";
var reloadToast = "reload";
var oldReloadKey = /^cmod:(hiding-reload|versions-before-reload):/;
var shownChanges = 3;
async function tipOf(mod) {
  const messages = await engineOf(mod).claude.session.messages();
  if (messages.length === 0)
    return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([messages.length, messages.slice(-newestMessages)])));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
var cmodPlugin = defineMod({
  name: "cmod",
  state: { global: cmodGlobal, session: cmodSession, memory: settingsMemory },
  hotkeys: {
    sidebar: { title: "Show or hide the Sidebar", default: "meta+0" },
    settings: { title: "Show or hide Settings", default: "meta+m" }
  },
  async setup(mod) {
    const triedRemovals = new Set;
    const { claude, router, report, widgets, pages } = engineOf(mod);
    if (widgets === undefined)
      throw new Error("cmod draws no widgets, because the cmod plugin started without them.");
    toldParts = pages;
    let finishRead = () => {};
    loading = new Promise((resolve) => finishRead = resolve);
    loaded = {};
    unloaded.clear();
    addClaudeTools(mod);
    const shown = sidebar(mod, settings2(mod));
    mod.hotkeys.sidebar.onPress(() => shown.toggle());
    mod.hotkeys.settings.onPress(() => shown.toggleSettings());
    mod.use(slashCommand({
      name: "mods",
      description: "Open Settings, where you turn your mods off or remove them, and change their options, hotkeys, pages, and widgets",
      argumentHint: "[mod]",
      immediate: true,
      reply: ({ positionals }) => shown.openSettings(positionals[0])
    }));
    const bindHotkeys = async () => {
      let isBound = true;
      for (const [name, hotkey] of Object.entries(cmodPlugin.hotkeys ?? {})) {
        if (mod.hotkeys[name].combo !== undefined)
          continue;
        const { exitCode, stderr } = await process.run(["cmod", "hotkey", claude.plugin.root, name, hotkey.default]);
        if (exitCode === 0)
          continue;
        isBound = false;
        report({ id: `hotkey:${name}`, message: `Could not bind ${hotkey.default} to ${hotkey.title}`, description: `cmod hotkey ${formatExit(exitCode, cmodError(stderr, "hotkey"))}` });
      }
      mod.state.global.areHotkeysBound = isBound;
    };
    if (!mod.state.global.areHotkeysBound)
      bindHotkeys().catch((error) => report({ id: "hotkeys", message: "Could not bind the hotkeys", error }));
    const store = await storeOf(mod);
    const changed = pluginsChangedPath(store);
    const configRoot = await configRootOf(mod);
    const pluginsFile = configRoot === undefined ? undefined : `${configRoot}/plugins/installed_plugins.json`;
    const pluginsState = async () => {
      const mark = await fs.read(changed).catch(ifMissing(""));
      return { mark, text: JSON.stringify([mark, pluginsFile === undefined ? "" : await fs.read(pluginsFile).catch(ifMissing("")), (await settings.user.read())["enabledPlugins"] ?? null]) };
    };
    const hidingReloadKey = async () => sessionKeyOf(mod.name, "hidingReload", await claude.session.id());
    const forgetOldReloadKeys = async () => {
      for (const key of await claude.store.keys())
        if (oldReloadKey.test(key))
          await claude.store.delete(key);
    };
    forgetOldReloadKeys().catch((error) => claude.ui.warn("reload:old-keys", `cmod: kept the reload keys of ended sessions: ${messageOf(error)}`));
    const loadedVersions = async () => {
      if (pluginsFile === undefined)
        return {};
      const installed = JSON.parse(await fs.read(pluginsFile).catch(ifMissing("{}")));
      const enabled = (await claude.settings.read())["enabledPlugins"];
      const root = await claude.session.root();
      const versions = await Promise.all(Object.entries(installed.plugins ?? {}).map(async ([id, copies]) => {
        const loaded = copies.find((copy) => copy.projectPath === root) ?? copies.find((copy) => copy.projectPath === undefined);
        if (enabled?.[id] !== true || loaded === undefined)
          return [];
        const manifest = JSON.parse(await fs.read(`${loaded.installPath}/.claude-plugin/plugin.json`).catch(ifMissing("{}")));
        return [[id, typeof manifest.version === "string" ? manifest.version : loaded.version]];
      }));
      return Object.fromEntries(versions.flat());
    };
    const readLoaded = async () => {
      const previous = loaded;
      loaded = await loadedVersions();
      for (const id of Object.keys(previous))
        if (!Object.hasOwn(loaded, id))
          unloaded.add(nameOf2(id));
      for (const id of Object.keys(loaded))
        unloaded.delete(nameOf2(id));
    };
    const keepLoaded = () => readLoaded().catch((error) => report({ id: "loaded", message: "Could not read which plugins this session loaded", error }));
    keepLoaded().finally(finishRead);
    const started = await pluginsState();
    let loadedState = started.text;
    let seenMark = started.mark;
    let isReloadDue = false;
    let quietWait;
    const reloadAfter = (ms) => {
      quietWait?.stop();
      quietWait = mod.after(ms, reloadWhenIdle);
    };
    let reloading = Promise.resolve();
    let isWorking = false;
    const reloadWhenIdle = () => {
      reloading = reloading.then(async () => {
        if (!isReloadDue || isWorking)
          return;
        isReloadDue = false;
        await reload();
      }).catch((error) => report({ id: reloadToast, message: "Could not reload the plugins", error, retry: reload, isCritical: true }));
    };
    let offered;
    const offer = (description, hasButton) => {
      if (offered === description)
        return;
      offered = description;
      mod.toast.info("Plugins changed", { id: reloadToast, description, ...hasButton ? { action: { label: "Reload", onClick: pressReload } } : {}, duration: Infinity });
    };
    const withdrawOffer = () => {
      offered = undefined;
      mod.toast.dismiss(reloadToast);
    };
    const changesOf = async () => {
      const now = await loadedVersions();
      return [
        ...Object.entries(now).filter(([id, version]) => loaded[id] !== undefined && loaded[id] !== version).map(([id, version]) => `${nameOf2(id)} updated to ${version}`),
        ...Object.keys(now).filter((id) => loaded[id] === undefined).map((id) => `${nameOf2(id)} turned on`),
        ...Object.keys(loaded).filter((id) => now[id] === undefined).map((id) => `${nameOf2(id)} turned off`)
      ];
    };
    const offerReload = async () => {
      const changes = await changesOf();
      if (changes.length === 0)
        return offer("Reload to use the changes in this session.", true);
      offer(`${changes.length > shownChanges ? `${changes.length} plugins changed` : changes.join(", ")}. Reload to use them in this session.`, true);
    };
    const pressReload = () => {
      isReloadDue = true;
      if (isWorking)
        offer("Reloads when this turn ends.", false);
      reloadAfter(1);
    };
    const isInside = async (checkout) => {
      if (checkout === undefined)
        return false;
      const root = await claude.session.root();
      const project = (await claude.fs.stat(root, { resolve: true }).catch(ifMissing(undefined)))?.realPath ?? root;
      return project === checkout || project.startsWith(`${checkout}/`);
    };
    const checkChanges = async () => {
      const { mark, text } = await pluginsState();
      const isNewMark = mark !== seenMark;
      seenMark = mark;
      if ((await claude.session.surfaces()).length === 0)
        return;
      if (text === loadedState)
        return withdrawOffer();
      if (isNewMark && await isInside(markedCheckout(mark))) {
        isReloadDue = true;
        return reloadAfter(changesQuietMs);
      }
      if (!isReloadDue)
        await offerReload();
    };
    const reloaded = (state) => {
      loadedState = state.text;
      seenMark = state.mark;
      loading = keepLoaded();
    };
    const reload = async () => {
      withdrawOffer();
      try {
        const state = await pluginsState();
        await claude.store.set(await hidingReloadKey(), true);
        await claude.command.run({ command: "reload-plugins" });
        reloaded(state);
        await widgets.recheck();
      } catch (error) {
        await claude.store.delete(await hidingReloadKey());
        if (messageOf(error).includes(heldInput))
          isReloadDue = true;
        else
          report({ id: reloadToast, message: "Could not reload the plugins", error, retry: reload, isCritical: true });
        return;
      }
      await checkChanges();
    };
    const stopWorking = () => {
      isWorking = false;
      if (isReloadDue && quietWait?.isRunning !== true)
        reloadAfter(reloadDelayMs);
    };
    sessions.current.onTurnEnd(stopWorking);
    router.add("turn.start", async (e, next) => {
      if (e.agentId === undefined)
        isWorking = true;
      return next(e);
    });
    router.add("turn.complete", async (e, next) => {
      const completed = await next(e);
      if (e.agentId === undefined)
        stopWorking();
      return completed;
    });
    router.add("session.append", async (e, next) => {
      if (e.door !== "command" || e.message.isMeta === true)
        return next(e);
      const isReloadEcho = JSON.stringify(e.message.content).includes(reloadEcho);
      const isOwnReload = isReloadEcho && e.origin.kind === "plugin" && "name" in e.origin && e.origin.name === mod.name;
      if (isReloadEcho && !isOwnReload) {
        pluginsState().then((state) => {
          reloaded(state);
          withdrawOffer();
        }).catch((error) => report({ id: reloadToast, message: "Could not read which plugins this session loaded", error }));
      }
      const hidingReload = await hidingReloadKey();
      if (await claude.store.get(hidingReload) !== true)
        return next(e);
      if (!isOwnReload) {
        await claude.store.delete(hidingReload).catch((error) => claude.ui.warn("reload:hide", `cmod: kept hiding /reload-plugins rows, because Claude Code's store refused the change: ${messageOf(error)}`));
        if (e.message.type !== "system")
          return next(e);
      }
      return next({ ...e, message: { ...e.message, content: [{ type: "text", text: reloadNote }] } });
    });
    const isCmod = (id) => nameOf2(id) === mod.name;
    const updatedFor = "cmod:cmod-updated-for";
    let isCheckingPlugins = false;
    const modifiedAt = async (path) => (await claude.fs.stat(path).catch(ifMissing(undefined)))?.mtimeMs ?? null;
    const pluginsChangedAt = async (file) => [await modifiedAt(file), await modifiedAt(changed)];
    const keepPluginsCurrent = async ({ isForced }) => {
      if (pluginsFile === undefined || isCheckingPlugins)
        return;
      isCheckingPlugins = true;
      let checked;
      try {
        checked = await pluginsChangedAt(pluginsFile);
        if (checked[0] === null || !isForced && JSON.stringify(checked) === JSON.stringify(mod.state.global.pluginsCheckedAt))
          return;
        const session = await claude.session.id();
        const listed = async () => JSON.parse(await runCmod(claude, ["list", "--json"], session));
        const needing = (rows) => rows.filter((row) => row.unsatisfied.some(isCmod));
        const before = await listed();
        const versionsOf = (name) => [...new Set(before.filter((row) => nameOf2(row.name) === name).map((row) => row.version))].toSorted();
        const hasDifferingCopies = (name) => versionsOf(name).length > 1;
        let off = needing(before);
        const others = [...new Set(before.map((row) => nameOf2(row.name)))].filter((name) => name !== mod.name && hasDifferingCopies(name)).toSorted();
        const outdated = [...off.length > 0 || hasDifferingCopies(mod.name) ? [mod.name] : [], ...others];
        const reason = outdated.length > 0 ? JSON.stringify([off.map((row) => row.name).toSorted(), outdated.map((name) => [name, versionsOf(name)])]) : "";
        if (reason !== "" && reason !== await claude.store.get(updatedFor)) {
          await claude.store.set(updatedFor, reason);
          for (const name of outdated)
            await runCmod(claude, ["update", name], session);
          checked = await pluginsChangedAt(pluginsFile);
          off = needing(await listed());
        }
        if (reason === "")
          await claude.store.delete(updatedFor);
        if (off.length > 0)
          report({ id: "needs-cmod", message: `${off.map((row) => row.name).join(", ")} ${off.length === 1 ? "is" : "are"} off`, description: off.map((row) => row.state).join(`
`), retry: updateAgain, isCritical: true });
        else
          mod.toast.dismiss("needs-cmod");
        mod.state.global.pluginsCheckedAt = checked;
      } finally {
        isCheckingPlugins = false;
      }
      if (JSON.stringify(await pluginsChangedAt(pluginsFile)) !== JSON.stringify(checked))
        await keepPluginsCurrent({ isForced: false });
    };
    const checkPlugins = (asked) => void keepPluginsCurrent(asked).catch((error) => report({ id: "needs-cmod", message: "Could not update cmod for the mods that need a newer one", error, retry: updateAgain, isCritical: true }));
    const updateAgain = async () => {
      await claude.store.delete(updatedFor);
      checkPlugins({ isForced: true });
    };
    checkPlugins({ isForced: (await claude.session.surfaces()).length > 0 });
    const failuresFile = buildFailuresPath(store);
    let shownFailures = [];
    const showBuildFailures = async () => {
      const failures = JSON.parse(await fs.read(failuresFile).catch(ifMissing("{}")));
      for (const name of shownFailures)
        if (!Object.hasOwn(failures, name))
          mod.toast.dismiss(`build:${name}`);
      for (const [name, error] of Object.entries(failures))
        report({ id: `build:${name}`, message: `${name} does not build`, description: error, isCritical: true });
      shownFailures = Object.keys(failures);
    };
    const followBuildFailures = () => showBuildFailures().catch((error) => report({ id: "build-failures", message: "Could not read which linked mods fail to build", error, isCritical: true }));
    followBuildFailures();
    const watchLock = `${store}/watch.lock`;
    let isWatchRunning = false;
    const keepWatching = async () => {
      if (isWatchRunning || await isHeld(claude, watchLock, watchStaleMs))
        return;
      isWatchRunning = true;
      runCmod(claude, ["watch"], await claude.session.id()).catch((error) => report({ id: "watch", message: "Stopped reloading the linked mods", error, isCritical: true })).finally(() => void (isWatchRunning = false));
    };
    const linksFile = linksPath(store);
    const knownMarketplaces = configRoot === undefined ? undefined : `${configRoot}/plugins/known_marketplaces.json`;
    let isWatching = false;
    const watchIfLinked = async () => {
      if (isWatching || knownMarketplaces === undefined || (await claude.session.surfaces()).length === 0)
        return;
      if (!hasLinkedMods(await readJson2(knownMarketplaces), parseLinks(await readJson2(linksFile), linksFile)))
        return;
      isWatching = true;
      const watchAgain = () => void keepWatching().catch((error) => report({ id: "watch", message: "Could not check that a cmod watch runs", error }));
      watchAgain();
      claude.clock.every(watchCheckMs, watchAgain);
    };
    const startWatching = () => void watchIfLinked().catch((error) => report({ id: "watch", message: "Could not read which mods are linked", error }));
    startWatching();
    fs.onChange({ path: [storeChangedPath(store), ...pluginsFile === undefined ? [] : [pluginsFile]] }, ({ path }) => {
      startWatching();
      checkPlugins({ isForced: false });
      if (path === pluginsFile)
        return checkChanges();
      followBuildFailures();
      return Promise.all([widgets.reload(), checkChanges(), refreshPreferences(mod)]);
    });
    settings.beforeFileChange({ source: "user" }, () => void mod.after(reloadDelayMs, checkChanges));
    sessions.current.onPrompt(() => checkChanges());
    setUpMods(mod).then(async (mods) => mods.length > 0 ? runCmod(claude, ["history", "index"], await claude.session.id()) : undefined).catch((error) => claude.ui.warn("history:index", `cmod: the conversation index did not catch up: ${messageOf(error)}`));
    const tearDown = async (name) => {
      const { exitCode, stdout, stderr } = await process.run(["cmod", "teardown", name, "--events"], { timeoutMs: longestMs });
      const outcome = parseEvent(stdout.trim().split(`
`).at(-1) ?? "");
      const isAnswered = outcome.type === "done" || outcome.type === "missing" || outcome.type === "failed";
      if (isAnswered)
        mod.state.global.installedPlugins = (mod.state.global.installedPlugins ?? []).filter((installed) => installed !== name);
      if (outcome.type === "done")
        mod.toast.success(`${name} is uninstalled`);
      else if (outcome.type === "failed")
        report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, description: outcome.message, isCritical: true });
      else if (exitCode !== 0)
        report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, description: `cmod teardown ${formatExit(exitCode, cmodError(stderr, "teardown"))}`, isCritical: true });
    };
    const watchRemovals = async () => {
      const enabledPlugins = (await settings.user.read())["enabledPlugins"];
      const current = [...new Set(Object.keys(enabledPlugins ?? {}).map(nameOf2))];
      const previous = mod.state.global.installedPlugins;
      const removed = (previous ?? []).filter((name) => !current.includes(name));
      const installed = [...current, ...removed];
      if (previous === null || previous.length !== installed.length || !installed.every((name) => previous.includes(name)))
        mod.state.global.installedPlugins = installed;
      for (const name of removed) {
        if (triedRemovals.has(name))
          continue;
        triedRemovals.add(name);
        tearDown(name).catch((error) => report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, error, isCritical: true }));
      }
    };
    sessions.current.onSessionStart(watchRemovals);
    sessions.current.onPrompt(watchRemovals);
    let applied;
    let following = Promise.resolve();
    let synced;
    const changedAt = async (paths) => Promise.all(paths.map(async (path) => (await claude.fs.stat(path).catch(ifMissing(undefined)))?.mtimeMs ?? 0));
    const followRules = async () => {
      const project = await claude.session.root();
      if (synced?.project === project && (await changedAt(synced.watched)).join(",") === synced.stamp)
        return [];
      const startedAt = await claude.clock.now();
      const result = JSON.parse(await runCmod(claude, ["rules", "--project", project, "--json"], await claude.session.id()));
      const times = await changedAt(result.watched);
      synced = { project, watched: result.watched, stamp: times.some((at) => at >= startedAt - 1000) ? "" : times.join(",") };
      return rulesNotes(result);
    };
    const rulesNotes = (result) => {
      const now = new Map(result.linked.map(({ mod: name, rules }) => [name, new Map(rules.filter((rule) => rule.isGlobal).map((rule) => [rule.name, rule.text]))]));
      const notes = [...now].flatMap(([name, globals]) => {
        const before = applied === undefined ? result.placed.includes(name) ? undefined : globals : applied.get(name);
        const changed = [...globals].filter(([rule, text]) => before?.get(rule) !== text).map(([, text]) => text);
        const withdrawn = [...before ?? []].filter(([rule]) => !globals.has(rule)).map(([, text]) => text);
        return [
          ...changed.length === 0 ? [] : [[before === undefined ? `The ${name} mod adds these rules from now on:` : `The ${name} mod changed these rules, which apply from now on:`, ...changed].join(`

`)],
          ...withdrawn.length === 0 ? [] : [[`These rules of the ${name} mod no longer apply:`, ...withdrawn].join(`

`)]
        ];
      });
      const gone = applied === undefined ? result.removed : [...applied.keys()].filter((name) => !now.has(name));
      applied = now;
      return [...notes, ...gone.map((name) => `The ${name} mod's rules no longer apply.`)];
    };
    const keepRules = async () => {
      let notes = [];
      following = following.then(async () => void (notes = await followRules())).catch((error) => report({ id: "rules", message: "Could not link the mods' rules", error }));
      await following;
      return notes;
    };
    const rulesNote = async () => {
      const notes = await keepRules();
      return notes.length === 0 ? undefined : { note: notes.join(`

`) };
    };
    sessions.current.beforeSessionStart(async () => {
      try {
        return { note: deviceNote(await device.read(), new Date(await claude.clock.now()).toISOString()) };
      } catch (error) {
        if (!(error instanceof MissingMachineId))
          throw error;
        mod.log(`this start's note names no device, because ${error.message}`);
        return;
      }
    });
    sessions.current.beforeSessionStart(rulesNote);
    sessions.current.beforePrompt(rulesNote, { timeoutMs: 60000 });
    sessions.current.onTurnEnd(async () => {
      mod.state.session.tip = await tipOf(mod);
    });
    return {
      async forkParent() {
        const tip = await tipOf(mod);
        if (tip === null)
          return null;
        const current = await claude.session.id();
        return (await sessionsWith(claude, mod.name, "tip", tip)).find((session) => session !== current) ?? null;
      },
      async updateSettings(input) {
        await runCmod(claude, ["settings", input.mod, input.source, JSON.stringify(input.values), "--project", input.project], await claude.session.id());
        return null;
      },
      [failedMethod]: failureLog(mod),
      async[loadedMethod](input) {
        if (typeof input.name !== "string")
          throw new Error(`${loadedMethod} takes the name of a mod, as { name: 'anyhost' }.`);
        return isLoaded(input.name);
      }
    };
  }
});

// ../../../../../tmp/cmod-publish-cmod-IKLKJ1/release/hooks/register.ts
function register(addHook, options) {
  addHook("engine.create", async (_$, eventInput, passOn) => {
    const built = await passOn(eventInput);
    const cmod = {
      async call(input) {
        throw new Error(await isLoaded(input.to) ? `${input.to} did not answer in time, so Claude Code went on without it.` : notInstalled(input.to));
      }
    };
    return { ...built, cmod };
  });
  registerMod(addHook, cmodPlugin, options);
}
export {
  register
};
