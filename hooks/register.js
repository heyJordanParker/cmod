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
  return {
    name: value["name"],
    version: value["version"],
    root: value["root"],
    installedAt: value["installedAt"],
    scriptsSha256: value["scriptsSha256"],
    uninstall,
    program,
    keys
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
  const permissions = readPermissions(steps);
  return {
    ...readCommand(steps, "install"),
    ...readCommand(steps, "uninstall"),
    ...program === undefined ? {} : { program },
    ...readKeys(steps["keys"]),
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
function permissionWords(item) {
  const split = item.indexOf(":");
  const target = item.slice(split + 1);
  switch (split === -1 ? item : item.slice(0, split)) {
    case "network":
      return `Connect to ${target}`;
    case "run":
      return target === "*" ? "Run any program on your computer" : `Run ${target} on your computer`;
    case "files":
      return `Change ${target}`;
    case "conversation":
      return "Read your Claude Code conversations";
    case "prompt":
      return "Add text Claude reads and start turns";
    case "model":
      return "Ask a model, which uses your plan";
    case "tasks":
      return "Start tasks that work beside Claude";
    case "tools":
      return "Use and change Claude's tool calls";
    case "config":
      return `Change ${target} in your Claude Code settings`;
    case "approve":
      return "Approve Claude's tool calls for you";
    default:
      return item;
  }
}
function settingPaths(values) {
  return Object.entries(values).flatMap(([key, value]) => isObject(value) && Object.keys(value).length > 0 ? settingPaths(value).map((path) => [key, ...path]) : [[key]]);
}
function isSettingCovered(granted, path) {
  const item = `config:${path}`;
  return [...granted].some((each) => item === each || item.startsWith(`${each}.`));
}
var settingsPagesMethod = "cmod:settingsPages";
var changelogPage = "changelog";
var openPageMethod = "cmod:openPage";
var pendingStepsMethod = "cmod:pendingSteps";
var finishStepsMethod = "cmod:finishSteps";
function marketplaceOf(root, name) {
  const installed = /\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(root);
  return installed?.[2] === name ? installed[1] : undefined;
}
function updatesToTurnOn(marketplace, settings, known) {
  if (marketplace === undefined)
    return;
  const declared = isObject(settings) && isObject(settings["extraKnownMarketplaces"]) ? settings["extraKnownMarketplaces"][marketplace] : undefined;
  const fetched = isObject(known) ? known[marketplace] : undefined;
  const isDecided = [declared, fetched].some((entry) => isObject(entry) && typeof entry["autoUpdate"] === "boolean");
  const hasSource = [declared, fetched].some((entry) => isObject(entry) && isObject(entry["source"]));
  return isDecided || !hasSource ? undefined : marketplace;
}
function consentPath(store) {
  return `${store}/consent.json`;
}
function parseConsent(value, path) {
  if (value === undefined)
    return Object.create(null);
  if (!isObject(value) || Object.values(value).some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"))) {
    throw new Error(`${path} is not a map of plugin names to what each was approved for. Delete it, and cmod asks again.`);
  }
  return Object.assign(Object.create(null), value);
}
function readKeys(keys) {
  if (keys === undefined)
    return {};
  if (!isObject(keys) || Object.keys(keys).length === 0)
    throw new Error('package.json "cmod.keys" must bind each key to a command, such as "keys": { "shift+tab": "/mode" }.');
  const commands = {};
  for (const [key, value] of Object.entries(keys)) {
    const command = typeof value === "string" ? /^\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(value)?.[1] : undefined;
    if (key.trim() === "" || command === undefined)
      throw new Error(`package.json "cmod.keys" binds "${key}" to ${JSON.stringify(value)}. Bind each key to one of the mod's commands, such as "shift+tab": "/mode".`);
    commands[key] = command;
  }
  return { keys: commands };
}
var coreVersion = "2.0.1";
function oldestCmodFor(steps) {
  if (steps.permissions?.some((item) => item.startsWith("config:")) === true)
    return "1.6.0";
  if (steps.permissions?.includes("tasks") === true)
    return "1.0.0";
  if (steps.permissions !== undefined)
    return "0.2.0";
  return Object.keys(steps.keys ?? {}).length > 0 ? "0.1.12" : "0.0.0";
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
    throw new Error(`package.json "cmod.${key}" names ${atRoot}, a script at the plugin root. Move it into a folder, such as ./setup/${key}.sh: cmod asks consent for the whole folder of each script.`);
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
      throw new Error(`package.json "cmod.${key}" runs "${command}", which names no script file in the mod, so consent cannot cover what it runs. Put the commands in a script, such as ./setup/${key}.sh.`);
    for (const folder of scriptFolders)
      folders.add(folder);
  }
  let text = [
    steps.install ?? "",
    steps.uninstall ?? "",
    steps.program ?? "",
    ...steps.keys === undefined ? [] : [JSON.stringify(Object.entries(steps.keys).sort())],
    ...steps.permissions === undefined ? [] : [JSON.stringify([...steps.permissions].sort())]
  ].join("\x00");
  for (const folder of [...folders].sort()) {
    for (const name of (await files.list(folder)).sort()) {
      const path = `${folder}/${name}`;
      const content = await files.read(path);
      if (content === undefined)
        throw new Error(`${path} links to a folder or to nothing, so consent cannot cover it. Point the link at a file, or delete it.`);
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
    const [keys = "", ...permissions] = (consent[4] ?? "").split("\t");
    return { type: "needs-consent", sha256: consent[1], install: consent[2], uninstall: consent[3], keys, permissions: permissions.filter((item) => item !== "") };
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
var beforeEvents = ["Prompt", "Note", "Skill", "InstructionFile", "Reply", "ToolCall", "ToolResult", "Notice", "TaskStart", "TurnEnd", "ContextEnd"];
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

// node_modules/@cmodjs/core/ui/places.js
var ToolGroup = "toolGroup";
var ToolProgress = "toolProgress";
var CommandOutput = "commandOutput";
var AskUserQuestion = "askUserQuestion";
var Spinner = "spinner";
var TurnDuration = "turnDuration";
var SessionMode = "sessionMode";
var PromptHint = "promptHint";
var AbovePrompt = "abovePrompt";
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
  [Spinner]: "Spinner",
  [TurnDuration]: "TurnDuration",
  [SessionMode]: "SessionMode",
  [PromptHint]: "PromptHint",
  [AbovePrompt]: "AbovePrompt"
};
function componentOf(place) {
  return typeof place === "string" && Object.hasOwn(components, place) ? components[place] : undefined;
}
function nameOf(place) {
  return typeof place === "string" ? `${place.charAt(0).toUpperCase()}${place.slice(1)}` : place.name;
}
// node_modules/@cmodjs/core/session/context/turn/message/prompt.js
var Prompt = "prompt";
// node_modules/@cmodjs/core/session/context/turn/message/note.js
var Note = "note";
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
// node_modules/@cmodjs/core/session/context/turn/message/notice.js
var Notice = "notice";
// node_modules/@cmodjs/core/runtime/deadline.js
var longestMs = 600000;
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
async function withinTime(clock, method, { timeoutMs = listenerMs }, run) {
  const controller = new AbortController;
  const deadline = await clock.now() + timeoutMs;
  let timer;
  const passed = new Promise((_resolve, reject) => {
    timer = timers.setTimeout(() => {
      controller.abort();
      reject(new PassedTimeout(`${method} passed its ${timeoutMs / 1000} s timeout`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run({ deadline, signal: controller.signal })), passed]);
  } finally {
    timers.clearTimeout(timer);
  }
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
  return `${name} is not installed. Add it with /plugin.`;
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
function defineMod(definition) {
  if (definition.name.trim() === "")
    throw new Error("defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.");
  if (definition.options !== undefined)
    checkOptions(definition.name, definition.options);
  return definition;
}

// node_modules/@cmodjs/core/vendor.js
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var require_constants = __commonJS((exports, module) => {
  var WIN_SLASH = "\\\\/";
  var WIN_NO_SLASH = `[^${WIN_SLASH}]`;
  var DEFAULT_MAX_EXTGLOB_RECURSION = 0;
  var DOT_LITERAL = "\\.";
  var PLUS_LITERAL = "\\+";
  var QMARK_LITERAL = "\\?";
  var SLASH_LITERAL = "\\/";
  var ONE_CHAR = "(?=.)";
  var QMARK = "[^/]";
  var END_ANCHOR = `(?:${SLASH_LITERAL}|$)`;
  var START_ANCHOR = `(?:^|${SLASH_LITERAL})`;
  var DOTS_SLASH = `${DOT_LITERAL}{1,2}${END_ANCHOR}`;
  var NO_DOT = `(?!${DOT_LITERAL})`;
  var NO_DOTS = `(?!${START_ANCHOR}${DOTS_SLASH})`;
  var NO_DOT_SLASH = `(?!${DOT_LITERAL}{0,1}${END_ANCHOR})`;
  var NO_DOTS_SLASH = `(?!${DOTS_SLASH})`;
  var QMARK_NO_DOT = `[^.${SLASH_LITERAL}]`;
  var STAR = `${QMARK}*?`;
  var SEP = "/";
  var POSIX_CHARS = {
    DOT_LITERAL,
    PLUS_LITERAL,
    QMARK_LITERAL,
    SLASH_LITERAL,
    ONE_CHAR,
    QMARK,
    END_ANCHOR,
    DOTS_SLASH,
    NO_DOT,
    NO_DOTS,
    NO_DOT_SLASH,
    NO_DOTS_SLASH,
    QMARK_NO_DOT,
    STAR,
    START_ANCHOR,
    SEP
  };
  var WINDOWS_CHARS = {
    ...POSIX_CHARS,
    SLASH_LITERAL: `[${WIN_SLASH}]`,
    QMARK: WIN_NO_SLASH,
    STAR: `${WIN_NO_SLASH}*?`,
    DOTS_SLASH: `${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$)`,
    NO_DOT: `(?!${DOT_LITERAL})`,
    NO_DOTS: `(?!(?:^|[${WIN_SLASH}])${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
    NO_DOT_SLASH: `(?!${DOT_LITERAL}{0,1}(?:[${WIN_SLASH}]|$))`,
    NO_DOTS_SLASH: `(?!${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
    QMARK_NO_DOT: `[^.${WIN_SLASH}]`,
    START_ANCHOR: `(?:^|[${WIN_SLASH}])`,
    END_ANCHOR: `(?:[${WIN_SLASH}]|$)`,
    SEP: "\\"
  };
  var POSIX_REGEX_SOURCE = {
    __proto__: null,
    alnum: "a-zA-Z0-9",
    alpha: "a-zA-Z",
    ascii: "\\x00-\\x7F",
    blank: " \\t",
    cntrl: "\\x00-\\x1F\\x7F",
    digit: "0-9",
    graph: "\\x21-\\x7E",
    lower: "a-z",
    print: "\\x20-\\x7E ",
    punct: "\\-!\"#$%&'()\\*+,./:;<=>?@[\\]^_`{|}~",
    space: " \\t\\r\\n\\v\\f",
    upper: "A-Z",
    word: "A-Za-z0-9_",
    xdigit: "A-Fa-f0-9"
  };
  module.exports = {
    DEFAULT_MAX_EXTGLOB_RECURSION,
    MAX_LENGTH: 1024 * 64,
    POSIX_REGEX_SOURCE,
    REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g,
    REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/,
    REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/,
    REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g,
    REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g,
    REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g,
    REPLACEMENTS: {
      __proto__: null,
      "***": "*",
      "**/**": "**",
      "**/**/**": "**"
    },
    CHAR_0: 48,
    CHAR_9: 57,
    CHAR_UPPERCASE_A: 65,
    CHAR_LOWERCASE_A: 97,
    CHAR_UPPERCASE_Z: 90,
    CHAR_LOWERCASE_Z: 122,
    CHAR_LEFT_PARENTHESES: 40,
    CHAR_RIGHT_PARENTHESES: 41,
    CHAR_ASTERISK: 42,
    CHAR_AMPERSAND: 38,
    CHAR_AT: 64,
    CHAR_BACKWARD_SLASH: 92,
    CHAR_CARRIAGE_RETURN: 13,
    CHAR_CIRCUMFLEX_ACCENT: 94,
    CHAR_COLON: 58,
    CHAR_COMMA: 44,
    CHAR_DOT: 46,
    CHAR_DOUBLE_QUOTE: 34,
    CHAR_EQUAL: 61,
    CHAR_EXCLAMATION_MARK: 33,
    CHAR_FORM_FEED: 12,
    CHAR_FORWARD_SLASH: 47,
    CHAR_GRAVE_ACCENT: 96,
    CHAR_HASH: 35,
    CHAR_HYPHEN_MINUS: 45,
    CHAR_LEFT_ANGLE_BRACKET: 60,
    CHAR_LEFT_CURLY_BRACE: 123,
    CHAR_LEFT_SQUARE_BRACKET: 91,
    CHAR_LINE_FEED: 10,
    CHAR_NO_BREAK_SPACE: 160,
    CHAR_PERCENT: 37,
    CHAR_PLUS: 43,
    CHAR_QUESTION_MARK: 63,
    CHAR_RIGHT_ANGLE_BRACKET: 62,
    CHAR_RIGHT_CURLY_BRACE: 125,
    CHAR_RIGHT_SQUARE_BRACKET: 93,
    CHAR_SEMICOLON: 59,
    CHAR_SINGLE_QUOTE: 39,
    CHAR_SPACE: 32,
    CHAR_TAB: 9,
    CHAR_UNDERSCORE: 95,
    CHAR_VERTICAL_LINE: 124,
    CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279,
    extglobChars(chars) {
      return {
        "!": { type: "negate", open: "(?:(?!(?:", close: `))${chars.STAR})` },
        "?": { type: "qmark", open: "(?:", close: ")?" },
        "+": { type: "plus", open: "(?:", close: ")+" },
        "*": { type: "star", open: "(?:", close: ")*" },
        "@": { type: "at", open: "(?:", close: ")" }
      };
    },
    globChars(win32) {
      return win32 === true ? WINDOWS_CHARS : POSIX_CHARS;
    }
  };
});
var require_utils = __commonJS((exports) => {
  var {
    REGEX_BACKSLASH,
    REGEX_REMOVE_BACKSLASH,
    REGEX_SPECIAL_CHARS,
    REGEX_SPECIAL_CHARS_GLOBAL
  } = require_constants();
  exports.isObject = (val) => val !== null && typeof val === "object" && !Array.isArray(val);
  exports.hasRegexChars = (str) => REGEX_SPECIAL_CHARS.test(str);
  exports.isRegexChar = (str) => str.length === 1 && exports.hasRegexChars(str);
  exports.escapeRegex = (str) => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, "\\$1");
  exports.toPosixSlashes = (str) => str.replace(REGEX_BACKSLASH, "/");
  exports.isWindows = () => {
    if (typeof navigator !== "undefined" && navigator.platform) {
      const platform = navigator.platform.toLowerCase();
      return platform === "win32" || platform === "windows";
    }
    if (false) {}
    return false;
  };
  exports.removeBackslashes = (str) => {
    return str.replace(REGEX_REMOVE_BACKSLASH, (match) => {
      return match === "\\" ? "" : match;
    });
  };
  exports.escapeLast = (input, char, lastIdx) => {
    const idx = input.lastIndexOf(char, lastIdx);
    if (idx === -1)
      return input;
    if (input[idx - 1] === "\\")
      return exports.escapeLast(input, char, idx - 1);
    return `${input.slice(0, idx)}\\${input.slice(idx)}`;
  };
  exports.removePrefix = (input, state = {}) => {
    let output = input;
    if (output.startsWith("./")) {
      output = output.slice(2);
      state.prefix = "./";
    }
    return output;
  };
  exports.wrapOutput = (input, state = {}, options = {}) => {
    const prepend = options.contains ? "" : "^";
    const append = options.contains ? "" : "$";
    let output = `${prepend}(?:${input})${append}`;
    if (state.negated === true) {
      output = `(?:^(?!${output}).*$)`;
    }
    return output;
  };
  exports.basename = (path, { windows } = {}) => {
    const segs = path.split(windows ? /[\\/]/ : "/");
    const last = segs[segs.length - 1];
    if (last === "") {
      return segs[segs.length - 2];
    }
    return last;
  };
});
var require_scan = __commonJS((exports, module) => {
  var utils = require_utils();
  var {
    CHAR_ASTERISK,
    CHAR_AT,
    CHAR_BACKWARD_SLASH,
    CHAR_COMMA,
    CHAR_DOT,
    CHAR_EXCLAMATION_MARK,
    CHAR_FORWARD_SLASH,
    CHAR_LEFT_CURLY_BRACE,
    CHAR_LEFT_PARENTHESES,
    CHAR_LEFT_SQUARE_BRACKET,
    CHAR_PLUS,
    CHAR_QUESTION_MARK,
    CHAR_RIGHT_CURLY_BRACE,
    CHAR_RIGHT_PARENTHESES,
    CHAR_RIGHT_SQUARE_BRACKET
  } = require_constants();
  var isPathSeparator = (code) => {
    return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
  };
  var depth = (token) => {
    if (token.isPrefix !== true) {
      token.depth = token.isGlobstar ? Infinity : 1;
    }
  };
  var scan = (input, options) => {
    const opts = options || {};
    const length = input.length - 1;
    const scanToEnd = opts.parts === true || opts.tokens === true || opts.scanToEnd === true;
    const slashes = [];
    const tokens = [];
    const parts = [];
    let str = input;
    let index = -1;
    let start = 0;
    let lastIndex = 0;
    let isBrace = false;
    let isBracket = false;
    let isGlob = false;
    let isExtglob = false;
    let isGlobstar = false;
    let braceEscaped = false;
    let backslashes = false;
    let negated = false;
    let negatedExtglob = false;
    let finished = false;
    let braces = 0;
    let prev;
    let code;
    let token = { value: "", depth: 0, isGlob: false };
    const eos = () => index >= length;
    const peek = () => str.charCodeAt(index + 1);
    const advance = () => {
      prev = code;
      return str.charCodeAt(++index);
    };
    while (index < length) {
      code = advance();
      let next;
      if (code === CHAR_BACKWARD_SLASH) {
        backslashes = token.backslashes = true;
        code = advance();
        if (code === CHAR_LEFT_CURLY_BRACE) {
          braceEscaped = true;
        }
        continue;
      }
      if (braceEscaped === true || code === CHAR_LEFT_CURLY_BRACE) {
        braces++;
        while (eos() !== true && (code = advance())) {
          if (code === CHAR_BACKWARD_SLASH) {
            backslashes = token.backslashes = true;
            advance();
            continue;
          }
          if (code === CHAR_LEFT_CURLY_BRACE) {
            braces++;
            continue;
          }
          if (braceEscaped !== true && code === CHAR_DOT && (code = advance()) === CHAR_DOT) {
            isBrace = token.isBrace = true;
            isGlob = token.isGlob = true;
            finished = true;
            if (scanToEnd === true) {
              continue;
            }
            break;
          }
          if (braceEscaped !== true && code === CHAR_COMMA) {
            isBrace = token.isBrace = true;
            isGlob = token.isGlob = true;
            finished = true;
            if (scanToEnd === true) {
              continue;
            }
            break;
          }
          if (code === CHAR_RIGHT_CURLY_BRACE) {
            braces--;
            if (braces === 0) {
              braceEscaped = false;
              isBrace = token.isBrace = true;
              finished = true;
              break;
            }
          }
        }
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
      if (code === CHAR_FORWARD_SLASH) {
        slashes.push(index);
        tokens.push(token);
        token = { value: "", depth: 0, isGlob: false };
        if (finished === true)
          continue;
        if (prev === CHAR_DOT && index === start + 1) {
          start += 2;
          continue;
        }
        lastIndex = index + 1;
        continue;
      }
      if (opts.noext !== true) {
        const isExtglobChar = code === CHAR_PLUS || code === CHAR_AT || code === CHAR_ASTERISK || code === CHAR_QUESTION_MARK || code === CHAR_EXCLAMATION_MARK;
        if (isExtglobChar === true && peek() === CHAR_LEFT_PARENTHESES) {
          isGlob = token.isGlob = true;
          isExtglob = token.isExtglob = true;
          finished = true;
          if (code === CHAR_EXCLAMATION_MARK && index === start) {
            negatedExtglob = true;
          }
          if (scanToEnd === true) {
            let parens = 0;
            while (eos() !== true && (code = advance())) {
              if (code === CHAR_BACKWARD_SLASH) {
                backslashes = token.backslashes = true;
                advance();
                continue;
              }
              if (code === CHAR_LEFT_PARENTHESES) {
                parens++;
                continue;
              }
              if (code === CHAR_RIGHT_PARENTHESES && --parens === 0) {
                finished = true;
                break;
              }
            }
            continue;
          }
          break;
        }
      }
      if (code === CHAR_ASTERISK) {
        if (prev === CHAR_ASTERISK)
          isGlobstar = token.isGlobstar = true;
        isGlob = token.isGlob = true;
        finished = true;
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
      if (code === CHAR_QUESTION_MARK) {
        isGlob = token.isGlob = true;
        finished = true;
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
      if (code === CHAR_LEFT_SQUARE_BRACKET) {
        while (eos() !== true && (next = advance())) {
          if (next === CHAR_BACKWARD_SLASH) {
            backslashes = token.backslashes = true;
            advance();
            continue;
          }
          if (next === CHAR_RIGHT_SQUARE_BRACKET) {
            isBracket = token.isBracket = true;
            isGlob = token.isGlob = true;
            finished = true;
            break;
          }
        }
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
      if (opts.nonegate !== true && code === CHAR_EXCLAMATION_MARK && index === start) {
        negated = token.negated = true;
        start++;
        continue;
      }
      if (opts.noparen !== true && code === CHAR_LEFT_PARENTHESES) {
        isGlob = token.isGlob = true;
        if (scanToEnd === true) {
          let parens = 1;
          while (eos() !== true && (code = advance())) {
            if (code === CHAR_BACKWARD_SLASH) {
              backslashes = token.backslashes = true;
              advance();
              continue;
            }
            if (code === CHAR_LEFT_PARENTHESES) {
              parens++;
              continue;
            }
            if (code === CHAR_RIGHT_PARENTHESES && --parens === 0) {
              finished = true;
              break;
            }
          }
          continue;
        }
        break;
      }
      if (isGlob === true) {
        finished = true;
        if (scanToEnd === true) {
          continue;
        }
        break;
      }
    }
    if (opts.noext === true) {
      isExtglob = false;
      isGlob = false;
    }
    let base = str;
    let prefix = "";
    let glob = "";
    if (start > 0) {
      prefix = str.slice(0, start);
      str = str.slice(start);
      lastIndex -= start;
    }
    if (base && isGlob === true && lastIndex > 0) {
      base = str.slice(0, lastIndex);
      glob = str.slice(lastIndex);
    } else if (isGlob === true) {
      base = "";
      glob = str;
    } else {
      base = str;
    }
    if (base && base !== "" && base !== "/" && base !== str) {
      if (isPathSeparator(base.charCodeAt(base.length - 1))) {
        base = base.slice(0, -1);
      }
    }
    if (opts.unescape === true) {
      if (glob)
        glob = utils.removeBackslashes(glob);
      if (base && backslashes === true) {
        base = utils.removeBackslashes(base);
      }
    }
    const state = {
      prefix,
      input,
      start,
      base,
      glob,
      isBrace,
      isBracket,
      isGlob,
      isExtglob,
      isGlobstar,
      negated,
      negatedExtglob
    };
    if (opts.tokens === true) {
      state.maxDepth = 0;
      if (!isPathSeparator(code)) {
        tokens.push(token);
      }
      state.tokens = tokens;
    }
    if (opts.parts === true || opts.tokens === true) {
      let prevIndex;
      for (let idx = 0;idx < slashes.length; idx++) {
        const n2 = prevIndex !== undefined ? prevIndex + 1 : start;
        const i = slashes[idx];
        const value2 = input.slice(n2, i);
        if (opts.tokens) {
          if (idx === 0 && start !== 0) {
            tokens[idx].isPrefix = true;
            tokens[idx].value = prefix;
          } else {
            tokens[idx].value = value2;
          }
          depth(tokens[idx]);
          state.maxDepth += tokens[idx].depth;
        }
        if (i >= start) {
          parts.push(value2);
          prevIndex = i;
        }
      }
      const n = prevIndex !== undefined ? prevIndex + 1 : start;
      const value = input.slice(n);
      parts.push(value);
      if (opts.tokens && prevIndex && prevIndex + 1 < input.length) {
        tokens[tokens.length - 1].value = value;
        depth(tokens[tokens.length - 1]);
        state.maxDepth += tokens[tokens.length - 1].depth;
      }
      state.slashes = slashes;
      state.parts = parts;
    }
    return state;
  };
  module.exports = scan;
});
var require_parse = __commonJS((exports, module) => {
  var constants = require_constants();
  var utils = require_utils();
  var {
    MAX_LENGTH,
    POSIX_REGEX_SOURCE,
    REGEX_NON_SPECIAL_CHARS,
    REGEX_SPECIAL_CHARS_BACKREF,
    REPLACEMENTS
  } = constants;
  var expandRange = (args, options) => {
    if (typeof options.expandRange === "function") {
      return options.expandRange(...args, options);
    }
    args.sort();
    const value = `[${args.join("-")}]`;
    try {
      new RegExp(value);
    } catch (ex) {
      return args.map((v) => utils.escapeRegex(v)).join("..");
    }
    return value;
  };
  var syntaxError = (type, char) => {
    return `Missing ${type}: "${char}" - use "\\\\${char}" to match literal characters`;
  };
  var splitTopLevel = (input) => {
    const parts = [];
    let bracket = 0;
    let paren = 0;
    let quote = 0;
    let value = "";
    let escaped = false;
    for (const ch of input) {
      if (escaped === true) {
        value += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        value += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quote = quote === 1 ? 0 : 1;
        value += ch;
        continue;
      }
      if (quote === 0) {
        if (ch === "[") {
          bracket++;
        } else if (ch === "]" && bracket > 0) {
          bracket--;
        } else if (bracket === 0) {
          if (ch === "(") {
            paren++;
          } else if (ch === ")" && paren > 0) {
            paren--;
          } else if (ch === "|" && paren === 0) {
            parts.push(value);
            value = "";
            continue;
          }
        }
      }
      value += ch;
    }
    parts.push(value);
    return parts;
  };
  var isPlainBranch = (branch) => {
    let escaped = false;
    for (const ch of branch) {
      if (escaped === true) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (/[?*+@!()[\]{}]/.test(ch)) {
        return false;
      }
    }
    return true;
  };
  var normalizeSimpleBranch = (branch) => {
    let value = branch.trim();
    let changed = true;
    while (changed === true) {
      changed = false;
      if (/^@\([^\\()[\]{}|]+\)$/.test(value)) {
        value = value.slice(2, -1);
        changed = true;
      }
    }
    if (!isPlainBranch(value)) {
      return;
    }
    return value.replace(/\\(.)/g, "$1");
  };
  var hasRepeatedCharPrefixOverlap = (branches) => {
    const values = branches.map(normalizeSimpleBranch).filter(Boolean);
    for (let i = 0;i < values.length; i++) {
      for (let j = i + 1;j < values.length; j++) {
        const a = values[i];
        const b = values[j];
        const char = a[0];
        if (!char || a !== char.repeat(a.length) || b !== char.repeat(b.length)) {
          continue;
        }
        if (a === b || a.startsWith(b) || b.startsWith(a)) {
          return true;
        }
      }
    }
    return false;
  };
  var parseRepeatedExtglob = (pattern, requireEnd = true) => {
    if (pattern[0] !== "+" && pattern[0] !== "*" || pattern[1] !== "(") {
      return;
    }
    let bracket = 0;
    let paren = 0;
    let quote = 0;
    let escaped = false;
    for (let i = 1;i < pattern.length; i++) {
      const ch = pattern[i];
      if (escaped === true) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quote = quote === 1 ? 0 : 1;
        continue;
      }
      if (quote === 1) {
        continue;
      }
      if (ch === "[") {
        bracket++;
        continue;
      }
      if (ch === "]" && bracket > 0) {
        bracket--;
        continue;
      }
      if (bracket > 0) {
        continue;
      }
      if (ch === "(") {
        paren++;
        continue;
      }
      if (ch === ")") {
        paren--;
        if (paren === 0) {
          if (requireEnd === true && i !== pattern.length - 1) {
            return;
          }
          return {
            type: pattern[0],
            body: pattern.slice(2, i),
            end: i
          };
        }
      }
    }
  };
  var buildCharClassStar = (chars) => {
    const source = chars.length === 1 ? utils.escapeRegex(chars[0]) : `[${chars.map((ch) => utils.escapeRegex(ch)).join("")}]`;
    return `${source}*`;
  };
  var getStarExtglobSequenceChars = (pattern) => {
    let index = 0;
    const chars = [];
    while (index < pattern.length) {
      const match = parseRepeatedExtglob(pattern.slice(index), false);
      if (!match || match.type !== "*") {
        return;
      }
      const branches = splitTopLevel(match.body).map((branch2) => branch2.trim());
      if (branches.length !== 1) {
        return;
      }
      const branch = normalizeSimpleBranch(branches[0]);
      if (!branch || branch.length !== 1) {
        return;
      }
      chars.push(branch);
      index += match.end + 1;
    }
    if (chars.length < 1) {
      return;
    }
    return chars;
  };
  var repeatedExtglobRecursion = (pattern) => {
    let depth = 0;
    let value = pattern.trim();
    let match = parseRepeatedExtglob(value);
    while (match) {
      depth++;
      value = match.body.trim();
      match = parseRepeatedExtglob(value);
    }
    return depth;
  };
  var analyzeRepeatedExtglob = (body, options) => {
    if (options.maxExtglobRecursion === false) {
      return { risky: false };
    }
    const max = typeof options.maxExtglobRecursion === "number" ? options.maxExtglobRecursion : constants.DEFAULT_MAX_EXTGLOB_RECURSION;
    const branches = splitTopLevel(body).map((branch) => branch.trim());
    if (branches.length > 1) {
      if (branches.some((branch) => branch === "") || branches.some((branch) => /^[*?]+$/.test(branch)) || hasRepeatedCharPrefixOverlap(branches)) {
        return { risky: true };
      }
    }
    const safeChars = [];
    let sawStarSequence = false;
    let combinable = true;
    for (const branch of branches) {
      const chars = getStarExtglobSequenceChars(branch);
      if (chars) {
        sawStarSequence = true;
        safeChars.push(...chars);
        continue;
      }
      const literal = normalizeSimpleBranch(branch);
      if (literal && literal.length === 1) {
        safeChars.push(literal);
        continue;
      }
      combinable = false;
      if (repeatedExtglobRecursion(branch) > max) {
        return { risky: true };
      }
    }
    if (sawStarSequence) {
      return combinable ? { risky: true, safeOutput: buildCharClassStar([...new Set(safeChars)]) } : { risky: true };
    }
    return { risky: false };
  };
  var parse2 = (input, options) => {
    if (typeof input !== "string") {
      throw new TypeError("Expected a string");
    }
    input = REPLACEMENTS[input] || input;
    const opts = { ...options };
    const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
    let len = input.length;
    if (len > max) {
      throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
    }
    const bos = { type: "bos", value: "", output: opts.prepend || "" };
    const tokens = [bos];
    const capture = opts.capture ? "" : "?:";
    const PLATFORM_CHARS = constants.globChars(opts.windows);
    const EXTGLOB_CHARS = constants.extglobChars(PLATFORM_CHARS);
    const {
      DOT_LITERAL,
      PLUS_LITERAL,
      SLASH_LITERAL,
      ONE_CHAR,
      DOTS_SLASH,
      NO_DOT,
      NO_DOT_SLASH,
      NO_DOTS_SLASH,
      QMARK,
      QMARK_NO_DOT,
      STAR,
      START_ANCHOR
    } = PLATFORM_CHARS;
    const globstar = (opts2) => {
      return `(${capture}(?:(?!${START_ANCHOR}${opts2.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
    };
    const nodot = opts.dot ? "" : NO_DOT;
    const qmarkNoDot = opts.dot ? QMARK : QMARK_NO_DOT;
    let star = opts.bash === true ? globstar(opts) : STAR;
    if (opts.capture) {
      star = `(${star})`;
    }
    if (typeof opts.noext === "boolean") {
      opts.noextglob = opts.noext;
    }
    const state = {
      input,
      index: -1,
      start: 0,
      dot: opts.dot === true,
      consumed: "",
      output: "",
      prefix: "",
      backtrack: false,
      negated: false,
      brackets: 0,
      braces: 0,
      parens: 0,
      quotes: 0,
      globstar: false,
      tokens
    };
    input = utils.removePrefix(input, state);
    len = input.length;
    const extglobs = [];
    const braces = [];
    const stack = [];
    let prev = bos;
    let value;
    const eos = () => state.index === len - 1;
    const peek = state.peek = (n = 1) => input[state.index + n];
    const advance = state.advance = () => input[++state.index] || "";
    const remaining = () => input.slice(state.index + 1);
    const consume = (value2 = "", num = 0) => {
      state.consumed += value2;
      state.index += num;
    };
    const append = (token) => {
      state.output += token.output != null ? token.output : token.value;
      consume(token.value);
    };
    const negate = () => {
      let count = 1;
      while (peek() === "!" && (peek(2) !== "(" || peek(3) === "?")) {
        advance();
        state.start++;
        count++;
      }
      if (count % 2 === 0) {
        return false;
      }
      state.negated = true;
      state.start++;
      return true;
    };
    const increment = (type) => {
      state[type]++;
      stack.push(type);
    };
    const decrement = (type) => {
      state[type]--;
      stack.pop();
    };
    const push = (tok) => {
      if (prev.type === "globstar") {
        const isBrace = state.braces > 0 && (tok.type === "comma" || tok.type === "brace");
        const isExtglob = tok.extglob === true || extglobs.length && (tok.type === "pipe" || tok.type === "paren");
        if (tok.type !== "slash" && tok.type !== "paren" && !isBrace && !isExtglob) {
          state.output = state.output.slice(0, -prev.output.length);
          prev.type = "star";
          prev.value = "*";
          prev.output = star;
          state.output += prev.output;
        }
      }
      if (extglobs.length && tok.type !== "paren") {
        extglobs[extglobs.length - 1].inner += tok.value;
      }
      if (tok.value || tok.output)
        append(tok);
      if (prev && prev.type === "text" && tok.type === "text") {
        prev.output = (prev.output || prev.value) + tok.value;
        prev.value += tok.value;
        return;
      }
      tok.prev = prev;
      tokens.push(tok);
      prev = tok;
    };
    const extglobOpen = (type, value2) => {
      const token = { ...EXTGLOB_CHARS[value2], conditions: 1, inner: "" };
      token.prev = prev;
      token.parens = state.parens;
      token.output = state.output;
      token.startIndex = state.index;
      token.tokensIndex = tokens.length;
      const output = (opts.capture ? "(" : "") + token.open;
      increment("parens");
      push({ type, value: value2, output: state.output ? "" : ONE_CHAR });
      push({ type: "paren", extglob: true, value: advance(), output });
      extglobs.push(token);
    };
    const extglobClose = (token) => {
      const literal = input.slice(token.startIndex, state.index + 1);
      const body = input.slice(token.startIndex + 2, state.index);
      const analysis = analyzeRepeatedExtglob(body, opts);
      if ((token.type === "plus" || token.type === "star") && analysis.risky) {
        const safeOutput = analysis.safeOutput ? (token.output ? "" : ONE_CHAR) + (opts.capture ? `(${analysis.safeOutput})` : analysis.safeOutput) : undefined;
        const open = tokens[token.tokensIndex];
        open.type = "text";
        open.value = literal;
        open.output = safeOutput || utils.escapeRegex(literal);
        for (let i = token.tokensIndex + 1;i < tokens.length; i++) {
          tokens[i].value = "";
          tokens[i].output = "";
          delete tokens[i].suffix;
        }
        state.output = token.output + open.output;
        state.backtrack = true;
        push({ type: "paren", extglob: true, value, output: "" });
        decrement("parens");
        return;
      }
      let output = token.close + (opts.capture ? ")" : "");
      let rest;
      if (token.type === "negate") {
        let extglobStar = star;
        if (token.inner && token.inner.length > 1 && token.inner.includes("/")) {
          extglobStar = globstar(opts);
        }
        if (extglobStar !== star || eos() || /^\)+$/.test(remaining())) {
          output = token.close = `)$))${extglobStar}`;
        }
        if (token.inner.includes("*") && (rest = remaining()) && /^\.[^\\/.]+$/.test(rest)) {
          const expression = parse2(rest, { ...options, fastpaths: false }).output;
          output = token.close = `)${expression})${extglobStar})`;
        }
        if (token.prev.type === "bos") {
          state.negatedExtglob = true;
        }
      }
      push({ type: "paren", extglob: true, value, output });
      decrement("parens");
    };
    if (opts.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(input)) {
      let backslashes = false;
      let output = input.replace(REGEX_SPECIAL_CHARS_BACKREF, (m, esc, chars, first, rest, index) => {
        if (first === "\\") {
          backslashes = true;
          return m;
        }
        if (first === "?") {
          if (esc) {
            return esc + first + (rest ? QMARK.repeat(rest.length) : "");
          }
          if (index === 0) {
            return qmarkNoDot + (rest ? QMARK.repeat(rest.length) : "");
          }
          return QMARK.repeat(chars.length);
        }
        if (first === ".") {
          return DOT_LITERAL.repeat(chars.length);
        }
        if (first === "*") {
          if (esc) {
            return esc + first + (rest ? star : "");
          }
          return star;
        }
        return esc ? m : `\\${m}`;
      });
      if (backslashes === true) {
        if (opts.unescape === true) {
          output = output.replace(/\\/g, "");
        } else {
          output = output.replace(/\\+/g, (m) => {
            return m.length % 2 === 0 ? "\\\\" : m ? "\\" : "";
          });
        }
      }
      if (output === input && opts.contains === true) {
        state.output = input;
        return state;
      }
      state.output = utils.wrapOutput(output, state, options);
      return state;
    }
    while (!eos()) {
      value = advance();
      if (value === "\x00") {
        continue;
      }
      if (value === "\\") {
        const next = peek();
        if (next === "/" && opts.bash !== true) {
          continue;
        }
        if (next === "." || next === ";") {
          continue;
        }
        if (!next) {
          value += "\\";
          push({ type: "text", value });
          continue;
        }
        const match = /^\\+/.exec(remaining());
        let slashes = 0;
        if (match && match[0].length > 2) {
          slashes = match[0].length;
          state.index += slashes;
          if (slashes % 2 !== 0) {
            value += "\\";
          }
        }
        if (opts.unescape === true) {
          value = advance();
        } else {
          value += advance();
        }
        if (state.brackets === 0) {
          push({ type: "text", value });
          continue;
        }
      }
      if (state.brackets > 0 && (value !== "]" || prev.value === "[" || prev.value === "[^")) {
        if (opts.posix !== false && value === ":") {
          const inner = prev.value.slice(1);
          if (inner.includes("[")) {
            prev.posix = true;
            if (inner.includes(":")) {
              const idx = prev.value.lastIndexOf("[");
              const pre = prev.value.slice(0, idx);
              const rest2 = prev.value.slice(idx + 2);
              const posix = POSIX_REGEX_SOURCE[rest2];
              if (posix) {
                prev.value = pre + posix;
                state.backtrack = true;
                advance();
                if (!bos.output && tokens.indexOf(prev) === 1) {
                  bos.output = ONE_CHAR;
                }
                continue;
              }
            }
          }
        }
        if (value === "[" && peek() !== ":" || value === "-" && peek() === "]") {
          value = `\\${value}`;
        }
        if (value === "]" && (prev.value === "[" || prev.value === "[^")) {
          value = `\\${value}`;
        }
        if (opts.posix === true && value === "!" && prev.value === "[") {
          value = "^";
        }
        prev.value += value;
        append({ value });
        continue;
      }
      if (state.quotes === 1 && value !== '"') {
        value = utils.escapeRegex(value);
        prev.value += value;
        append({ value });
        continue;
      }
      if (value === '"') {
        state.quotes = state.quotes === 1 ? 0 : 1;
        if (opts.keepQuotes === true) {
          push({ type: "text", value });
        }
        continue;
      }
      if (value === "(") {
        increment("parens");
        push({ type: "paren", value });
        continue;
      }
      if (value === ")") {
        if (state.parens === 0 && opts.strictBrackets === true) {
          throw new SyntaxError(syntaxError("opening", "("));
        }
        const extglob = extglobs[extglobs.length - 1];
        if (extglob && state.parens === extglob.parens + 1) {
          extglobClose(extglobs.pop());
          continue;
        }
        push({ type: "paren", value, output: state.parens ? ")" : "\\)" });
        decrement("parens");
        continue;
      }
      if (value === "[") {
        if (opts.nobracket === true || !remaining().includes("]")) {
          if (opts.nobracket !== true && opts.strictBrackets === true) {
            throw new SyntaxError(syntaxError("closing", "]"));
          }
          value = `\\${value}`;
        } else {
          increment("brackets");
        }
        push({ type: "bracket", value });
        continue;
      }
      if (value === "]") {
        if (opts.nobracket === true || prev && prev.type === "bracket" && prev.value.length === 1) {
          push({ type: "text", value, output: `\\${value}` });
          continue;
        }
        if (state.brackets === 0) {
          if (opts.strictBrackets === true) {
            throw new SyntaxError(syntaxError("opening", "["));
          }
          push({ type: "text", value, output: `\\${value}` });
          continue;
        }
        decrement("brackets");
        const prevValue = prev.value.slice(1);
        if (prev.posix !== true && prevValue[0] === "^" && !prevValue.includes("/")) {
          value = `/${value}`;
        }
        prev.value += value;
        append({ value });
        if (opts.literalBrackets === false || utils.hasRegexChars(prevValue)) {
          continue;
        }
        const escaped = utils.escapeRegex(prev.value);
        state.output = state.output.slice(0, -prev.value.length);
        if (opts.literalBrackets === true) {
          state.output += escaped;
          prev.value = escaped;
          continue;
        }
        prev.value = `(${capture}${escaped}|${prev.value})`;
        state.output += prev.value;
        continue;
      }
      if (value === "{" && opts.nobrace !== true) {
        increment("braces");
        const open = {
          type: "brace",
          value,
          output: "(",
          outputIndex: state.output.length,
          tokensIndex: state.tokens.length
        };
        braces.push(open);
        push(open);
        continue;
      }
      if (value === "}") {
        const brace = braces[braces.length - 1];
        if (opts.nobrace === true || !brace) {
          push({ type: "text", value, output: value });
          continue;
        }
        let output = ")";
        if (brace.dots === true) {
          const arr = tokens.slice();
          const range = [];
          for (let i = arr.length - 1;i >= 0; i--) {
            tokens.pop();
            if (arr[i].type === "brace") {
              break;
            }
            if (arr[i].type !== "dots") {
              range.unshift(arr[i].value);
            }
          }
          output = expandRange(range, opts);
          state.backtrack = true;
        }
        if (brace.comma !== true && brace.dots !== true) {
          const out = state.output.slice(0, brace.outputIndex);
          const toks = state.tokens.slice(brace.tokensIndex);
          brace.value = brace.output = "\\{";
          value = output = "\\}";
          state.output = out;
          for (const t of toks) {
            state.output += t.output || t.value;
          }
        }
        push({ type: "brace", value, output });
        decrement("braces");
        braces.pop();
        continue;
      }
      if (value === "|") {
        if (extglobs.length > 0) {
          extglobs[extglobs.length - 1].conditions++;
        }
        push({ type: "text", value });
        continue;
      }
      if (value === ",") {
        let output = value;
        const brace = braces[braces.length - 1];
        if (brace && stack[stack.length - 1] === "braces") {
          brace.comma = true;
          output = "|";
        }
        push({ type: "comma", value, output });
        continue;
      }
      if (value === "/") {
        if (prev.type === "dot" && state.index === state.start + 1) {
          state.start = state.index + 1;
          state.consumed = "";
          state.output = "";
          tokens.pop();
          prev = bos;
          continue;
        }
        push({ type: "slash", value, output: SLASH_LITERAL });
        continue;
      }
      if (value === ".") {
        if (state.braces > 0 && prev.type === "dot") {
          if (prev.value === ".")
            prev.output = DOT_LITERAL;
          const brace = braces[braces.length - 1];
          prev.type = "dots";
          prev.output += value;
          prev.value += value;
          brace.dots = true;
          continue;
        }
        if (state.braces + state.parens === 0 && prev.type !== "bos" && prev.type !== "slash") {
          push({ type: "text", value, output: DOT_LITERAL });
          continue;
        }
        push({ type: "dot", value, output: DOT_LITERAL });
        continue;
      }
      if (value === "?") {
        const isGroup = prev && prev.value === "(";
        if (!isGroup && opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
          extglobOpen("qmark", value);
          continue;
        }
        if (prev && prev.type === "paren") {
          const next = peek();
          let output = value;
          if (prev.value === "(" && !/[!=<:]/.test(next) || next === "<" && !/<([!=]|\w+>)/.test(remaining())) {
            output = `\\${value}`;
          }
          push({ type: "text", value, output });
          continue;
        }
        if (opts.dot !== true && (prev.type === "slash" || prev.type === "bos")) {
          push({ type: "qmark", value, output: QMARK_NO_DOT });
          continue;
        }
        push({ type: "qmark", value, output: QMARK });
        continue;
      }
      if (value === "!") {
        if (opts.noextglob !== true && peek() === "(") {
          if (peek(2) !== "?" || !/[!=<:]/.test(peek(3))) {
            extglobOpen("negate", value);
            continue;
          }
        }
        if (opts.nonegate !== true && state.index === 0) {
          negate();
          continue;
        }
      }
      if (value === "+") {
        if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
          extglobOpen("plus", value);
          continue;
        }
        if (prev && prev.value === "(" || opts.regex === false) {
          push({ type: "plus", value, output: PLUS_LITERAL });
          continue;
        }
        if (prev && (prev.type === "bracket" || prev.type === "paren" || prev.type === "brace") || state.parens > 0) {
          push({ type: "plus", value });
          continue;
        }
        push({ type: "plus", value: PLUS_LITERAL });
        continue;
      }
      if (value === "@") {
        if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
          push({ type: "at", extglob: true, value, output: "" });
          continue;
        }
        push({ type: "text", value });
        continue;
      }
      if (value !== "*") {
        if (value === "$" || value === "^") {
          value = `\\${value}`;
        }
        const match = REGEX_NON_SPECIAL_CHARS.exec(remaining());
        if (match) {
          value += match[0];
          state.index += match[0].length;
        }
        push({ type: "text", value });
        continue;
      }
      if (prev && (prev.type === "globstar" || prev.star === true)) {
        prev.type = "star";
        prev.star = true;
        prev.value += value;
        prev.output = star;
        state.backtrack = true;
        state.globstar = true;
        consume(value);
        continue;
      }
      let rest = remaining();
      if (opts.noextglob !== true && /^\([^?]/.test(rest)) {
        extglobOpen("star", value);
        continue;
      }
      if (prev.type === "star") {
        if (opts.noglobstar === true) {
          consume(value);
          continue;
        }
        const prior = prev.prev;
        const before = prior.prev;
        const isStart = prior.type === "slash" || prior.type === "bos";
        const afterStar = before && (before.type === "star" || before.type === "globstar");
        if (opts.bash === true && (!isStart || rest[0] && rest[0] !== "/")) {
          push({ type: "star", value, output: "" });
          continue;
        }
        const isBrace = state.braces > 0 && (prior.type === "comma" || prior.type === "brace");
        const isExtglob = extglobs.length && (prior.type === "pipe" || prior.type === "paren");
        if (!isStart && prior.type !== "paren" && !isBrace && !isExtglob) {
          push({ type: "star", value, output: "" });
          continue;
        }
        while (rest.slice(0, 3) === "/**") {
          const after = input[state.index + 4];
          if (after && after !== "/") {
            break;
          }
          rest = rest.slice(3);
          consume("/**", 3);
        }
        const isEnd = eos() || state.parens > 0 && rest === ")".repeat(state.parens) && !extglobs.some((extglob) => extglob.type === "negate");
        if (prior.type === "bos" && eos()) {
          prev.type = "globstar";
          prev.value += value;
          prev.output = globstar(opts);
          state.output = prev.output;
          state.globstar = true;
          consume(value);
          continue;
        }
        if (prior.type === "slash" && prior.prev.type !== "bos" && !afterStar && isEnd) {
          state.output = state.output.slice(0, -(prior.output + prev.output).length);
          prior.output = `(?:${prior.output}`;
          prev.type = "globstar";
          prev.output = globstar(opts) + (opts.strictSlashes ? ")" : "|$)");
          prev.value += value;
          state.globstar = true;
          state.output += prior.output + prev.output;
          consume(value);
          continue;
        }
        if (prior.type === "slash" && prior.prev.type !== "bos" && rest[0] === "/") {
          const end = rest[1] !== undefined ? "|$" : "";
          state.output = state.output.slice(0, -(prior.output + prev.output).length);
          prior.output = `(?:${prior.output}`;
          prev.type = "globstar";
          prev.output = `${globstar(opts)}${SLASH_LITERAL}|${SLASH_LITERAL}${end})`;
          prev.value += value;
          state.output += prior.output + prev.output;
          state.globstar = true;
          consume(value + advance());
          push({ type: "slash", value: "/", output: "" });
          continue;
        }
        if (prior.type === "bos" && rest[0] === "/") {
          prev.type = "globstar";
          prev.value += value;
          prev.output = `(?:^|${SLASH_LITERAL}|${globstar(opts)}${SLASH_LITERAL})`;
          state.output = prev.output;
          state.globstar = true;
          consume(value + advance());
          push({ type: "slash", value: "/", output: "" });
          continue;
        }
        state.output = state.output.slice(0, -prev.output.length);
        prev.type = "globstar";
        prev.output = globstar(opts);
        prev.value += value;
        state.output += prev.output;
        state.globstar = true;
        consume(value);
        continue;
      }
      const token = { type: "star", value, output: star };
      if (opts.bash === true) {
        token.output = ".*?";
        if (prev.type === "bos" || prev.type === "slash") {
          token.output = nodot + token.output;
        }
        push(token);
        continue;
      }
      if (prev && (prev.type === "bracket" || prev.type === "paren") && opts.regex === true) {
        token.output = value;
        push(token);
        continue;
      }
      if (state.index === state.start || prev.type === "slash" || prev.type === "dot") {
        if (prev.type === "dot") {
          state.output += NO_DOT_SLASH;
          prev.output += NO_DOT_SLASH;
        } else if (opts.dot === true) {
          state.output += NO_DOTS_SLASH;
          prev.output += NO_DOTS_SLASH;
        } else {
          state.output += nodot;
          prev.output += nodot;
        }
        if (peek() !== "*") {
          state.output += ONE_CHAR;
          prev.output += ONE_CHAR;
        }
      }
      push(token);
    }
    while (state.brackets > 0) {
      if (opts.strictBrackets === true)
        throw new SyntaxError(syntaxError("closing", "]"));
      state.output = utils.escapeLast(state.output, "[");
      decrement("brackets");
    }
    while (state.parens > 0) {
      if (opts.strictBrackets === true)
        throw new SyntaxError(syntaxError("closing", ")"));
      state.output = utils.escapeLast(state.output, "(");
      decrement("parens");
    }
    while (state.braces > 0) {
      if (opts.strictBrackets === true)
        throw new SyntaxError(syntaxError("closing", "}"));
      state.output = utils.escapeLast(state.output, "{");
      decrement("braces");
    }
    if (opts.strictSlashes !== true && (prev.type === "star" || prev.type === "bracket")) {
      push({ type: "maybe_slash", value: "", output: `${SLASH_LITERAL}?` });
    }
    if (state.backtrack === true) {
      state.output = "";
      for (const token of state.tokens) {
        state.output += token.output != null ? token.output : token.value;
        if (token.suffix) {
          state.output += token.suffix;
        }
      }
    }
    return state;
  };
  parse2.fastpaths = (input, options) => {
    const opts = { ...options };
    const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
    const len = input.length;
    if (len > max) {
      throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
    }
    input = REPLACEMENTS[input] || input;
    const {
      DOT_LITERAL,
      SLASH_LITERAL,
      ONE_CHAR,
      DOTS_SLASH,
      NO_DOT,
      NO_DOTS,
      NO_DOTS_SLASH,
      STAR,
      START_ANCHOR
    } = constants.globChars(opts.windows);
    const nodot = opts.dot ? NO_DOTS : NO_DOT;
    const slashDot = opts.dot ? NO_DOTS_SLASH : NO_DOT;
    const capture = opts.capture ? "" : "?:";
    const state = { negated: false, prefix: "" };
    let star = opts.bash === true ? ".*?" : STAR;
    if (opts.capture) {
      star = `(${star})`;
    }
    const globstar = (opts2) => {
      if (opts2.noglobstar === true)
        return star;
      return `(${capture}(?:(?!${START_ANCHOR}${opts2.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
    };
    const create = (str) => {
      switch (str) {
        case "*":
          return `${nodot}${ONE_CHAR}${star}`;
        case ".*":
          return `${DOT_LITERAL}${ONE_CHAR}${star}`;
        case "*.*":
          return `${nodot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
        case "*/*":
          return `${nodot}${star}${SLASH_LITERAL}${ONE_CHAR}${slashDot}${star}`;
        case "**":
          return nodot + globstar(opts);
        case "**/*":
          return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${ONE_CHAR}${star}`;
        case "**/*.*":
          return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
        case "**/.*":
          return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${DOT_LITERAL}${ONE_CHAR}${star}`;
        default: {
          const match = /^(.*?)\.(\w+)$/.exec(str);
          if (!match)
            return;
          const source2 = create(match[1]);
          if (!source2)
            return;
          return source2 + DOT_LITERAL + match[2];
        }
      }
    };
    const output = utils.removePrefix(input, state);
    let source = create(output);
    if (source && opts.strictSlashes !== true) {
      source += `${SLASH_LITERAL}?`;
    }
    return source;
  };
  module.exports = parse2;
});
var require_picomatch = __commonJS((exports, module) => {
  var scan = require_scan();
  var parse2 = require_parse();
  var utils = require_utils();
  var constants = require_constants();
  var isObject2 = (val) => val && typeof val === "object" && !Array.isArray(val);
  var picomatch = (glob, options, returnState = false) => {
    if (Array.isArray(glob)) {
      const fns = glob.map((input) => picomatch(input, options, returnState));
      const arrayMatcher = (str) => {
        for (const isMatch of fns) {
          const state2 = isMatch(str);
          if (state2)
            return state2;
        }
        return false;
      };
      return arrayMatcher;
    }
    const isState = isObject2(glob) && glob.tokens && glob.input;
    if (glob === "" || typeof glob !== "string" && !isState) {
      throw new TypeError("Expected pattern to be a non-empty string");
    }
    const opts = options || {};
    const posix = opts.windows;
    const regex2 = isState ? picomatch.compileRe(glob, options) : picomatch.makeRe(glob, options, false, true);
    const state = regex2.state;
    delete regex2.state;
    let isIgnored = () => false;
    if (opts.ignore) {
      const ignoreOpts = { ...options, ignore: null, onMatch: null, onResult: null };
      isIgnored = picomatch(opts.ignore, ignoreOpts, returnState);
    }
    const matcher = (input, returnObject = false) => {
      const { isMatch, match, output } = picomatch.test(input, regex2, options, { glob, posix });
      const result = { glob, state, regex: regex2, posix, input, output, match, isMatch };
      if (typeof opts.onResult === "function") {
        opts.onResult(result);
      }
      if (isMatch === false) {
        result.isMatch = false;
        return returnObject ? result : false;
      }
      if (isIgnored(input)) {
        if (typeof opts.onIgnore === "function") {
          opts.onIgnore(result);
        }
        result.isMatch = false;
        return returnObject ? result : false;
      }
      if (typeof opts.onMatch === "function") {
        opts.onMatch(result);
      }
      return returnObject ? result : true;
    };
    if (returnState) {
      matcher.state = state;
    }
    return matcher;
  };
  picomatch.test = (input, regex2, options, { glob, posix } = {}) => {
    if (typeof input !== "string") {
      throw new TypeError("Expected input to be a string");
    }
    if (input === "") {
      return { isMatch: false, output: "" };
    }
    const opts = options || {};
    const format3 = opts.format || (posix ? utils.toPosixSlashes : null);
    let match = input === glob;
    let output = match && format3 ? format3(input) : input;
    if (match === false) {
      output = format3 ? format3(input) : input;
      match = output === glob;
    }
    if (match === false || opts.capture === true) {
      if (opts.matchBase === true || opts.basename === true) {
        match = picomatch.matchBase(input, regex2, options, posix);
      } else {
        match = regex2.exec(output);
      }
    }
    return { isMatch: Boolean(match), match, output };
  };
  picomatch.matchBase = (input, glob, options, posix = options && options.windows) => {
    const regex2 = glob instanceof RegExp ? glob : picomatch.makeRe(glob, options);
    return regex2.test(utils.basename(input, { windows: posix }));
  };
  picomatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
  picomatch.parse = (pattern, options) => {
    if (Array.isArray(pattern))
      return pattern.map((p) => picomatch.parse(p, options));
    return parse2(pattern, { ...options, fastpaths: false });
  };
  picomatch.scan = (input, options) => scan(input, options);
  picomatch.compileRe = (state, options, returnOutput = false, returnState = false) => {
    if (returnOutput === true) {
      return state.output;
    }
    const opts = options || {};
    const prepend = opts.contains ? "" : "^";
    const append = opts.contains ? "" : "$";
    let source = `${prepend}(?:${state.output})${append}`;
    if (state && state.negated === true) {
      source = `^(?!${source}).*$`;
    }
    const regex2 = picomatch.toRegex(source, options);
    if (returnState === true) {
      regex2.state = state;
    }
    return regex2;
  };
  picomatch.makeRe = (input, options = {}, returnOutput = false, returnState = false) => {
    if (!input || typeof input !== "string") {
      throw new TypeError("Expected a non-empty string");
    }
    let parsed = { negated: false, fastpaths: true };
    if (options.fastpaths !== false && (input[0] === "." || input[0] === "*")) {
      parsed.output = parse2.fastpaths(input, options);
    }
    if (!parsed.output) {
      parsed = parse2(input, options);
    }
    return picomatch.compileRe(parsed, options, returnOutput, returnState);
  };
  picomatch.toRegex = (source, options) => {
    try {
      const opts = options || {};
      return new RegExp(source, opts.flags || (opts.nocase ? "i" : ""));
    } catch (err) {
      if (options && options.debug === true)
        throw err;
      return /$^/;
    }
  };
  picomatch.constants = constants;
  module.exports = picomatch;
});
var require_quote = __commonJS((exports, module) => {
  var OPS = [
    "||",
    "&&",
    ";;&",
    ";;",
    ";&",
    "|&",
    "<(",
    ">(",
    "<<<",
    "<<-",
    "<<",
    ">>",
    ">&",
    ">|",
    "&>>",
    "&>",
    "<&",
    "<>",
    "&",
    ";",
    "(",
    ")",
    "|",
    "<",
    ">"
  ];
  var LINE_TERMINATORS = /[\n\r\u2028\u2029]/;
  var GLOB_SHELL_SPECIAL = /[\s#!"$&'():;<=>@\\^`|~]/g;
  module.exports = function quote(xs) {
    var sawComment = false;
    return xs.map(function(s) {
      if (sawComment && typeof s === "string" && LINE_TERMINATORS.test(s)) {
        throw new TypeError("a token after a `comment` must not contain line terminators");
      }
      if (s === "") {
        return "''";
      }
      if (s && typeof s === "object") {
        if ("op" in s && s.op === "glob") {
          if (typeof s.pattern !== "string") {
            throw new TypeError("glob token requires a string `pattern`");
          }
          if (LINE_TERMINATORS.test(s.pattern)) {
            throw new TypeError("glob `pattern` must not contain line terminators");
          }
          if (s.pattern === "") {
            return "''";
          }
          return s.pattern.replace(GLOB_SHELL_SPECIAL, "\\$&");
        }
        if ("op" in s && typeof s.op === "string") {
          if (OPS.indexOf(s.op) < 0) {
            throw new TypeError("invalid `op` value: " + JSON.stringify(s.op));
          }
          return s.op.replace(/[\s\S]/g, "\\$&");
        }
        if ("comment" in s && typeof s.comment === "string") {
          if (LINE_TERMINATORS.test(s.comment)) {
            throw new TypeError("`comment` must not contain line terminators");
          }
          sawComment = true;
          return "#" + s.comment;
        }
        throw new TypeError("unrecognized object token shape");
      }
      if (/'/.test(s) && /!/.test(s)) {
        return "'" + s.replace(/'/g, `'"'"'`) + "'";
      }
      if (/["\s\\]/.test(s) && !/'/.test(s)) {
        return "'" + s + "'";
      }
      if (/["'\s]/.test(s)) {
        return '"' + s.replace(/(["\\$`])/g, "\\$1") + '"';
      }
      return String(s).replace(/([A-Za-z]:)?([#!"$&'()*,:;<=>?@[\\\]^`{|}~])/g, "$1\\$2");
    }).join(" ");
  };
});
var require_parse2 = __commonJS((exports, module) => {
  var CONTROL = "(?:" + [
    "\\|\\|",
    "\\&(?:\\&|>>?)",
    ";;\\&?",
    "[;|]\\&",
    "\\<\\(",
    "\\<\\<\\<",
    "\\<\\<-",
    "\\<\\<(?!\\()",
    ">>",
    ">[&|(]",
    "<[&>]",
    "[&;()|<>]"
  ].join("|") + ")";
  var controlRE = new RegExp("^" + CONTROL + "$");
  var META = "|&;()<> \\t";
  var SINGLE_QUOTE = "'([^']*?)'";
  var ANSI_C_BODY = "(?:\\\\[\\s\\S]|[^\\\\'])*?";
  var ANSI_C_QUOTE = "\\$'" + ANSI_C_BODY + "'";
  var ansiCAt = new RegExp("\\$'" + ANSI_C_BODY + "(?:(')|\\\\?$)", "g");
  var ANSI_C_LETTERS = "abeEfnrtv";
  var ANSI_C_CHARS = `\x07\b\x1B\x1B\f
\r	\v`;
  var hash = /^#$/;
  var SQ = "'";
  var DQ = '"';
  var DS = "$";
  var TOKEN = "";
  var mult = 4294967296;
  for (i = 0;i < 4; i++) {
    TOKEN += (mult * Math.random()).toString(16);
  }
  var i;
  var startsWithToken = new RegExp("^" + TOKEN);
  function matchAll(s, r) {
    var origIndex = r.lastIndex;
    var matches = [];
    var matchObj;
    while (matchObj = r.exec(s)) {
      matches[matches.length] = matchObj;
      if (r.lastIndex === matchObj.index) {
        r.lastIndex += 1;
      }
    }
    r.lastIndex = origIndex;
    return matches;
  }
  function getVar(env, pre, key) {
    var r = typeof env === "function" ? env(key) : env[key];
    if (typeof r === "undefined" && key != "") {
      r = "";
    } else if (typeof r === "undefined") {
      r = "$";
    }
    if (typeof r === "object") {
      return pre + TOKEN + JSON.stringify(r) + TOKEN;
    }
    return pre + r;
  }
  var ansiCEscape = /\\([0-7]{1,3}|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|c(?:\\\\|[\s\S])|[abeEfnrtv\\'"?])/g;
  function expandAnsiCEscape(m, escape) {
    var kind = escape.charAt(0);
    if (kind === "c") {
      var ctrl = escape.charAt(1);
      return ctrl === "?" ? "\u007f" : String.fromCharCode(ctrl.charCodeAt(0) & 31);
    }
    if (kind === "x" || kind === "u" || kind === "U") {
      var cp = parseInt(escape.slice(1), 16);
      if (cp > 1114111) {
        return m;
      }
      return String.fromCharCode.apply(null, cp > 65535 ? [55232 + (cp >> 10), 56320 + (cp & 1023)] : [cp]);
    }
    if (kind >= "0" && kind <= "7") {
      return String.fromCharCode(parseInt(escape, 8) & 255);
    }
    var letter = ANSI_C_LETTERS.indexOf(escape);
    return letter < 0 ? escape : ANSI_C_CHARS.charAt(letter);
  }
  function expandAnsiC(body) {
    return body.replace(ansiCEscape, expandAnsiCEscape).split("\x00")[0];
  }
  function closesAnsiC(s, i2) {
    ansiCAt.lastIndex = i2;
    return !!ansiCAt.exec(s)[1];
  }
  function parseInternal(string, env, opts) {
    if (!opts) {
      opts = {};
    }
    var BS = opts.escape || "\\";
    var ifs = opts.splitUnquoted === true ? ` 	
` : typeof opts.splitUnquoted === "string" ? opts.splitUnquoted : "";
    var BAREWORD = "(\\" + BS + `['"$\\` + BS + META + "]|\\$\\$|\\$(?!" + ANSI_C_QUOTE.slice(2) + `)|[^\\s'"$` + META + "])+";
    var DOUBLE_QUOTE = '"(?:\\' + BS + '[\\s\\S]|[^"\\' + BS + '])*"';
    var chunker = new RegExp([
      "(" + CONTROL + ")",
      "(" + ANSI_C_QUOTE + "|" + BAREWORD + "|" + DOUBLE_QUOTE + "|" + SINGLE_QUOTE + ")+"
    ].join("|"), "g");
    var matches = matchAll(string, chunker);
    if (matches.length === 0) {
      return [];
    }
    if (!env) {
      env = {};
    }
    var commented = false;
    return matches.map(function(match) {
      var s = match[0];
      if (!s || commented) {
        return;
      }
      if (controlRE.test(s)) {
        return { op: s };
      }
      var quote = false;
      var esc = false;
      var out = "";
      var words = [];
      var sawQuote = false;
      var pendingNw = null;
      var isGlob = false;
      var i2;
      function parseEnvVar() {
        i2 += 1;
        var varend;
        var varname;
        var char = s.charAt(i2);
        if (char === "{") {
          i2 += 1;
          if (s.charAt(i2) === "}") {
            throw new Error("Bad substitution: " + s.slice(i2 - 2, i2 + 1));
          }
          var depth = 1;
          varend = i2;
          while (depth > 0 && varend < s.length) {
            if (s.charAt(varend) === "{" && s.charAt(varend - 1) === "$") {
              depth += 1;
            } else if (s.charAt(varend) === "}") {
              depth -= 1;
            }
            varend += 1;
          }
          if (depth !== 0) {
            throw new Error("Bad substitution: " + s.slice(i2));
          }
          varend -= 1;
          varname = s.slice(i2, varend);
          i2 = varend;
        } else if (/[*@#?$!-]/.test(char)) {
          varname = char;
        } else {
          var slicedFromI = s.slice(i2);
          varend = slicedFromI.match(/[^\w\d_]/);
          if (!varend) {
            varname = slicedFromI;
            i2 = s.length;
          } else {
            varname = slicedFromI.slice(0, varend.index);
            i2 += varend.index - 1;
          }
        }
        return getVar(env, "", varname);
      }
      function flushRun() {
        if (pendingNw === null) {
          return;
        }
        if (pendingNw === 0) {
          if (out !== "") {
            words[words.length] = out;
            out = "";
          }
        } else {
          words[words.length] = out;
          out = "";
          for (var fe = 1;fe < pendingNw; fe += 1) {
            words[words.length] = "";
          }
        }
        pendingNw = null;
      }
      for (i2 = 0;i2 < s.length; i2++) {
        var c = s.charAt(i2);
        if (ifs && c !== DS) {
          flushRun();
        }
        isGlob = isGlob || !quote && (c === "*" || c === "?");
        if (esc) {
          out += c;
          esc = false;
        } else if (quote) {
          if (c === quote) {
            quote = false;
          } else if (quote == SQ) {
            out += c;
          } else {
            if (c === BS) {
              i2 += 1;
              c = s.charAt(i2);
              if (c === DQ || c === BS || c === DS) {
                out += c;
              } else {
                out += BS + c;
              }
            } else if (c === DS) {
              out += parseEnvVar();
            } else {
              out += c;
            }
          }
        } else if (c === DQ || c === SQ) {
          quote = c;
          sawQuote = true;
        } else if (controlRE.test(c)) {
          return { op: s };
        } else if (hash.test(c)) {
          commented = true;
          var commentObj = { comment: string.slice(match.index + i2 + 1) };
          if (out.length) {
            return [out, commentObj];
          }
          return [commentObj];
        } else if (c === BS) {
          esc = true;
        } else if (c === DS && s.charAt(i2 + 1) === SQ && closesAnsiC(s, i2)) {
          flushRun();
          sawQuote = true;
          out += expandAnsiC(s.slice(i2 + 2, ansiCAt.lastIndex - 1));
          i2 = ansiCAt.lastIndex - 1;
        } else if (c === DS) {
          var value = parseEnvVar();
          if (!ifs) {
            out += value;
          } else {
            for (var vi = 0;vi < value.length; vi += 1) {
              var vc = value.charAt(vi);
              if (ifs.indexOf(vc) < 0) {
                flushRun();
                out += vc;
              } else if (pendingNw === null) {
                pendingNw = vc === " " || vc === "\t" || vc === `
` ? 0 : 1;
              } else if (vc !== " " && vc !== "\t" && vc !== `
`) {
                pendingNw += 1;
              }
            }
          }
        } else {
          out += c;
        }
      }
      if (isGlob) {
        return { op: "glob", pattern: out };
      }
      if (ifs) {
        if (pendingNw !== null && pendingNw > 0) {
          words[words.length] = out;
          out = "";
          for (var te = 1;te < pendingNw; te += 1) {
            words[words.length] = "";
          }
        }
        if (out !== "" || sawQuote && words.length === 0) {
          words[words.length] = out;
        }
        return words;
      }
      return out;
    }).reduce(function(prev, arg) {
      if (typeof arg === "undefined") {
        return prev;
      }
      [].concat(arg).forEach(function(entry) {
        prev[prev.length] = entry;
      });
      return prev;
    }, []);
  }
  module.exports = function parse(s, env, opts) {
    var mapped = parseInternal(s, env, opts);
    if (typeof env !== "function") {
      return mapped;
    }
    return mapped.reduce(function(acc, s2) {
      if (typeof s2 === "object") {
        acc[acc.length] = s2;
        return acc;
      }
      var xs = s2.split(RegExp("(" + TOKEN + ".*?" + TOKEN + ")", "g"));
      if (xs.length === 1) {
        acc[acc.length] = xs[0];
        return acc;
      }
      xs.filter(Boolean).forEach(function(x) {
        acc[acc.length] = startsWithToken.test(x) ? JSON.parse(x.split(TOKEN)[1]) : x;
      });
      return acc;
    }, []);
  };
});
var initialBaseURI = typeof self !== "undefined" && self.location && self.location.origin !== "null" ? new URL(self.location.origin + self.location.pathname + location.search) : new URL("https://github.com/cfworker");
var DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
var DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var TIME = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i;
var HOSTNAME = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i;
var URIREF = /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
var URITEMPLATE = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
var URL_ = /^(?:(?:https?|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?!10(?:\.\d{1,3}){3})(?!127(?:\.\d{1,3}){3})(?!169\.254(?:\.\d{1,3}){2})(?!192\.168(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)(?:\.(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
var UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
var JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
var JSON_POINTER_URI_FRAGMENT = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
var RELATIVE_JSON_POINTER = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
var EMAIL = (input) => {
  if (input[0] === '"')
    return false;
  const [name, host, ...rest] = input.split("@");
  if (!name || !host || rest.length !== 0 || name.length > 64 || host.length > 253)
    return false;
  if (name[0] === "." || name.endsWith(".") || name.includes(".."))
    return false;
  if (!/^[a-z0-9.-]+$/i.test(host) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(name))
    return false;
  return host.split(".").every((part) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
};
var IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
var IPV6 = /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i;
var DURATION = (input) => input.length > 1 && input.length < 80 && (/^P\d+([.,]\d+)?W$/.test(input) || /^P[\dYMDTHS]*(\d[.,]\d+)?[YMDHS]$/.test(input) && /^P([.,\d]+Y)?([.,\d]+M)?([.,\d]+D)?(T([.,\d]+H)?([.,\d]+M)?([.,\d]+S)?)?$/.test(input));
function bind2(r) {
  return r.test.bind(r);
}
var format = {
  date,
  time: time.bind(undefined, false),
  "date-time": date_time,
  duration: DURATION,
  uri,
  "uri-reference": bind2(URIREF),
  "uri-template": bind2(URITEMPLATE),
  url: bind2(URL_),
  email: EMAIL,
  hostname: bind2(HOSTNAME),
  ipv4: bind2(IPV4),
  ipv6: bind2(IPV6),
  regex,
  uuid: bind2(UUID),
  "json-pointer": bind2(JSON_POINTER),
  "json-pointer-uri-fragment": bind2(JSON_POINTER_URI_FRAGMENT),
  "relative-json-pointer": bind2(RELATIVE_JSON_POINTER)
};
function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function date(str) {
  const matches = str.match(DATE);
  if (!matches)
    return false;
  const year = +matches[1];
  const month = +matches[2];
  const day = +matches[3];
  return month >= 1 && month <= 12 && day >= 1 && day <= (month == 2 && isLeapYear(year) ? 29 : DAYS[month]);
}
function time(full, str) {
  const matches = str.match(TIME);
  if (!matches)
    return false;
  const hour = +matches[1];
  const minute = +matches[2];
  const second = +matches[3];
  const timeZone = !!matches[5];
  return (hour <= 23 && minute <= 59 && second <= 59 || hour == 23 && minute == 59 && second == 60) && (!full || timeZone);
}
var DATE_TIME_SEPARATOR = /t|\s/i;
function date_time(str) {
  const dateTime = str.split(DATE_TIME_SEPARATOR);
  return dateTime.length == 2 && date(dateTime[0]) && time(true, dateTime[1]);
}
var NOT_URI_FRAGMENT = /\/|:/;
var URI_PATTERN = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
function uri(str) {
  return NOT_URI_FRAGMENT.test(str) && URI_PATTERN.test(str);
}
var Z_ANCHOR = /[^\\]\\Z/;
function regex(str) {
  if (Z_ANCHOR.test(str))
    return false;
  try {
    new RegExp(str, "u");
    return true;
  } catch (e) {
    return false;
  }
}
var _DRIVE_LETTER_START_RE = /^[A-Za-z]:\//;
function normalizeWindowsPath(input = "") {
  if (!input) {
    return input;
  }
  return input.replace(/\\/g, "/").replace(_DRIVE_LETTER_START_RE, (r) => r.toUpperCase());
}
var _IS_ABSOLUTE_RE = /^[/\\](?![/\\])|^[/\\]{2}(?!\.)|^[A-Za-z]:[/\\]/;
function cwd() {
  if (false) {}
  return "/";
}
var resolve = function(...arguments_) {
  arguments_ = arguments_.map((argument) => normalizeWindowsPath(argument));
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (let index = arguments_.length - 1;index >= -1 && !resolvedAbsolute; index--) {
    const path = index >= 0 ? arguments_[index] : cwd();
    if (!path || path.length === 0) {
      continue;
    }
    resolvedPath = `${path}/${resolvedPath}`;
    resolvedAbsolute = isAbsolute(path);
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
  if (resolvedAbsolute && !isAbsolute(resolvedPath)) {
    return `/${resolvedPath}`;
  }
  return resolvedPath.length > 0 ? resolvedPath : ".";
};
function normalizeString(path, allowAboveRoot) {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let char = null;
  for (let index = 0;index <= path.length; ++index) {
    if (index < path.length) {
      char = path[index];
    } else if (char === "/") {
      break;
    } else {
      char = "/";
    }
    if (char === "/") {
      if (lastSlash === index - 1 || dots === 1)
        ;
      else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res[res.length - 1] !== "." || res[res.length - 2] !== ".") {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
            }
            lastSlash = index;
            dots = 0;
            continue;
          } else if (res.length > 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = index;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) {
          res += `/${path.slice(lastSlash + 1, index)}`;
        } else {
          res = path.slice(lastSlash + 1, index);
        }
        lastSegmentLength = index - lastSlash - 1;
      }
      lastSlash = index;
      dots = 0;
    } else if (char === "." && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}
var isAbsolute = function(p) {
  return _IS_ABSOLUTE_RE.test(p);
};
var basename = function(p, extension) {
  const segments = normalizeWindowsPath(p).split("/");
  let lastSegment = "";
  for (let i = segments.length - 1;i >= 0; i--) {
    const val = segments[i];
    if (val) {
      lastSegment = val;
      break;
    }
  }
  return extension && lastSegment.endsWith(extension) ? lastSegment.slice(0, -extension.length) : lastSegment;
};
var import_posix = __toESM(require_picomatch(), 1);
var $quote = require_quote();
var $parse = require_parse2();
var export_picomatch = import_posix.default;

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
  return sections.map(({ version, date: date2, lines }) => ({ version, ...date2 === undefined ? {} : { date: date2 }, text: lines.join(`
`).trim() }));
}
function changeLines(text) {
  let group;
  return text.split(`
`).flatMap((line) => {
    const trimmed = line.trim();
    const subheading = /^###\s+(.+)$/.exec(trimmed)?.[1];
    if (subheading !== undefined) {
      group = subheading;
      return [];
    }
    const item = /^[-*]\s+(.+)$/.exec(trimmed)?.[1] ?? trimmed;
    if (item === "")
      return [];
    return [group === undefined ? item : `${group}: ${item}`];
  });
}

// node_modules/@cmodjs/core/runtime/announce.js
var announcementMs = 1e4;
var shownChanges = 3;
function announcedOf(saved) {
  if (typeof saved === "string")
    return { version: saved, added: [] };
  if (!isObject(saved) || typeof saved["version"] !== "string")
    return;
  return { version: saved["version"], added: Array.isArray(saved["added"]) ? saved["added"].map(String) : [] };
}
async function announcementOf(claude, plugin, granted, added, previous) {
  const read = (path) => claude.fs.read(`${plugin.root}/${path}`).catch(ifMissing(undefined));
  const manifest = jsonOf(await read(".claude-plugin/plugin.json"));
  const field = (key) => isObject(manifest) && typeof manifest[key] === "string" ? manifest[key] : undefined;
  const open = (page) => () => claude.cmod.call({ to: cmodPluginName, method: "openSettings", input: { mod: plugin.name, ...page === undefined ? {} : { page } } });
  if (previous === undefined) {
    const { program, keys } = plugin.steps;
    const rules = (await claude.fs.list(`${plugin.root}/rules`).catch(ifMissing([]))).filter((entry) => entry.kind === "file" && entry.name.endsWith(".md")).map((entry) => entry.name.slice(0, -".md".length)).toSorted();
    const lines2 = [
      field("description"),
      added.length > 0 ? `Adds ${listed(added)}.` : undefined,
      rules.length > 0 ? `Adds ${rules.length} ${rules.length === 1 ? "rule" : "rules"}: ${listed(rules)}.` : undefined,
      program === undefined ? undefined : `Installed the ${program} program.`,
      ...Object.entries(keys ?? {}).map(([key, command]) => `Binds ${key} to /${command}.`),
      ...[...granted].map((item) => `${permissionWords(item)}.`)
    ];
    return { message: "Installed", ...described(lines2), action: { label: "Settings", onClick: open() } };
  }
  const version = plugin.version ?? "";
  const isCheckout = marketplaceOf(plugin.root, plugin.name) === undefined;
  const sections = changelogSections(await read("CHANGELOG.md") ?? "");
  const section = sections.find((each) => each.version === version) ?? (isCheckout ? sections.find((each) => each.version === unreleased) : undefined);
  const changes = section === undefined ? [] : changeLines(section.text);
  const nowAdded = added.filter((each) => !previous.added.includes(each));
  const gone = previous.added.filter((each) => !added.includes(each));
  const fallback = previous.added.length === 0 ? [] : [nowAdded.length > 0 ? `Now adds ${listed(nowAdded)}.` : undefined, gone.length > 0 ? `No longer adds ${listed(gone)}.` : undefined];
  const home = await claude.env.home();
  const folder = home !== undefined && plugin.root.startsWith(`${home}/`) ? `~${plugin.root.slice(home.length)}` : plugin.root;
  const repository = field("repository");
  const lines = [
    ...changes.length === 0 ? fallback : changes.length > shownChanges ? [...changes.slice(0, shownChanges), "…"] : changes,
    `From ${previous.version}${isCheckout ? `, loaded from ${folder}` : ""}.`,
    repository === undefined || isCheckout ? undefined : `Release notes: ${repository.replace(/\/$/, "")}/releases/tag/v${version}`
  ];
  return {
    message: `Updated to ${version}`,
    ...described(lines),
    ...sections.length > 0 ? { action: { label: "Changelog", onClick: open(changelogPage) } } : {}
  };
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
function described(lines) {
  const kept = lines.filter((line) => line !== undefined);
  return kept.length === 0 ? {} : { description: kept.join(`
`) };
}

// node_modules/@cmodjs/core/session/context/turn/message/message.js
var Message = "message";
var skillPrefix = "Base directory for this skill:";
var memoryPath = /^Contents of (.+?)(?: \([^)\n]*\))?:\r?$/m;
function instructionPathOf(text) {
  return memoryPath.exec(text)?.[1] ?? "";
}
function rowOfAppend(append, at, cwd2) {
  const { message, origin } = append;
  const text = textOf(message.content);
  const path = message.type === "attachment" ? instructionPathOf(text) || undefined : undefined;
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
    cwd: cwd2,
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
  if (row.type === "system")
    return row.name === "turn_duration" || row.name === "compact_boundary" || text === "" ? [] : [{ ...base, type: Notice, text }];
  if (row.type === "attachment")
    return row.name === "nested_memory" ? [{ ...base, type: InstructionFile, path: row.path ?? "", text, isRule: isRulePath(row.path ?? "") }] : [];
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
    return [{ ...base, type: Skill, name: basename2(text.slice(skillPrefix.length).split(`
`)[0]?.trim() ?? ""), text }];
  if (text.startsWith("<task-notification"))
    return [{ ...base, type: Note, text: tagOf(text, "summary") ?? text, from: { type: Task } }];
  if (row.isMeta)
    return [{ ...base, type: Note, text, from: senderOf(row.origin, isInTask) }];
  const prompt = promptText(text);
  return prompt === undefined ? [] : [{ ...base, type: Prompt, text: prompt, from: senderOf(row.origin, isInTask) }];
}
function withTexts(row, texts) {
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
      const text2 = texts.get(index);
      return isText && text2 !== undefined ? { ...block, text: text2 } : block;
    });
  }
  if (row.type === "user" && row.content.some(isToolResultBlock)) {
    let index = -1;
    return row.content.map((block) => {
      if (!isToolResultBlock(block))
        return block;
      index += 1;
      const text2 = texts.get(index);
      if (text2 === undefined)
        return block;
      return { ...block, content: Array.isArray(block["content"]) ? keepingMedia(block["content"], text2) : text2 };
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
function basename2(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

// node_modules/@cmodjs/core/session/context/context.js
var ContextStart = "contextStart";
var ContextEnd = "contextEnd";

// node_modules/@cmodjs/core/session/context/turn/turn.js
var TurnStart = "turnStart";
var TurnEnd = "turnEnd";

// node_modules/@cmodjs/core/session/goal/goal.js
var GoalChange = "goalChange";

// node_modules/@cmodjs/core/session/conversation.js
var searchLimit = 50;
var agentTools = ["Agent", "Task"];
var asyncLaunch = "Async agent launched";
function emptyConversation(session) {
  return { session, context: 0, contextOpenedAt: "", agentCalls: [], endedCalls: {}, tasks: {}, taskTurns: {} };
}
function createConversation(start) {
  let { context, contextOpenedAt, turn, goal } = start;
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
    return open.closedAt === undefined ? [{ type: TurnEnd, turn: { ...open, ...ending, closedAt: at } }] : [];
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
    return [{ type: TurnEnd, turn: ended }];
  };
  const endTask = (call, at, only) => {
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
        if (unplaced.type === Prompt) {
          changes.push(...task === undefined ? endTurn(row.at) : endTaskTurn(task, row.at));
          const opened = { prompt: { ...unplaced, session: start.session, context: placedIn, turn: unplaced.id, ...task === undefined ? {} : { task } }, context: placedIn, openedAt: row.at, ...owner?.closedAt === undefined ? {} : { closedAt: owner.closedAt } };
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
          changes.push(...endTask(placed.callId, row.at));
        if (placed.type === Note && placed.from.type === Task) {
          const call2 = tagOf(textOf(row.content), "tool-use-id");
          if (call2 !== undefined && agentCalls.has(call2))
            changes.push(...endTask(call2, row.at, tagOf(textOf(row.content), "task-id")));
        }
      }
      return changes;
    },
    startTask(data) {
      if (tasks.has(data.id))
        return [];
      const started = { ...data, context };
      tasks.set(data.id, started);
      agentCalls.add(data.openedBy);
      const changes = [{ type: TaskStart, task: started }];
      const endedAt = endedCalls.get(data.openedBy);
      if (endedAt !== undefined)
        changes.push(...endTask(data.openedBy, endedAt, data.id));
      return changes;
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
var relayTag = /^(?:<cross-session-message[^>]*>\s*)?<cmod-relay>([\s\S]*)<\/cmod-relay>(?:\s*<\/cross-session-message>[\s\S]*)?$/;
function relayOf(e) {
  const isFromCmod = e.origin.kind === "peer" && !("teammate" in e.origin) && e.origin.plugin === cmodPluginName;
  return isFromCmod ? relayTag.exec(e.text)?.[1] : undefined;
}
function installBefore({ claude, router, hooks }) {
  const { place, wants, decide } = hooks;
  const now = () => new Date().toISOString();
  const asked = async (event, change) => await decide(event, change) ?? {};
  const message = (where, unplaced, task, isInTurn = true) => {
    const turn = isInTurn ? task === undefined ? where.turn : where.taskTurns[task] : undefined;
    const context = task === undefined ? where.context : where.tasks[task]?.context ?? where.context;
    const call = unplaced.type === ToolResult ? where.openCalls?.[unplaced.callId] : undefined;
    return { type: Message, message: { ...unplaced, ...call, session: where.session, context, ...turn === undefined ? {} : { turn: turn.prompt.id }, ...task === undefined ? {} : { task } } };
  };
  const titles = new Map;
  const spawned = new Map;
  const agentFolders = new Map;
  const toolResultHook = (isFailure) => async (e, next) => {
    if (!await wants(ToolResult))
      return next(e);
    const where = await place();
    const name = String(e["tool_name"]);
    const callId = String(e["tool_use_id"]);
    const input = typeof e["tool_input"] === "object" && e["tool_input"] !== null ? e["tool_input"] : {};
    const task = typeof e["agent_id"] === "string" ? e["agent_id"] : undefined;
    const result = { id: callId, at: now(), type: ToolResult, callId, name, input, cwd: String(e["cwd"]), files: noFiles, output: isFailure ? e["error"] : e["tool_response"], isError: isFailure };
    const answer = await asked(ToolResult, message(where, result, task));
    const below = await next(e);
    const rewritten = answer.output === undefined || isFailure ? {} : name.startsWith("mcp__") ? { updatedMCPToolOutput: answer.output } : { updatedToolOutput: answer.output };
    const failed = answer.isError === true && !isFailure ? { block: answer.note ?? `${name} failed.` } : {};
    return { ...withNote(below, answer.isError === true ? undefined : answer.note), ...rewritten, ...failed };
  };
  const added = [
    router.add("prompt.submit", async (e, next) => {
      if (!await wants(Prompt))
        return next(e);
      const where = await place();
      const answer = await asked(Prompt, message(where, { id: "", at: now(), type: Prompt, text: e.text, from: senderOf(e.origin, false) }, undefined, false));
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
      const where = await place();
      const answer = await asked(Prompt, message(where, { id: "", at: now(), type: Prompt, text: e.text, from: { type: "session" } }, e.agentId, false));
      if (answer.refuse !== undefined)
        return { consumed: answer.refuse };
      return next(answer.text === undefined ? e : { ...e, text: answer.text });
    }),
    router.add("skill.prompt", async (e, next) => {
      if (!await wants(Skill))
        return next(e);
      const where = await place();
      const answer = await asked(Skill, message(where, { id: "", at: now(), type: Skill, name: e.skill, text: e.text }, undefined));
      return answer.text === undefined ? next(e) : { text: answer.text };
    }),
    router.add("prompt.attachment", async (e, next) => {
      if (!await wants(InstructionFile) || e.type !== "nested_memory")
        return next(e);
      const where = await place();
      const path = instructionPathOf(e.text);
      const answer = await asked(InstructionFile, message(where, { id: "", at: now(), type: InstructionFile, path, text: e.text, isRule: isRulePath(path) }, e.agentId));
      if (answer.refuse !== undefined)
        return { text: null };
      return answer.text === undefined ? next(e) : { text: answer.text };
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
      for (const [part, unplaced] of found.entries()) {
        if (!wanted.has(unplaced.type))
          continue;
        const answer = await asked(unplaced.type, message(where, unplaced, e.agentId));
        if (answer.text !== undefined)
          texts.set(part, answer.text);
      }
      return next(texts.size === 0 ? e : { ...e, message: { ...e.message, content: withTexts(row, texts) } });
    }),
    router.add("tool.call", async (e, next) => {
      if (!await wants(ToolCall))
        return next(e);
      const where = await place();
      const input = toolInputOf(e);
      const cwd2 = (e.agentId === undefined ? undefined : agentFolders.get(e.agentId)) ?? await claude.session.cwd();
      const answer = await asked(ToolCall, message(where, { id: e.tool_use_id, at: now(), type: ToolCall, callId: e.tool_use_id, name: e.tool, input, cwd: cwd2, files: noFiles }, e.agentId));
      if (answer.refuse !== undefined)
        return { deny: answer.refuse };
      if (answer.result !== undefined)
        return { result: answer.result };
      if (answer.input === undefined)
        return next(e);
      const reserved = Object.fromEntries(Object.entries(e).filter(([key]) => !(key in input)));
      return next({ ...reserved, ...answer.input });
    }),
    router.add("agent.spawn", async (e, next) => {
      spawned.set(e.tool_use_id, e.prompt);
      const start = async (args) => {
        const started = await next(args);
        const folder = args.isTeammate === true ? undefined : args.cwd ?? (args.parentAgentId === undefined ? undefined : agentFolders.get(args.parentAgentId));
        if (started.agentId !== undefined && folder !== undefined)
          agentFolders.set(started.agentId, resolve(await claude.session.cwd(), folder));
        return started;
      };
      if (!await wants(TaskStart))
        return start(e);
      const where = await place();
      const task = { id: "", title: e.description, agentType: e.subagentType, model: e.model ?? e.parentModel, openedBy: e.tool_use_id, openedAt: now(), ...e.parentAgentId === undefined ? {} : { parent: e.parentAgentId } };
      const answer = await asked(TaskStart, { type: TaskStart, task: { ...task, context: where.context } });
      if (answer.refuse !== undefined) {
        spawned.delete(e.tool_use_id);
        return { deny: answer.refuse };
      }
      return start(answer.owner === undefined ? e : { ...e, model: answer.owner.model });
    }),
    router.add("classic.SubagentStart", async (e, next) => {
      const where = await place();
      const openedBy = where.tasks[e.agent_id]?.openedBy;
      const prompt = openedBy === undefined ? undefined : spawned.get(openedBy);
      if (openedBy !== undefined)
        spawned.delete(openedBy);
      if (!await wants(Prompt))
        return next(e);
      const open = where.taskTurns[e.agent_id]?.prompt;
      const text = open?.text ?? prompt;
      if (text === undefined)
        return next(e);
      const answer = await asked(Prompt, message(where, { id: open?.id ?? "", at: now(), type: Prompt, text, from: open?.from ?? { type: Task } }, e.agent_id, false));
      return withNote(await next(e), answer.note);
    }),
    router.add("classic.SubagentStop", async (e, next) => {
      const stopped = (answer2) => {
        if (answer2.block === undefined)
          agentFolders.delete(e.agent_id);
        return answer2;
      };
      if (!await wants(TurnEnd))
        return stopped(await next(e));
      const turn = (await place()).taskTurns[e.agent_id];
      if (turn === undefined)
        return stopped(await next(e));
      const answer = await asked(TurnEnd, { type: TurnEnd, turn: { ...turn, closedAt: now() } });
      const below = await next(e);
      return stopped(answer.refuse === undefined ? below : { ...below, block: answer.refuse });
    }),
    router.add("classic.Stop", async (e, next) => {
      if (!await wants(TurnEnd))
        return next(e);
      const where = await place();
      if (where.turn === undefined)
        return next(e);
      const answer = await asked(TurnEnd, { type: TurnEnd, turn: { ...where.turn, closedAt: now() } });
      const below = await next(e);
      return answer.refuse === undefined ? below : { ...below, block: answer.refuse };
    }),
    router.add("session.compact", async (e, next) => {
      if (!await wants(ContextEnd) || e.trigger === "precompute")
        return next(e);
      const where = await place();
      const task = e.agentId === undefined ? undefined : where.tasks[e.agentId];
      if (e.agentId !== undefined && task === undefined)
        return next(e);
      const context = task === undefined ? { number: where.context, openedAt: where.contextOpenedAt } : { number: task.context, openedAt: task.contextOpenedAt ?? task.openedAt, task: task.id };
      const answer = await asked(ContextEnd, { type: ContextEnd, context: { ...context, closedAt: now() } });
      return answer.refuse === undefined ? next(e) : { skip: answer.refuse };
    })
  ];
  return { dispose: () => added.forEach((each) => each.dispose()) };
}
function withAnswer(change, answer) {
  if (change.type === Message && answer.output !== undefined && change.message.type === ToolResult)
    return { ...change, message: { ...change.message, output: answer.output } };
  if (change.type === Message && answer.text !== undefined)
    return { ...change, message: { ...change.message, text: answer.text } };
  if (change.type === Message && answer.input !== undefined && change.message.type === ToolCall)
    return { ...change, message: { ...change.message, input: answer.input } };
  if (change.type === TaskStart && answer.owner !== undefined)
    return { ...change, task: { ...change.task, model: answer.owner.model } };
  return change;
}
var methodOf = (prefix, event) => `${prefix}${Object.entries(sessionEvents).find(([, each]) => each === event)?.[0] ?? event}`;
var beforeAnswerKeys = {
  prompt: ["text", "note", "title", "refuse"],
  note: ["text"],
  skill: ["text"],
  instructionFile: ["text", "refuse"],
  reply: ["text"],
  toolCall: ["input", "result", "refuse"],
  toolResult: ["output", "isError", "note"],
  notice: ["text"],
  taskStart: ["owner", "refuse"],
  turnEnd: ["refuse"],
  contextEnd: ["refuse"]
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
async function runCmod(claude, args, session) {
  const lines = [];
  const { code, lastError } = await readLines(claude.process.spawn({ argv: ["cmod", ...args], env: { CLAUDE_CODE_SESSION_ID: session } }), (line) => void lines.push(line));
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
    return folder !== undefined && name !== undefined && names.has(name) ? [`${folder}/${name}`, ...rest] : argv;
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
    walk($parse(text, (name) => name === "" ? undefined : `$${name}`), markers, folder, result);
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
    isDynamic: /[$\u0001]/.test(basename(raw))
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
  const program = basename(first.text);
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
    addPath(result, "writes", { ...only, text: basename(only.text) }, folder);
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
      addPathText(result, "writes", `${destination.text.replace(/\/+$/, "")}/${basename(source.text)}`, folder);
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
  const { fs: fs2 } = workspace;
  const absolute = (path, folder = workspace.cwd) => resolve(folder, expandHome(path, workspace.home, workspace.configRoot));
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
    effects.writes = [{ path, contents: once(() => editedContents(use, path, fs2)) }];
  } else if (use.tool === "Write") {
    const path = absolute(textField(use, "file_path"));
    const content = textField(use, "content");
    effects.writes = [{ path, contents: once(async () => contentsOf(content, await previousContentOf(path, fs2))) }];
  } else if (use.tool === "NotebookEdit") {
    const path = absolute(textField(use, "notebook_path"));
    effects.writes = [{ path, contents: once(async () => contentsOf(undefined, await previousContentOf(path, fs2))) }];
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
async function editedContents(use, path, fs2) {
  const previousContent = await previousContentOf(path, fs2);
  const oldString = textField(use, "old_string");
  const newString = textField(use, "new_string");
  if (oldString === "")
    return contentsOf(previousContent === undefined || previousContent === "" ? newString : undefined, previousContent);
  if (previousContent === undefined || !previousContent.includes(oldString))
    return contentsOf(undefined, previousContent);
  const content = fieldOf(use, "replace_all") === true ? previousContent.split(oldString).join(newString) : previousContent.replace(oldString, () => newString);
  return contentsOf(content, previousContent);
}
async function previousContentOf(path, fs2) {
  const stat = await fs2.stat(path).catch(ifMissing(undefined));
  return stat?.kind === "file" ? fs2.read(path) : undefined;
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
var permissionEvents = ["tool.check", "classic.PermissionRequest"];
function classicHook(event, hook, report) {
  const routed = async (e, next) => {
    const ours = await Promise.resolve().then(() => hook(e)).catch((error) => {
      report({ id: `hook:${event}`, message: `The ${event} listener failed`, error });
      return;
    });
    if (ours === undefined)
      return next(e);
    return mergeClassic(await next(e), ours);
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
async function callFiles(name, claude, folders, use, cwd2) {
  try {
    const { home, configRoot } = await folders;
    if (home === undefined)
      throw new Error("HOME is not set, so ~ in a path has no meaning.");
    const { shell, reads, writes } = callEffects(use, { cwd: cwd2, home, ...configRoot === undefined ? {} : { configRoot }, fs: claude.fs });
    const known = (accesses) => accesses.map(({ path }) => path).filter((path) => shell === undefined || !dynamicPattern.test(path));
    const unchecked = (path) => (error) => {
      if (!isMissing(error))
        claude.ui.log(`${name}: the ${use.tool} call reads ${path}, which could not be checked: ${messageOf(error)}`, { to: "debug" });
      return;
    };
    const read = await Promise.all(known(reads).map(async (path) => (await claude.fs.stat(path).catch(unchecked(path)))?.kind === "file" ? [path] : []));
    return { read: read.flat(), changed: known(writes) };
  } catch (error) {
    claude.ui.log(`${name}: the ${use.tool} call lists no files: ${messageOf(error)}`, { to: "debug" });
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
  usage: "cmod:usage",
  subscribe: "cmod:subscribe",
  watchBefore: "cmod:watchBefore",
  act: "cmod:act",
  changed: "cmod:changed",
  before: "cmod:before"
};
var actPermissions = { send: "prompt", startTask: "tasks", usage: "conversation", surfaces: "conversation", abort: "prompt" };
var startsTurns = ["CronCreate"];
var ownSchedule = ["CronDelete", "CronList"];
var beforePermission = (event) => event === "toolCall" ? "tools" : event === TaskStart ? "tasks" : "prompt";
var isAct = (action) => action === "callTool" || (action in actPermissions);
function toolPermission(tool) {
  return startsTurns.includes(tool) ? "prompt" : ownSchedule.includes(tool) ? undefined : "tools";
}
function actPermission(action, input) {
  return action === "callTool" ? toolPermission(String(input?.name)) ?? "tools" : actPermissions[action];
}
async function usageOf(claude) {
  const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()]);
  const { tokens, window, percent } = usage.context;
  return { model, contextWindow: { ...tokens === undefined ? {} : { tokenCount: tokens }, size: window, ...percent === undefined ? {} : { percent } }, ...usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } } };
}
function payloadOf(change) {
  if (change.type === Message)
    return change.message;
  if ("turn" in change)
    return change.turn;
  if ("context" in change)
    return change.context;
  if ("task" in change) {
    const { id, title, agentType, model, openedBy, openedAt, closedAt } = change.task;
    return { id, title, openedBy, openedAt, ...closedAt === undefined ? {} : { closedAt }, owner: { id, title, agentType, ...model === undefined ? {} : { model }, startedAt: openedAt } };
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
  if (change.type === TurnStart || change.type === TurnEnd)
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
  if (change.type === TurnStart || change.type === TurnEnd)
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
  return (change.type === TurnStart || change.type === TurnEnd) && change.turn.prompt.id === scope.turn;
}
function createSessionsClient({ name, claude, report, isGranted, hookOn, routeOn, permissionRoutes }) {
  const call = (method, input) => claude.cmod.call({ to: cmodPluginName, method, input });
  const listening = new Map;
  const deciding = new Map;
  const queued = new Set;
  const parents = new Map;
  const known = new Map;
  let current2 = { id: "", title: "", project: "", cwd: "", model: "", startedAt: "", lastAt: "", isRunning: true };
  const keyOf = (scope) => scope.session ?? everySession;
  const subscribe = (key) => {
    if (queued.has(key))
      return;
    queued.add(key);
    Promise.resolve().then(async () => {
      queued.delete(key);
      const heard = (from) => [...from.get(key) ?? []].map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : sentMatcher(matcher) }));
      const tracksTasks = [...listening.get(key) ?? [], ...deciding.get(key) ?? []].some(({ scope }) => scope.task !== undefined || scope.isGoal === true);
      const subscriptions = [...heard(listening), ...tracksTasks ? [{ event: TaskStart }] : []];
      await call(conversationMethods.subscribe, { session: key, subscriptions }).catch((error) => report(`sessions:${key}`, `Hears nothing from ${key === everySession ? "the other sessions" : `session ${key}`}`, error));
      await call(conversationMethods.watchBefore, { session: key, subscriptions: heard(deciding) }).catch((error) => report(`before:${key}`, `Changes nothing in ${key === everySession ? "the other sessions" : `session ${key}`}`, error));
    });
  };
  const learnTasks = async (session) => {
    if (parents.has(session))
      return;
    const tree = new Map;
    parents.set(session, tree);
    for (const task of await call(conversationMethods.tasks, { session, all: true }))
      tree.set(task.id, task.parent);
  };
  const isUnderIn = (session) => (task, ancestor) => {
    const tree = parents.get(session);
    for (let at = task, steps = 0;at !== undefined && steps < 64; at = tree?.get(at), steps += 1)
      if (at === ancestor)
        return true;
    return false;
  };
  const remember = (session, change) => {
    if (change.type === TaskStart)
      parents.get(session)?.set(change.task.id, change.task.parent);
  };
  const add = (into, scope, event, method, args, onChange) => {
    const key = keyOf(scope);
    const entry = { scope, event, method, ...listenerOf(name, method, args) };
    const set = into.get(key) ?? new Set;
    set.add(entry);
    into.set(key, set);
    if (scope.task !== undefined || scope.isGoal === true)
      learnTasks(scope.session ?? current2.id).catch((error) => report(`tasks:${key}`, "Could not read the tasks it listens under", error));
    onChange(key);
    return {
      dispose() {
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
  const invoke = (method, options, run, takes = []) => withinTime(claude.clock, method, options, run).catch((error) => {
    if (error instanceof PassedTimeout && !method.startsWith("before"))
      return;
    report(`session:${method}`, `The ${method} listener failed`, error);
    return options.onFailure === "refuse" && takes.includes("refuse") ? { refuse: `${name}: ${messageOf(error)}` } : undefined;
  });
  const combined = async (session, event, change, isInProject) => {
    const askers = [...deciding.get(session) ?? [], ...isInProject ? deciding.get(everySession) ?? [] : []].filter((entry) => entry.event === event).map((entry) => async (latest) => {
      if (!isInScope(entry.scope, session, latest, isUnderIn(session)))
        return;
      if (entry.matcher !== undefined && !matches(payloadOf(latest), entry.matcher))
        return;
      const payload = await payloadFor(session, latest);
      const answer = await invoke(entry.method, entry.options, async (time2) => takenAnswer(entry.method, beforeAnswerKeys[event], await entry.listener(payload, time2)), beforeAnswerKeys[event]);
      if (answer === undefined || answer === null || typeof answer === "object" && "refuse" in answer || isGranted(beforePermission(event)))
        return answer;
      throw new Error(`Its ${entry.method} answer changes nothing until ${beforePermission(event)} is turned on for ${name} in /mods.`);
    });
    return foldBefore(event, change, askers, (error) => report(`session:${methodOf("before", event)}`, `The ${methodOf("before", event)} listener failed`, error));
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
        const session = scope.session ?? current2.id;
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
  const taskOf = (session, data) => ({
    id: data.id,
    title: data.title,
    openedBy: data.openedBy,
    openedAt: data.openedAt,
    ...data.closedAt === undefined ? {} : { closedAt: data.closedAt },
    owner: ownerOf(session, data),
    ...recordPart({ session, task: data.id }),
    tasks: async () => (await call(conversationMethods.tasks, { session, task: data.id })).map((task) => taskOf(session, task)),
    messages: () => messagesFrom(conversationMethods.messages, { session, task: data.id })
  });
  const goalOf = (where) => ({
    search: (text, matcher) => searched({ text, ...where() }, matcher),
    ...eventMethods(() => ({ ...where(), isGoal: true }), true),
    text: async () => (await call(conversationMethods.goal, where())).text,
    tasks: async () => {
      const { session = current2.id, task } = where();
      return (await call(conversationMethods.tasks, { session, ...task === undefined ? {} : { task } })).map((each) => taskOf(session, each));
    },
    update: async ({ text }) => {
      if (text.trim() === "")
        throw new Error(`${name}: a goal needs text.`);
      const { session = current2.id, task } = where();
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
      const added = await claude.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
      if (added.deny !== undefined)
        throw new Error(`${name}: Claude Code refused the note: ${added.deny}`);
      return;
    }
    const submitted = await claude.prompt.submit({ text, ...as === Person ? { asUser: true } : {} });
    if ("drop" in submitted && typeof submitted.drop === "string")
      throw new Error(`${name}: Claude Code dropped the prompt: ${submitted.drop}`);
  };
  const startHere = async (task) => taskOf(current2.id, await spawnTask(claude, task).catch((error) => Promise.reject(new Error(`${name}: ${messageOf(error)}`))));
  const surfacesHere = async () => [...await claude.session.surfaces()];
  const sessionOf = (read, owned) => {
    const id = () => read().id;
    const isHere = () => owned === undefined && id() === current2.id;
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
    if (owned !== undefined)
      return session;
    return Object.assign(session, {
      async startTask(task) {
        if (isHere())
          return startHere(task);
        const started = await act(id(), "startTask", task);
        return taskOf(id(), started);
      },
      callTool: async (toolCall) => await withFiles(await act(id(), "callTool", toolCall))
    });
  };
  const ownerOf = (session, data) => {
    const parent = session === current2.id ? current2 : known.get(session);
    return sessionOf(() => ({
      id: data.id,
      title: data.title,
      project: parent?.project ?? "",
      agentType: data.agentType,
      model: data.model ?? "",
      cwd: parent?.cwd ?? "",
      isRunning: data.closedAt === undefined && (parent?.isRunning ?? true),
      startedAt: data.openedAt,
      lastAt: data.closedAt ?? data.openedAt
    }), { session, task: data.id });
  };
  const processListeners = new Map;
  const raise = async (method, payload) => {
    const heard = [...processListeners.get(method) ?? []].filter(({ matcher }) => payload["task"] === undefined && (matcher === undefined || matches(payload, matcher)));
    if (!method.startsWith("before")) {
      await Promise.all(heard.map(({ listener, options }) => invoke(method, options, (time2) => listener(payload, time2))));
      return;
    }
    const failing = method === "beforePermissionRequest" ? { onFailure: "refuse" } : {};
    const takes = answerKeys[method.slice("before".length)] ?? [];
    const askers = heard.map(({ listener, options }) => () => invoke(method, { ...options, ...failing }, async (time2) => takenAnswer(method, takes, await listener(payload, time2)), takes));
    return foldAnswers(method, takes, ["refuse"], undefined, askers, (error) => report(`session:${method}`, `The ${method} listener failed`, error));
  };
  const commandRun = async (e) => {
    const source = (await claude.command.list()).find((command) => command.name === e.command)?.source;
    return { session: current2.id, cwd: current2.cwd, name: e.command, args: e.args, ...defined({ source }), from: senderOf(e.origin, false) };
  };
  const commandListeners = { beforeRun: new Set, onRun: new Set };
  for (const [method, held] of Object.entries(commandListeners))
    processListeners.set(method, held);
  routeOn?.("command.run", async (e, next) => {
    if (commandListeners.beforeRun.size === 0 && commandListeners.onRun.size === 0)
      return next(e);
    const run = await commandRun(e);
    const answer = commandListeners.beforeRun.size === 0 ? undefined : await raise("beforeRun", run);
    if (typeof answer?.["refuse"] === "string")
      return { text: answer["refuse"] };
    const changes = answer !== undefined && isGranted("prompt") ? answer : undefined;
    if (answer !== undefined && changes === undefined)
      report("session:beforeRun", "The beforeRun listener failed", new Error(`${name}: its answer changes a command, which needs the prompt permission.`));
    if (typeof changes?.["result"] === "string")
      return { text: changes["result"], ...typeof changes["exitCode"] === "number" ? { exitCode: changes["exitCode"] } : {} };
    const args = typeof changes?.["args"] === "string" ? changes["args"] : e.args;
    const ran = await next(args === e.args ? e : { ...e, args });
    raise("onRun", { ...run, args });
    return typeof changes?.["note"] === "string" ? { ...ran, context: [...ran.context ?? [], changes["note"]] } : ran;
  });
  const listenTo = (method, named) => {
    if (hookOn === undefined || routeOn === undefined)
      throw new Error(`${name}: ${method} works only in a mod's own session.`);
    const isBefore = method.startsWith("before");
    if (named === "PermissionCheck" || named === "PermissionRequest") {
      const routes = permissionRoutes?.();
      if (routes !== undefined)
        return routes(method, { raise, hookOn, routeOn, current: () => current2 });
      return named === "PermissionCheck" ? routeOn("tool.check", (e, next) => next(e)) : hookOn("PermissionRequest", () => {
        return;
      });
    }
    const event = processEvents[named];
    const hook = (isBefore ? event.before : undefined) ?? event.on;
    return hookOn(hook, async (input) => {
      const payload = processPayloadOf(named, input);
      if (!isBefore) {
        if (named !== "SessionStart" || payload["source"] !== "compact")
          raise(method, payload);
        return;
      }
      const answer = await raise(method, payload);
      return answer === undefined ? undefined : hookAnswerOf(named, answer);
    });
  };
  const listen = (method, args) => {
    const entry = listenerOf(name, method, args);
    const held = processListeners.get(method) ?? new Set;
    if (!processListeners.has(method)) {
      listenTo(method, method.replace(/^(on|before)/, ""));
      processListeners.set(method, held);
    }
    held.add(entry);
    return { dispose: () => void held.delete(entry) };
  };
  const processMethods = () => Object.fromEntries(Object.entries(processEvents).flatMap(([named, event]) => [`on${named}`, ..."before" in event ? [`before${named}`] : []]).map((method) => [method, (...args) => listen(method, args)]));
  const currentSession = Object.assign(sessionOf(() => current2), processMethods());
  const every = eventMethods(() => ({}), false);
  const answerBefore = async (session, event, change, isInProject) => session === current2.id || isGranted("conversation") ? combined(session, event, change, isInProject) : undefined;
  return {
    sessions: {
      get current() {
        return currentSession;
      },
      list: async (scope = {}) => (await call(conversationMethods.sessions, scope)).map((data) => {
        if (data.id !== current2.id) {
          known.set(data.id, data);
          return sessionOf(() => known.get(data.id) ?? data);
        }
        if (current2.title === "")
          current2 = { ...current2, title: data.title };
        return currentSession;
      }),
      search: (text, matcher, options = {}) => searched({ text, ...searchOptionsOf(options) }, matcher),
      ...every
    },
    changed(session, change, isInProject) {
      remember(session, change);
      let payload;
      for (const key of isInProject ? [session, everySession] : [session]) {
        for (const { scope, event, method, matcher, listener, options } of listening.get(key) ?? []) {
          if (!isHeardBy(event, matcher, change) || !isInScope(scope, session, change, isUnderIn(session)))
            continue;
          payload ??= payloadFor(session, change);
          payload.then((heard) => invoke(method, options, (time2) => listener(heard, time2))).catch((error) => report(`session:${method}`, `The ${method} listener failed`, error));
        }
      }
    },
    answerBefore,
    raise,
    listen,
    follow(next) {
      const moved = next.id !== current2.id && current2.id !== "";
      const previous = current2.id;
      current2 = { ...next, title: next.title || (next.id === current2.id ? current2.title : ""), isRunning: true, lastAt: new Date().toISOString() };
      if (!moved)
        return;
      for (const into of [listening, deciding]) {
        const kept = into.get(previous);
        if (kept === undefined)
          continue;
        into.delete(previous);
        for (const entry of kept)
          if (entry.scope.session === previous)
            entry.scope = { ...entry.scope, session: current2.id };
        into.set(current2.id, new Set([...into.get(current2.id) ?? [], ...kept]));
      }
      parents.delete(previous);
      subscribe(previous);
      subscribe(current2.id);
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
  ProjectSetup: [],
  SessionStart: ["note", "title", "reloadSkills", "firstPrompt"],
  ModelChange: ["ask", "refuse"],
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
async function spawnTask(claude, task) {
  if (task.title.trim() === "")
    throw new Error("a task needs a title.");
  const started = await claude.agent.spawn({
    prompt: task.prompt,
    description: task.title,
    ...task.name === undefined ? {} : { name: task.name },
    ...task.agentType === undefined ? {} : { subagentType: task.agentType },
    ...task.model === undefined ? {} : { model: task.model },
    ...task.cwd === undefined ? {} : { cwd: task.cwd }
  });
  if (started.deny !== undefined)
    throw new Error(`Claude Code refused the task: ${started.deny}`);
  if (started.agentId === undefined)
    throw new Error("Claude Code answered without starting a task.");
  return { id: started.agentId, title: task.title, agentType: task.agentType ?? "general-purpose", model: started.model, openedBy: "", openedAt: new Date().toISOString() };
}
function processPayloadOf(named, input) {
  const fields = recordOf(input);
  return { ...placementOf(fields), ...defined(processFields[named](fields)) };
}
function hookAnswerOf(named, answer) {
  const refuse = typeof answer["refuse"] === "string" ? answer["refuse"] : undefined;
  const note = typeof answer["note"] === "string" ? [answer["note"]] : undefined;
  if (named === "SessionStart")
    return defined({ additionalContext: note, sessionTitle: answer["title"], reloadSkills: answer["reloadSkills"] === true ? true : undefined, initialUserMessage: answer["firstPrompt"] });
  if (named === "ModelChange") {
    if (refuse !== undefined)
      return { permissionDecision: "deny", permissionDecisionReason: refuse };
    return typeof answer["ask"] === "string" ? { permissionDecision: "ask", permissionDecisionReason: answer["ask"] } : undefined;
  }
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
var bufferedTaskRows = 200;
var beforeDeadlineMs = 5000;
var livenessMs = 5000;
function serveConversations({ claude, router, store, project, report }) {
  const folder = dataFolder(store, cmodPluginName);
  const goals = `${folder}/goals`;
  const watches = `${folder}/before`;
  const heard = new Map;
  const asked = new Map;
  const ownWatches = new Map;
  let watchers = [];
  let watching = Promise.resolve();
  let published = new Set;
  let publishing = Promise.resolve();
  let session = "";
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
  const endTurn = (ending, task) => (below) => {
    if (below.block !== undefined)
      return below;
    engineTurns.delete(task ?? "");
    dispatch(session, conversation.endTurn(new Date().toISOString(), ending, task));
    return below;
  };
  router.add("classic.Stop", async (e, next) => endTurn({ reason: "answer", ...e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message } })(await next(e)));
  router.add("classic.StopFailure", async (e, next) => endTurn({ reason: "error", failure: { type: String(e.error), text: e.error_details ?? e.last_assistant_message ?? String(e.error) } })(await next(e)));
  router.add("classic.SubagentStop", async (e, next) => endTurn({ reason: "answer", ...e.last_assistant_message === undefined ? {} : { answer: e.last_assistant_message } }, e.agent_id)(await next(e)));
  const json = async (args) => JSON.parse(await runCmod(claude, [...args, "--json", "--project", project()], await claude.session.id()));
  const isGranted = async (caller, item) => {
    if (caller === cmodPluginName)
      return true;
    if (caller === undefined)
      return false;
    const path = consentPath(store);
    const text = await claude.fs.read(path).catch(ifMissing("{}"));
    return (parseConsent(JSON.parse(text), path)[caller] ?? []).includes(item);
  };
  const ended = (id) => new Error(`session ${id} has ended`);
  const isRunning = async (id) => (await json(["history", "sessions", "--running", "--all"])).some((each) => each.id === id);
  const dispatch = (to, changes, isInProject = true) => {
    for (const change of changes) {
      if (change.type === Message && !liveIds.has(change.message.id) && to === session) {
        live.push(change.message);
        liveIds.add(change.message.id);
      }
      for (const [mod, sessions2] of heard) {
        const subscriptions = [...sessions2.get(to) ?? [], ...isInProject ? sessions2.get(everySession) ?? [] : []];
        if (!subscriptions.some(({ event, matcher }) => isHeardBy(event, matcher, change)))
          continue;
        claude.cmod.call({ to: mod, method: conversationMethods.changed, input: { session: to, change, isInProject } }).catch((error) => report(`changed:${mod}`, `Could not tell ${mod} about session ${to}`, error));
      }
    }
  };
  const restartFollower = async () => {
    if (session === "")
      return;
    const wantsEvery = [...heard.values()].some((sessions2) => (sessions2.get(everySession) ?? []).length > 0);
    const named = [...heard.values()].flatMap((sessions2) => [...sessions2].filter(([id, list]) => id !== session && id !== everySession && list.length > 0).map(([id]) => id));
    const others = [...new Set(named)].sort();
    const args = [...others, ...wantsEvery ? ["--running"] : []];
    const wanted = [session, project(), ...args].join(" ");
    if (follower?.sessions === wanted)
      return;
    follower?.stop();
    follower = undefined;
    if (args.length === 0)
      return;
    const stream = claude.process.spawn({ argv: ["cmod", "history", "follow", ...args, "--json", "--project", project()], env: { CLAUDE_CODE_SESSION_ID: session } });
    const started = { sessions: wanted, stop: () => void stream.return(undefined) };
    follower = started;
    readLines(stream, (line) => {
      if (line.trim() === "")
        return;
      const parsed = JSON.parse(line);
      dispatch(parsed.session, [parsed.change], parsed.isInProject);
    }).then(({ code, lastError }) => {
      if (follower === started)
        throw new Error(`cmod history follow ${formatExit(code, lastError)}`);
    }).catch((error) => {
      if (follower !== started)
        return;
      follower = undefined;
      report("follow", "Stopped hearing the other sessions", error);
    });
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
  const ask = (to, relay, deadlineMs) => new Promise((resolve2, reject) => {
    const id = `${session}:${asks += 1}`;
    const settle = {
      resolve(value) {
        if (asked.delete(id))
          timer.cancel();
        resolve2(value);
      },
      reject(error) {
        if (asked.delete(id))
          timer.cancel();
        reject(error);
      }
    };
    const timer = deadlineMs === undefined ? watchLife(settle, to) : claude.clock.after(deadlineMs, () => settle.reject(new Error(`session ${to} did not answer within ${deadlineMs / 1000} s`)));
    asked.set(id, settle);
    post(to, { ...relay, id, from: session }).catch((error) => settle.reject(error instanceof Error ? error : new Error(messageOf(error))));
  });
  const publishWatches = (isEnding = false) => {
    const next = publishing.then(() => publishNow(isEnding));
    publishing = next.catch((error) => claude.ui.log(`cmod: publishing before listeners failed: ${messageOf(error)}`, { to: "debug" }));
    return next;
  };
  const publishNow = async (isEnding) => {
    if (session === "")
      return;
    const list = isEnding ? [] : [...ownWatches.values()].filter((watch) => watch.events.length > 0);
    await claude.fs.write(`${watches}/${session}.json`, JSON.stringify(list));
    const targets = new Set([...published, ...list.map((watch) => watch.target)]);
    published = new Set(list.map((watch) => watch.target));
    const running = targets.has(everySession) ? (await json(["history", "sessions", "--running"])).map((each) => each.id) : [];
    const told = new Set([...running, ...targets].filter((id) => id !== everySession && id !== session));
    await Promise.all([...told].map((id) => post(id, { kind: "watch" }).catch((error) => claude.ui.log(`cmod: session ${id} did not hear of a before listener: ${messageOf(error)}`, { to: "debug" }))));
  };
  const readWatchers = async () => {
    const files = await claude.fs.list(watches).catch(ifMissing([]));
    const found = [];
    for (const file of files) {
      const from = file.name.replace(/\.json$/, "");
      if (from === session || !file.name.endsWith(".json"))
        continue;
      const list = JSON.parse(await claude.fs.read(`${watches}/${file.name}`).catch(ifMissing("[]")));
      found.push(...list.filter((watch) => watch.target === session || watch.target === everySession && watch.project === project()).map((watch) => ({ ...watch, from })));
    }
    watchers = found;
  };
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
  const askHere = async (mod, event, change, from = session, isInProject = true) => {
    if (from !== session && !await isGranted(mod, "conversation"))
      throw new Error(`${mod} needs the conversation permission to change what happens in another session. Turn it on in /mods ${mod}.`);
    return claude.cmod.call({ to: mod, method: conversationMethods.before, input: { session: from, event, change, isInProject } });
  };
  const askAway = async (watcher, event, change) => {
    try {
      return await ask(watcher.from, { kind: "before", mod: watcher.mod, event, change, project: project() }, beforeDeadlineMs);
    } catch (error) {
      if (await isRunning(watcher.from))
        throw error;
      watchers = watchers.filter((each) => each.from !== watcher.from);
      claude.ui.log(`cmod: session ${watcher.from} ended without clearing its before listeners, so they are cleared now`, { to: "debug" });
      await claude.fs.write(`${watches}/${watcher.from}.json`, "[]");
      return;
    }
  };
  installBefore({
    claude,
    router,
    hooks: {
      place: async () => {
        await starting;
        return place();
      },
      wants: async (event) => {
        await Promise.all([starting, watching]);
        return deciders(event).length > 0;
      },
      decide: (event, change) => foldBefore(event, change, deciders(event).map((watcher) => (latest) => watcher.from === session ? askHere(watcher.mod, event, latest) : askAway(watcher, event, latest)), (error) => report(`before:${event}`, `Passed the ${event} on without a mod's answer`, error))
    }
  });
  const start = (id, source) => {
    if (id === session)
      return;
    const previous = session;
    session = id;
    live = [];
    liveIds.clear();
    waitingRows.clear();
    conversation = createConversation(emptyConversation(id));
    starting = source === "startup" || source === "clear" ? Promise.resolve(dispatch(id, conversation.startContext(new Date().toISOString()))) : json(["history", "state", id]).then((state) => {
      if (session === id)
        conversation = createConversation({ ...emptyConversation(id), ...state });
    }, (error) => report("state", `Starts session ${id} without its earlier turns`, error));
    follow();
    reloadWatchers();
    if (ownWatches.size === 0)
      return;
    Promise.all([previous === "" ? undefined : claude.fs.write(`${watches}/${previous}.json`, "[]"), publishWatches()]).catch((error) => report("before", "Kept its before listeners on the session from before", error));
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
  };
  router.add("classic.SessionStart", async (e, next) => {
    start(e.session_id, e.source);
    return next(e);
  });
  router.add("classic.SessionEnd", async (e, next) => {
    if (ownWatches.size > 0)
      await publishWatches(true).catch((error) => report("before", "Left its before listeners registered", error));
    return next(e);
  });
  router.add("session.append", async (e, next) => {
    const kept = await next(e);
    if (kept.deny !== undefined || session === "")
      return kept;
    const cwd2 = e.message.type === "assistant" ? await claude.session.cwd() : "";
    take(rowOfAppend({ uuid: kept.uuid, door: e.door, origin: e.origin, message: kept.message }, new Date().toISOString(), cwd2), e.agentId).catch((error) => report("append", "Missed a message", error));
    return kept;
  });
  router.add("session.compact", async (e, next) => {
    const compacted = await next(e);
    if (e.trigger === "precompute" || compacted.skip !== undefined || session === "")
      return compacted;
    const at = new Date().toISOString();
    const boundary = { id: `compact:${e.agentId ?? session}:${at}`, at, type: "system", name: "compact_boundary", isMeta: false, isSummary: false, content: [] };
    take(boundary, e.agentId).catch((error) => report("compact", "Missed a compaction", error));
    return compacted;
  });
  router.add("session.measure", async (e, next) => {
    const measured = await next(e);
    if (session !== "")
      dispatch(session, [{ type: UsageChange, usage: await usageOf(claude) }]);
    return measured;
  });
  router.add("agent.spawn", async (e, next) => {
    const spawned = await next(e);
    if (spawned.deny !== undefined || spawned.agentId === undefined)
      return spawned;
    const id = spawned.agentId;
    const opened = { id, title: e.description, agentType: e.subagentType, model: spawned.model, openedBy: e.tool_use_id, openedAt: new Date().toISOString(), ...e.parentAgentId === undefined ? {} : { parent: e.parentAgentId } };
    await starting;
    dispatch(session, conversation.startTask(opened));
    const waiting = waitingRows.get(id) ?? [];
    waitingRows.delete(id);
    for (const row of waiting)
      dispatch(session, conversation.add(row, id));
    return spawned;
  });
  router.add("session.receive", async (e, next) => {
    const sent = relayOf(e);
    if (sent === undefined)
      return next(e);
    const relay = JSON.parse(sent);
    claude.clock.after(0, () => void received(relay).catch((error) => report("relay", "Could not answer another session", error)));
    return { consumed: "cmod relay" };
  });
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
    const answered = async (run) => {
      try {
        await post(relay.from, { kind: "answer", id: relay.id, value: await run() ?? null });
      } catch (error) {
        await post(relay.from, { kind: "answer", id: relay.id, deny: messageOf(error) });
      }
    };
    if (relay.kind === "act")
      return answered(() => perform(relay.caller, relay.action, relay.input, relay.task));
    return answered(() => askHere(relay.mod, relay.event, relay.change, relay.from, relay.project === project()));
  };
  const checkAct = async (caller, action, input) => {
    const needed = actPermission(action, input);
    if (needed !== undefined && !await isGranted(caller, needed))
      throw new Error(`${caller} needs the ${needed} permission for ${action}. Turn it on in /mods ${caller}.`);
  };
  const perform = async (caller, action, input, task) => {
    await checkAct(caller, action, input);
    await starting;
    if (action === "abort")
      return abortTurn(input, task);
    if (task !== undefined)
      return performInTask(action, input, task);
    if (action === "usage")
      return usageOf(claude);
    if (action === "surfaces")
      return [...await claude.session.surfaces()];
    if (action === "send") {
      const { type, text, as } = input;
      if (as === Session)
        throw new Error(`session ${session} cannot send as itself to itself.`);
      const delivered = type === Note ? await claude.session.append({ message: { type: "user", content: [{ type: "text", text }] } }) : await claude.prompt.submit({ text, ...as === Person ? { asUser: true } : {} });
      if ("deny" in delivered && typeof delivered.deny === "string")
        throw new Error(`Claude Code refused the note: ${delivered.deny}`);
      if ("drop" in delivered && typeof delivered.drop === "string")
        throw new Error(`Claude Code dropped the prompt: ${delivered.drop}`);
      return null;
    }
    if (action === "startTask")
      return spawnTask(claude, input);
    const { name, input: toolInput } = input;
    return resultOf(place(), { name, input: toolInput, cwd: await claude.session.cwd() }, await claude.tool.call({ ...toolInput, tool: name }));
  };
  const abortTurn = async (input, task) => {
    const turnId = engineTurns.get(task ?? "");
    if (turnId === undefined)
      throw new Error(`no turn is running in ${task === undefined ? `session ${session}` : `task ${task}`}.`);
    const asked2 = isObject(input) ? input["turn"] : undefined;
    const open = task === undefined ? conversation.state.turn : conversation.state.taskTurns[task];
    if (open?.prompt.id !== asked2)
      throw new Error(`turn ${String(asked2)} has ended, so there is nothing to abort.`);
    await claude.turn.abort({ turnId });
    return null;
  };
  const performInTask = async (action, input, task) => {
    const running = conversation.state.tasks[task];
    if (action === "usage")
      return json(["history", "usage", session, "--task", task]);
    if (action === "surfaces")
      return running === undefined || running.closedAt !== undefined ? [] : [...await claude.session.surfaces()];
    if (action !== "send")
      throw new Error(`cmod: ${action} runs only on a session's own main loop.`);
    if (running === undefined || running.closedAt !== undefined)
      throw ended(task);
    const sent = await claude.session.send({ to: { agentId: task }, text: input.text });
    if (sent.isDelivered !== true)
      throw ended(task);
    return null;
  };
  const actElsewhere = async (caller, target, action, input, task) => {
    await checkAct(caller, action, input);
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
    agentType: task.agentType,
    ...task.model === undefined ? {} : { model: task.model },
    openedBy: task.openedBy,
    openedAt: task.openedAt,
    ...task.closedAt === undefined ? {} : { closedAt: task.closedAt },
    ...task.parent === undefined ? {} : { parent: task.parent }
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
      const saved = await json(["history", "messages", id, ...filters, ...countArg("--last", request["last"])]);
      if (id !== session)
        return saved;
      await starting;
      const fits = (message) => (request["turn"] === undefined || message.turn === request["turn"]) && message.task === request["task"];
      const after = typeof request["after"] === "string" ? live.findIndex((message) => message.id === request["after"]) : -1;
      const kept = live.slice(after + 1).filter(fits);
      return lastOf(merged(saved, kept, (message) => message.id), request["last"]);
    },
    async[conversationMethods.turns](request) {
      const id = String(request["session"]);
      const saved = await json(["history", "turns", id, ...textArg("--task", request["task"]), ...countArg("--context", request["context"]), ...countArg("--last", request["last"])]);
      if (id !== session)
        return saved;
      await starting;
      const kept = liveTurns(request["task"]).filter((turn) => request["context"] === undefined || turn.context === request["context"]);
      return lastOf(merged(saved, kept, (turn) => turn.prompt.id), request["last"]);
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
      return merged(saved, kept, (task) => task.id);
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
        await post(id, { kind: "goal", ...task === undefined ? {} : { task }, text }).catch((error) => claude.ui.log(`cmod: session ${id} keeps its goal until it starts again: ${messageOf(error)}`, { to: "debug" }));
      }
      return null;
    },
    async[conversationMethods.subscribe](request, caller) {
      if (caller === undefined)
        throw new Error("cmod hears no caller for this subscription.");
      const id = String(request["session"]);
      const list = Array.isArray(request["subscriptions"]) ? request["subscriptions"] : [];
      const sessions2 = heard.get(caller) ?? new Map;
      sessions2.set(id, list.map(({ event, matcher }) => ({ event, matcher: matcher === undefined ? undefined : receivedMatcher(matcher) })));
      heard.set(caller, sessions2);
      follow();
      return null;
    },
    async[conversationMethods.watchBefore](request, caller) {
      if (caller === undefined)
        throw new Error("cmod hears no caller for this before listener.");
      const target = String(request["session"]);
      const list = Array.isArray(request["subscriptions"]) ? request["subscriptions"] : [];
      ownWatches.set(`${caller}
${target}`, { mod: caller, target, project: project(), events: [...new Set(list.map(({ event }) => event))] });
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
      const isDropping = (e.method === conversationMethods.subscribe || e.method === conversationMethods.watchBefore) && Array.isArray(input["subscriptions"]) && input["subscriptions"].length === 0;
      if (e.method !== conversationMethods.act && !isDropping && input["session"] !== await claude.session.id() && !await isGranted(e.caller, "conversation"))
        return { deny: `${e.caller ?? "A mod"} reads your conversations without your grant. Turn it on in /mods ${e.caller ?? ""}.`.trim() };
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

// node_modules/@cmodjs/core/runtime/grants.js
class PermissionRefused extends Error {
}
var addressesOfPrograms = new WeakMap;
function programAddresses(mod) {
  const known = addressesOfPrograms.get(mod) ?? new Set;
  addressesOfPrograms.set(mod, known);
  return known;
}
var projectSettingsFiles = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"];
var conversationCalls = {
  [conversationMethods.sessions]: "sessions.list",
  [conversationMethods.search]: "sessions.search",
  [conversationMethods.messages]: "messages",
  [conversationMethods.turns]: "turns",
  [conversationMethods.contexts]: "contexts",
  [conversationMethods.tasks]: "tasks",
  [conversationMethods.goal]: "goal",
  [conversationMethods.updateGoal]: "goal.update",
  [conversationMethods.subscribe]: "on",
  [conversationMethods.watchBefore]: "before",
  [conversationMethods.act]: "act"
};
async function checkGrant(grants, call, item) {
  if (item === undefined)
    return;
  await grants.refresh();
  if (!isCovered(grants.granted(), item, grants.home))
    throw new PermissionRefused(refusal(grants, call, item));
}
async function checkWrite(grants, call, path) {
  await checkGrant(grants, call, writeItem(grants, path));
}
async function checkSettings(grants, source, values) {
  for (const path of settingPaths(values).map((each) => each.join(".")))
    await checkGrant(grants, `settings.${source}.update(${path})`, `config:${path}`);
}
function checkingGrants(claude, grants) {
  const gate = (call, item) => checkGrant(grants, call, item);
  return {
    ...claude,
    process: {
      async run(argv, init) {
        await gate(`process.run(${argv.join(" ")})`, `run:${programOf(argv)}`);
        return claude.process.run(argv, init);
      },
      spawn(request) {
        const started = gate(`process.spawn(${request.argv.join(" ")})`, `run:${programOf(request.argv)}`).then(() => claude.process.spawn(request));
        return spawned(started);
      }
    },
    fs: {
      ...claude.fs,
      async read(path) {
        await gate(`fs.read(${path})`, readItem(grants, path));
        return claude.fs.read(path);
      },
      async write(path, text) {
        await gate(`fs.write(${path})`, writeItem(grants, path));
        return claude.fs.write(path, text);
      }
    },
    http: {
      async fetch(url, init) {
        if (!grants.freeAddresses().has(init?.socketPath ?? addressOf(url)))
          await gate(`http.fetch(${url})`, `network:${init?.socketPath ?? hostOf(url)}`);
        return claude.http.fetch(url, init);
      }
    },
    session: {
      ...claude.session,
      append: async (args) => {
        await gate("send", "prompt");
        return claude.session.append(args);
      },
      send: async (args) => {
        await gate("send", "prompt");
        return claude.session.send(args);
      }
    },
    prompt: {
      submit: async (args) => {
        await gate("send", "prompt");
        return claude.prompt.submit(args);
      }
    },
    command: {
      ...claude.command,
      run: async (args) => {
        await gate(`commands.run(${args.command})`, "prompt");
        return claude.command.run(args);
      }
    },
    cmod: {
      async call(args) {
        const named = args.to === cmodPluginName ? conversationCalls[args.method] : undefined;
        const given = args.method === conversationMethods.act && isObject(args.input) ? String(args.input["action"]) : undefined;
        const action = given !== undefined && isAct(given) ? given : undefined;
        const isThisSession = isObject(args.input) && args.input["session"] === await claude.session.id();
        const isDropping = (args.method === conversationMethods.subscribe || args.method === conversationMethods.watchBefore) && isObject(args.input) && Array.isArray(args.input["subscriptions"]) && args.input["subscriptions"].length === 0;
        if (named !== undefined && action !== undefined)
          await gate(action, actPermission(action, isObject(args.input) ? args.input["input"] : undefined));
        else if (named !== undefined && !isThisSession && !isDropping)
          await gate(named, "conversation");
        return claude.cmod.call(args);
      }
    },
    model: {
      complete: async (...args) => {
        await gate("model.complete", "model");
        return claude.model.complete(...args);
      }
    },
    agent: {
      ...claude.agent,
      async spawn(args) {
        await gate("startTask", "tasks");
        return claude.agent.spawn(args);
      }
    },
    tool: {
      ...claude.tool,
      call: async (input) => {
        await gate(`tool.call(${input.tool})`, toolPermission(input.tool));
        return claude.tool.call(input);
      }
    }
  };
}
function spawned(started) {
  const result = started.then((stream2) => stream2.result);
  result.catch(() => {
    return;
  });
  const stream = {
    next: async () => (await started).next(),
    async return(value) {
      const [start] = await Promise.allSettled([started]);
      return start.status === "fulfilled" ? start.value.return(value) : { done: true, value };
    },
    [Symbol.asyncIterator]: () => stream,
    result
  };
  return stream;
}
function itemOf(name, value) {
  return value === undefined ? name : `${name}:${value}`;
}
function isCovered(granted, item, home) {
  if (granted.has(item))
    return true;
  const split = item.indexOf(":");
  if (split === -1)
    return false;
  const name = item.slice(0, split);
  if (name === "config")
    return isSettingCovered(granted, item.slice(split + 1));
  const target = expanded(item.slice(split + 1), home);
  const values = [...granted].filter((each) => each.startsWith(`${name}:`)).map((each) => expanded(each.slice(name.length + 1), home));
  if (name === "run")
    return values.includes("*") || values.includes(target);
  if (name === "files")
    return values.some((each) => relativePath(each, target) !== undefined);
  return values.includes(target);
}
function readItem(grants, path) {
  if (grants.configRoot === undefined)
    return;
  return relativePath(`${grants.configRoot}/projects`, path) === undefined ? undefined : "conversation";
}
function writeItem(grants, path) {
  const root = grants.projectRoot();
  const settingsFiles = [...projectSettingsFiles.map((file) => `${root}/${file}`), ...grants.configRoot === undefined ? [] : [`${grants.configRoot}/settings.json`]];
  if (settingsFiles.includes(path)) {
    throw new PermissionRefused(`${grants.name} writes ${path} by hand. Change Claude Code's settings with settings.user.update, settings.project.update, or settings.local.update, which keep the person's own edits and take the mod's values out when it is removed.`);
  }
  if (grants.freeFolders().some((folder) => relativePath(folder, path) !== undefined))
    return;
  return `files:${path}`;
}
function refusal(grants, call, item) {
  const { name } = grants;
  if (isCovered(new Set(grants.declared), item, grants.home))
    return `${name} calls ${call} without your grant to "${permissionWords(item)}". Turn it on in /mods ${name}.`;
  return `${name} calls ${call}, which needs ${declaration(item, grants.home)} in package.json "cmod".`;
}
function declaration(item, home) {
  const split = item.indexOf(":");
  if (split === -1)
    return `"permissions": { "${item}": true }`;
  const name = item.slice(0, split);
  const target = item.slice(split + 1);
  const fromHome = home === undefined ? undefined : relativePath(home, target);
  const shown = name !== "run" && fromHome !== undefined ? `~/${fromHome}` : target;
  return `"permissions": { "${name}": ["${shown}"] }`;
}
var classicParts = {
  additionalContext: "prompt",
  initialUserMessage: "prompt",
  updatedToolOutput: "prompt",
  updatedMCPToolOutput: "prompt",
  retry: "approve"
};
var blocksKeepWorking = ["classic.Stop", "classic.PostToolUse"];
var reservedToolKeys = ["tool", "tool_use_id"];
function checksAnswers(event) {
  return event.startsWith("classic.") || event === "tool.check" || event === "tool.call" || event === "prompt.context" || event === "prompt.submit";
}
function passedDown(event, original, passed, check) {
  if (passed === original)
    return passed;
  if (event === "tool.call") {
    if (sameExcept(original, passed, reservedToolKeys) || check.isGranted("tools"))
      return passed;
    check.dropped("tools", "a changed tool input");
    return original;
  }
  if (event === "prompt.context" || event === "prompt.submit") {
    if (same(original, passed) || check.isGranted("prompt"))
      return passed;
    check.dropped("prompt", event === "prompt.submit" ? "a rewritten prompt" : "changed context");
    return original;
  }
  return passed;
}
async function checkedAnswer(event, e, answer, below, check) {
  if (!isFields(answer))
    return answer;
  if (event === "tool.check")
    return decided(answer["decision"], answer, below, check);
  if (event === "classic.PermissionRequest") {
    const decision = isFields(answer["decision"]) ? answer["decision"]["behavior"] : undefined;
    return decided(decision, answer, below, check);
  }
  if (event.startsWith("classic."))
    return classicAnswer(event, answer, below, check);
  if (event === "tool.call") {
    if (answer["deny"] !== undefined || check.isGranted("prompt"))
      return answer;
    const tool = isFields(e) ? e["tool"] : undefined;
    if (typeof tool === "string" && tool.startsWith(`mcp__${check.plugin}__`)) {
      if (answer["context"] === undefined)
        return answer;
      check.dropped("prompt", "context after a tool call");
      const { context: _context, ...rest } = answer;
      return rest;
    }
    const theirs = await below();
    if (same(answer, theirs))
      return answer;
    check.dropped("prompt", same(contextOf(answer), contextOf(theirs)) ? "a changed tool result" : "context after a tool call");
    return theirs;
  }
  if (event === "prompt.submit" && answer["drop"] !== undefined)
    return answer;
  if (event === "prompt.context" || event === "prompt.submit") {
    if (check.isGranted("prompt"))
      return answer;
    const theirs = await below();
    if (same(answer, theirs))
      return answer;
    check.dropped("prompt", event === "prompt.submit" ? "a rewritten prompt" : "changed context");
    return theirs;
  }
  return answer;
}
async function decided(decision, answer, below, check) {
  if (decision !== "allow" && decision !== "ask" || check.isGranted("approve"))
    return answer;
  const theirs = await below();
  if (same(answer, theirs))
    return answer;
  check.dropped("approve", `${decision} on a tool call`);
  return theirs;
}
async function classicAnswer(event, answer, below, check) {
  const blocks = blocksKeepWorking.includes(event) ? [["block", "prompt"]] : [];
  const parts = [...Object.entries(classicParts), ...blocks].filter(([part, item]) => answer[part] !== undefined && !check.isGranted(item));
  if (parts.length === 0)
    return answer;
  const theirs = await below();
  const kept = { ...answer };
  const theirFields = isFields(theirs) ? theirs : {};
  for (const [part, item] of parts) {
    if (same(answer[part], theirFields[part]))
      continue;
    check.dropped(item, part);
    if (theirFields[part] === undefined)
      delete kept[part];
    else
      kept[part] = theirFields[part];
  }
  return kept;
}
function contextOf(answer) {
  return isFields(answer) ? answer["context"] : undefined;
}
function same(left, right) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
function sameExcept(left, right, keys) {
  if (!isFields(left) || !isFields(right))
    return same(left, right);
  const without = (fields) => Object.fromEntries(Object.entries(fields).filter(([key]) => !keys.includes(key)));
  return same(without(left), without(right));
}
function isFields(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function programOf(argv) {
  const command = argv[0] ?? "";
  return command.slice(command.lastIndexOf("/") + 1);
}
function hostOf(url) {
  return URL.canParse(url) ? new URL(url).hostname : url;
}
function addressOf(url) {
  return URL.canParse(url) ? new URL(url).host : url;
}
function expanded(path, home) {
  return path.startsWith("~/") && home !== undefined ? `${home}${path.slice(1)}` : path;
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
function formatOf(path, firstLine2) {
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
  if (extension === "" && firstLine2?.startsWith("#!") === true)
    return { type: "comment", prefix: "#" };
  return { type: "sidecar" };
}
function readMetadata(text, format2) {
  const lines = text.split(`
`);
  if (format2.type === "comment") {
    const region2 = commentRegion(lines, format2.prefix);
    return { metadata: region2 === undefined ? {} : asRecord(mapEntries(region2.lines, region2.start + 2, 0)) };
  }
  const region = format2.type === "frontmatter" ? frontmatterRegion(lines) : { start: -1, end: lines.length, lines };
  if (region === undefined)
    return { metadata: {} };
  const block = metadataBlock(region);
  const name = format2.type === "frontmatter" ? topLevelScalar(region, "name") : undefined;
  return { metadata: block === undefined ? {} : asRecord(block.entries), ...name === undefined ? {} : { name } };
}
function writeMetadata(text, format2, metadata) {
  const lines = text.split(`
`);
  const entries = Object.entries(metadata);
  if (format2.type === "comment") {
    const { prefix } = format2;
    const block2 = entries.length === 0 ? [] : [`${prefix} /// metadata`, ...entries.map(([key, value]) => `${prefix} ${scalar(key)}: ${scalar(value)}`), `${prefix} ///`];
    const region2 = commentRegion(lines, prefix);
    if (region2 !== undefined)
      return [...lines.slice(0, region2.start), ...block2, ...lines.slice(region2.end + 1)].join(`
`);
    if (block2.length === 0)
      return text;
    const at = lines[0]?.startsWith("#!") === true ? 1 : 0;
    return [...lines.slice(0, at), ...block2, ...lines.slice(at)].join(`
`);
  }
  const map = entries.length === 0 ? [] : ["metadata:", ...entries.map(([key, value]) => `  ${scalar(key)}: ${scalar(value)}`)];
  if (format2.type === "sidecar") {
    const block2 = metadataBlock({ start: -1, end: lines.length, lines });
    const rest = block2 === undefined ? lines : [...lines.slice(0, block2.start), ...lines.slice(block2.end)];
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
function mapEntries(lines, firstLine2, indent) {
  const entries = [];
  lines.forEach((raw, index) => {
    const lineNumber = firstLine2 + index;
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
  let current2 = "";
  for (let index = 0;index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      current2 += char;
      if (char === "\\" && quote === '"') {
        current2 += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote)
        quote = undefined;
      continue;
    }
    const before = current2.trimEnd().at(-1);
    if ((char === '"' || char === "'") && (before === undefined || before === ":"))
      quote = char;
    const next = text[index + 1];
    if (char === separator && (!needsSpace || next === undefined || next === " " || next === "\t")) {
      parts.push(current2);
      current2 = "";
      if (needsSpace) {
        parts.push(text.slice(index + 1));
        return parts;
      }
      continue;
    }
    current2 += char;
  }
  if (quote !== undefined)
    throw new MetadataError(lineNumber, `a ${quote === '"' ? "double" : "single"} quote never closes.`);
  parts.push(current2);
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
    return resolve(`${places.configRoot}${path.slice(configured[0].length)}`);
  const prefix = homePrefix.exec(path)?.[0];
  if (prefix !== undefined) {
    if (places.home === undefined)
      throw new Error(`${path} starts with ${prefix}, and HOME is not set. Start Claude Code with HOME set.`);
    return resolve(expandHome(path, places.home, places.configRoot));
  }
  return path.startsWith("/") ? resolve(path) : resolve(places.projectRoot(), path);
}
function createModFiles({ name, claude, places, checkWrite: checkWrite2, report }) {
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
    const firstLine2 = extensionless ? (await claude.fs.read(realPath)).split(`
`, 1)[0] : undefined;
    const format2 = formatOf(realPath, firstLine2);
    const holder = format2.type === "sidecar" ? `${realPath}${sidecarSuffix}` : realPath;
    const sidecar = format2.type === "sidecar" ? await claude.fs.stat(holder).catch(ifMissing(undefined)) : undefined;
    return { realPath, format: format2, holder, signature: `${stat.mtimeMs}:${stat.size}:${sidecar?.kind === "file" ? `${sidecar.mtimeMs}:${sidecar.size}` : ""}` };
  };
  const textOf2 = async (holder) => (await claude.fs.stat(holder).catch(ifMissing(undefined)))?.kind === "file" ? claude.fs.read(holder) : "";
  const skipped = (path, value) => (error) => {
    if (isMissing(error))
      return value;
    const reason = `${name}: fs.find skipped ${path}: ${messageOf(error)}`;
    if (!logged.has(reason))
      claude.ui.log(reason, { to: "debug" });
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
      const { metadata, name: declared } = readMetadata(await textOf2(located.holder), located.format);
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
    const scanned = export_picomatch.scan(absolute);
    if (!scanned.isGlob)
      return (await claude.fs.stat(absolute).catch(skipped(absolute, undefined)))?.kind === "file" ? [absolute] : [];
    const isMatch = export_picomatch(absolute, { dot: true });
    const entersSkipped = skippedFolders.filter((folder) => scanned.glob.split("/").includes(folder));
    const maxDepth = scanned.glob.includes("**") ? Number.POSITIVE_INFINITY : scanned.glob.split("/").length;
    const found = [];
    const visited = new Set;
    const walk2 = async (folder, depth) => {
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
        await walk2(path, depth + 1);
      }));
    };
    const base = scanned.base === "" ? "/" : scanned.base;
    if ((await claude.fs.stat(base).catch(skipped(base, undefined)))?.kind === "dir")
      await walk2(base, 0);
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
      await checkWrite2(given);
      const located = await locate(given);
      const text = await textOf2(located.holder);
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
function drawWith(table, draw, markdown2) {
  const outer = drawing;
  const current2 = { table, markdown: markdown2 };
  drawing = current2;
  try {
    return built(current2, draw());
  } finally {
    drawing = outer;
  }
}
function element(name) {
  const construct = (props) => drawing === undefined ? { [unbuilt]: { name, props } } : build(drawing, name, props);
  return construct;
}
function build(current2, name, props) {
  const ready = "children" in props ? { ...props, children: built(current2, props.children) } : props;
  if (name === "Markdown" && current2.markdown !== undefined)
    return current2.markdown(ready);
  return current2.table[name](ready);
}
function built(current2, value) {
  if (Array.isArray(value))
    return value.map((child) => built(current2, child));
  if (typeof value !== "object" || value === null || !(unbuilt in value))
    return value;
  const { name, props } = value[unbuilt];
  return build(current2, name, props);
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

// node_modules/@cmodjs/core/runtime/installer.js
var installerPaneOf = (name) => `installer-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
function createInstaller(name, claude) {
  const paneId = installerPaneOf(name);
  let page;
  let isOpen = false;
  const show = async (build2, cancelled) => {
    page?.cancel();
    const answer = new Promise((resolve2) => {
      const done = (value) => {
        if (page === shown)
          page = undefined;
        resolve2(value);
      };
      const shown = { ...build2(done), cancel: () => done(cancelled) };
      page = shown;
    });
    if (!isOpen) {
      isOpen = true;
      await claude().ui.open({ id: paneId, title: `Install ${name}`, focus: true, holdToasts: true, closeOnEscape: true });
    }
    claude().ui.invalidate("ui.render");
    return answer;
  };
  const frame = (title, body, actions) => Box({ flexDirection: "column", gap: 1, paddingX: 1, children: [Text({ bold: true, children: title }), ...body, Box({ gap: 3, children: actions })] });
  const bullet = (text) => Text({ children: [Text({ color: "claude", children: "◆ " }), text] });
  return {
    draws: (e) => e.component === "Pane" && e.requestId === paneId,
    draw(e) {
      return drawWith(claude().ui.resolve(e), () => page?.draw(e.props) ?? Text({ dimColor: true, children: `${name} is installing.` }));
    },
    closed(id) {
      if (id !== paneId)
        return;
      isOpen = false;
      page?.cancel();
    },
    consent({ install, uninstall, keys, permissions, updates }) {
      const changes = [
        ...install === "" ? [] : [`Run ${install} now${uninstall === "" ? "" : `, and ${uninstall} when you remove it`}`],
        ...install === "" && uninstall !== "" ? [`Run ${uninstall} when you remove it`] : [],
        ...keys === "" ? [] : [`Bind ${keys}`],
        ...updates === undefined ? [] : [`Update ${name} automatically from the ${updates} marketplace`]
      ];
      return show((answer) => ({
        draw: () => frame(`${name} wants to:`, [
          ...permissions.length === 0 ? [] : [Box({ flexDirection: "column", children: permissions.map((item) => bullet(permissionWords(item))) })],
          ...changes.length === 0 ? [] : [Text({ children: permissions.length === 0 ? "Change your computer:" : "and change your computer:" }), Box({ flexDirection: "column", children: changes.map(bullet) })],
          Text({ dimColor: true, children: "You can turn each permission off later in /mods." })
        ], [Button({ key: "not-now", hotkey: "n", label: "Not now", onPress: () => answer(false) }), Button({ key: "accept", hotkey: "a", label: "Accept", onPress: () => answer(true) })])
      }), false);
    },
    options(missing, save) {
      const saved = new Map;
      const failures = new Map;
      return show((answer) => ({
        draw: () => frame(`${name} needs ${missing.length === 1 ? "one setting" : `${missing.length} settings`}:`, missing.map(([key, option]) => {
          const label = Text({ children: [Text({ bold: true, children: option.title }), option.description === "" ? "" : Text({ dimColor: true, children: `  ${option.description}` })] });
          if (option.type === "secret")
            return Box({ flexDirection: "column", children: [label, Text({ dimColor: true, children: `Set it in /config, where Claude Code keeps it in your keychain, then press Next.` })] });
          const failure = failures.get(key);
          const field = Input({
            key: `option:${key}`,
            label: "› ",
            placeholder: option.type === "choice" ? (option.choices ?? []).join(", ") : option.type === "toggle" ? "true or false" : option.type === "list" ? "comma-separated" : "",
            value: saved.get(key) ?? "",
            submitLabel: "save",
            onSubmit: (value) => void save(key, value).then((refused) => {
              if (refused === undefined) {
                saved.set(key, value);
                failures.delete(key);
              } else
                failures.set(key, refused);
            }).catch((error) => failures.set(key, messageOf(error))).finally(() => claude().ui.invalidate("ui.render"))
          });
          const status = failure !== undefined ? Text({ color: "error", children: failure }) : saved.has(key) ? Text({ color: "success", children: "✔ saved" }) : Text({ children: "" });
          return Box({ flexDirection: "column", children: [label, field, status] });
        }), [Button({ key: "not-now", hotkey: "n", label: "Not now", onPress: () => answer(false) }), Button({ key: "next", hotkey: "x", label: "Next", onPress: () => answer(true) })])
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
            body = Text({ color: "error", children: `The ${step.title} step could not draw: ${messageOf(error)}` });
          }
          const next = async () => {
            try {
              if (await step.isDone(mod))
                return answer(true);
              notice = { color: "warning", text: `Finish ${step.title} first.` };
            } catch (error) {
              notice = { color: "error", text: `The ${step.title} step's isDone failed: ${messageOf(error)}` };
            }
            claude().ui.invalidate("ui.render");
          };
          return frame(`${step.title}  (${index} of ${total})`, [body, ...notice === undefined ? [] : [Text({ color: notice.color, children: notice.text })]], [Button({ key: "not-now", hotkey: "n", label: "Not now", onPress: () => answer(false) }), Button({ key: "next", hotkey: "x", label: index === total ? "Finish" : "Next", onPress: () => void next() })]);
        }
      }), false);
    },
    async close() {
      page = undefined;
      if (!isOpen)
        return;
      isOpen = false;
      await claude().ui.close({ id: paneId });
    }
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
  let values = merged(declared, fromClaude, {}, new Set);
  let locked;
  let loadedRoot;
  const readLocked = async () => {
    if (Object.keys(declared).length === 0)
      return new Set;
    const rows = await claude.config.list().catch((error) => {
      claude.ui.log(`${name} could not read /config, so a project's options.json may override a value your organization set: ${messageOf(error)}`, { to: "debug" });
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
    const ignore = (reason) => report({ id: `options:${path} ${reason}`, message: `Ignores part of ${path}`, description: `${path} ${reason}` });
    let file;
    try {
      file = JSON.parse(await claude.fs.read(path));
    } catch (error) {
      ignore(`is not JSON (${messageOf(error)}). Fix the file; ${name} uses its other options until then.`);
      return {};
    }
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      ignore('is not a JSON object. Write one, such as { "branch": "main" }.');
      return {};
    }
    const kept = {};
    for (const [key, value] of Object.entries(file)) {
      const option = declared[key];
      if (option === undefined)
        ignore(`sets ${key}, which ${name} does not declare. ${Object.keys(declared).length === 0 ? "Remove it." : `Remove it, or use one of: ${Object.keys(declared).join(", ")}.`}`);
      else if (option.type === "secret")
        ignore(`sets ${key}, a secret, and a project file is committed for everyone to read. Remove it, and set it in /config.`);
      else {
        const misfit = fitsOption(option, value);
        if (misfit === undefined)
          kept[key] = value;
        else
          ignore(`sets ${key} to ${JSON.stringify(value)}, and ${option.title} ${misfit}.`);
      }
    }
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
      const next = merged(declared, fromClaude, project, locked);
      if (!isFirst && JSON.stringify(next) === JSON.stringify(values))
        return;
      values = next;
      if (!isFirst)
        changed();
    }
  };
}
function merged(declared, fromClaude, project, locked) {
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
function createRouter() {
  const hooks = new Map;
  return {
    add(event, hook) {
      const erased = hook;
      hooks.set(event, [...hooks.get(event) ?? [], erased]);
      return {
        dispose() {
          const chain = (hooks.get(event) ?? []).filter((each) => each !== erased);
          if (chain.length === 0)
            hooks.delete(event);
          else
            hooks.set(event, chain);
        }
      };
    },
    has: (event) => hooks.has(event),
    dispatch(event, e, next) {
      const chain = hooks.get(event);
      const call = async (index, current2) => {
        const hook = chain?.[index];
        if (hook === undefined)
          return next(current2);
        return hook(current2, (passed) => call(index + 1, passed));
      };
      return call(0, e);
    }
  };
}

// node_modules/@cmodjs/core/runtime/state.js
var lifetimes = ["memory", "session", "project", "global"];
var keptProjects = 20;
var listeners = new WeakMap;
async function sessionsWith(claude, name, key, value) {
  const prefix = `${name}.${key}.sessions.`;
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
  const current2 = copied(declared);
  let projectRoot = root;
  let sessionId = session;
  let turn = Promise.resolve();
  const inTurn = (task) => {
    const run = turn.then(task);
    turn = Promise.allSettled([run]);
    return run;
  };
  const ownersKey = (lifetime, key) => `${name}.${key}.${lifetime === "project" ? "projects" : "sessions"}.`;
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
  const forgetEndedSessions = async (current3) => {
    const stored = await claude.store.keys();
    const ended = async (recorded) => {
      const transcript = await claude.store.get(recorded);
      return typeof transcript !== "string" || !await claude.fs.exists(transcript);
    };
    const owners = stored.filter((key) => key.startsWith(transcriptsKey) && key !== `${transcriptsKey}${current3}`);
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
      current2[lifetime][key] = saved === undefined ? declared[lifetime][key] : frozen(name, `${lifetime}.${key}`, saved);
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
  const group = (lifetime) => new Proxy(current2[lifetime], {
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
          report({ id: `state:${lifetime}.${key}`, message: `Could not keep state.${lifetime}.${key}. Keep only JSON data in mod.state`, error });
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
var githubRepository = /^https:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:\/issues)?\/?$/;
var linkLimit = 2048;
var hiddenKey = "cmod:hidden-failures";
var defaultDuration = 4000;
var visibleToasts = 3;
var spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
var spinnerMs = 100;
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
  claude.store.get(hiddenKey).then((saved) => {
    if (typeof saved !== "object" || saved === null)
      return;
    for (const [id, hides] of Object.entries(saved))
      if (typeof hides === "string" && !hidden.has(id))
        hidden.set(id, hides);
  }, (error) => claude.ui.log(`${name}: could not read the failures you hid: ${messageOf(error)}`, { to: "debug" }));
  let lastId = 0;
  let frame = 0;
  let spinning;
  let isHeld = false;
  let showsAll = false;
  let bandId;
  const changed = () => {
    const isLoading = [...entries.values()].some((entry) => entry.type === "loading" || entry.trying !== undefined);
    if (isLoading && spinning === undefined) {
      spinning = claude.clock.every(spinnerMs, () => {
        frame += 1;
        claude.ui.invalidate("ui.render");
      });
    }
    if (!isLoading && spinning !== undefined) {
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
    const entry = { id, type, message, options, actions, ...hides === undefined ? {} : { hides }, isOpen: previous?.isOpen ?? false, reporting, timer: undefined };
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
    claude.store.set(hiddenKey, Object.fromEntries(hidden)).catch((error) => claude.ui.log(`${name}: could not remember the failure you hid: ${messageOf(error)}`, { to: "debug" }));
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
    const copied2 = await claude.ui.copy({ text });
    if (!copied2.isCopied)
      throw new Error(copied2.reason);
  };
  const press = (entry, run) => () => void Promise.resolve().then(run).catch((error) => fail({ id: `press:${entry.id}`, message: `${entry.message}: the press failed`, error }));
  const fail = ({ id, message, error, description = error === undefined ? undefined : describe(error), retry }) => {
    const hides = `${version() ?? ""}
${message}
${error === undefined ? "" : describe(error)}`;
    if (hidden.get(id) === hides)
      return id;
    hidden.delete(id);
    const stack = error instanceof Error && error.stack !== undefined ? `

${error.stack}` : "";
    const details = async () => {
      const modVersion = await claude.fs.read(`${claude.plugin.root}/.claude-plugin/plugin.json`).then((text) => String(JSON.parse(text).version)).catch((failure) => `unknown (${messageOf(failure)})`);
      return `${name} ${modVersion}, @cmodjs/core ${coreVersion}
${message}${description === undefined ? "" : `
${description}`}${stack}`;
    };
    const startReporting = async () => {
      const shown = entries.get(id);
      if (shown === undefined)
        return;
      shown.reporting = { contact: await contactOf(claude), details: await details() };
      disarm(shown);
      changed();
      if (bandId === undefined)
        return;
      const focused = await claude.ui.focus({ requestId: bandId, key: `toast:${id}:ask-claude` });
      if ("deny" in focused)
        claude.ui.log(`${name}: the Report choices did not take the keys: ${String(focused.deny)}`, { to: "debug" });
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
    const actions = [...retry === undefined ? [] : [{ label: "Retry", onClick: tryAgain }], { label: "Report", onClick: startReporting }];
    return put("error", message, { id, ...description === undefined ? {} : { description }, duration: Infinity }, actions, hides);
  };
  const toggle = (entry) => () => {
    entry.isOpen = !entry.isOpen;
    disarm(entry);
    changed();
  };
  const row = (entry) => {
    const { description } = entry.options;
    const isText = typeof description === "string";
    const icon = entry.type === "loading" || entry.trying !== undefined ? { glyph: spinner[frame % spinner.length], color: "claude" } : icons[entry.type];
    const message = isText ? Button({ plain: true, key: `toast:${entry.id}:open`, label: entry.message, onPress: toggle(entry) }) : Text({ children: entry.message });
    const details = !isText ? description : Text({ dimColor: true, wrap: entry.isOpen ? "wrap" : "truncate-end", children: entry.isOpen ? description : firstLine(description) });
    const fixed = (child) => Box({ flexShrink: 0, children: child });
    const close = Button({ plain: true, dimColor: true, key: `toast:${entry.id}:close`, label: entry.hides === undefined ? "✕" : "Hide", onPress: () => hide(entry) });
    const actions = entry.actions.map((action, index) => Button({ plain: true, key: `toast:${entry.id}:${index === 0 ? "action" : `action-${index}`}`, label: action.label, onPress: press(entry, action.onClick) }));
    const buttons = Box({ gap: 2, flexWrap: "wrap", children: [...actions, close] });
    const trying = entry.trying === undefined ? undefined : Box({ gap: 1, children: [Text({ dimColor: true, children: "Trying again:" }), typeof entry.trying === "string" ? Text({ dimColor: true, wrap: "truncate-end", children: entry.trying }) : entry.trying] });
    const text = details === undefined ? [message] : [message, trying ?? details];
    const under = trying !== undefined && details === undefined ? [trying] : entry.reporting === undefined ? [buttons] : reportChoices(entry, entry.reporting);
    return Box({
      gap: 2,
      children: [
        fixed(Text({ ...icon.color === undefined ? {} : { color: icon.color }, children: icon.glyph })),
        fixed(Text({ dimColor: true, children: name })),
        Box({ flexDirection: "column", flexGrow: 1, flexShrink: 1, children: entry.hides === undefined ? text : [...text, ...under] }),
        ...entry.hides === undefined ? [...actions.map(fixed), fixed(close)] : []
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
      const copied2 = await claude.ui.copy({ text: details });
      say(copied2.isCopied ? "Copied the error." : `Could not copy it: ${copied2.reason}`);
    };
    const report = contact === undefined ? [] : [Link({ href: reportLink(contact, name, entry.message, details), label: contact.kind === "github" ? "Report it on GitHub (opens your browser)" : "Email the author (opens your mail app)" })];
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
    get shown() {
      return [...entries.values()].map(({ type, message, options }) => ({ type, message, ...typeof options.description === "string" ? { description: options.description } : {} }));
    },
    draw(drawn, table, band, drawnIn) {
      bandId = drawnIn;
      isHeld = band.hasSurvey === true;
      if (isHeld || entries.size === 0)
        return drawn;
      const all = [...entries.values()];
      const hidden2 = showsAll ? 0 : Math.max(all.length - visibleToasts, 0);
      for (const entry of all.slice(hidden2))
        arm(entry);
      const more = Button({
        plain: true,
        dimColor: true,
        key: "toasts:more",
        label: `+${hidden2} more`,
        onPress: () => {
          showsAll = true;
          changed();
        }
      });
      return drawWith(table, () => Box({ flexDirection: "column", children: [drawn, ...hidden2 > 0 ? [more] : [], ...all.slice(hidden2).map(row)] }));
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
  const linkOf = (body2) => contact.kind === "github" ? `https://github.com/${contact.repository}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body2)}` : `mailto:${contact.address}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body2)}`;
  let body = details;
  while (linkOf(body).length > linkLimit && body.length > 0)
    body = `${body.slice(0, Math.floor(body.length * 0.8))}…`;
  return linkOf(body);
}
function reportPrompt(name, contact, details) {
  const where = contact === undefined ? `${name} names no place to report it, so find its author from its plugin.json or its marketplace.` : contact.kind === "github" ? `Report it as an issue on https://github.com/${contact.repository}.` : `Email it to ${contact.address}.`;
  return `The ${name} mod failed. Report it to its author. ${where} First check whether it is reported already, and add to that report instead of filing a new one. Show me the report before you post it.

${details}`;
}

// node_modules/@cmodjs/core/runtime/ui.js
var bullet = "⏺";
var sizeKeys = ["columns", "rows"];
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
  const merged2 = { ...props, ...given };
  return isFirst || !("isFirstOfReply" in merged2) ? merged2 : { ...merged2, isFirstOfReply: false };
}
function threw(error) {
  return `threw, so Claude Code draws its own: ${messageOf(error)}`;
}
async function drawComponent(table, draw, drawDefault) {
  const calls = [];
  let first;
  try {
    first = drawWith(table, () => draw(({ children, ...props }) => {
      const drawing2 = Box({});
      calls.push({ given: props, drawing: drawing2 });
      return drawing2;
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
  const spaced = pieces.map(({ drawing: drawing2, isClaudesRow }, index) => (index > 0 || place === "inReply") && !isClaudesRow ? Box({ marginTop: 1, children: drawing2 }) : drawing2);
  const column = (drawings) => Box({ flexDirection: "column", children: drawings });
  const [opening, ...rest] = spaced;
  if (place !== "opensReply" || opening === undefined)
    return column(spaced);
  if (pieces[0]?.isClaudesRow !== true)
    return Box({ children: [Box({ minWidth: 2, children: Text({ color: "text", children: bullet }) }), column(spaced)] });
  return column([opening, Box({ paddingLeft: 2, children: column(rest) })]);
}
function createUi({ name, claude, router, toaster, report, announce, mod }) {
  const panes = new Map;
  const paneLogs = new Map;
  const openPanes = new Set;
  const paneStates = new Map;
  const syncPanes = async () => {
    for (const open of await claude.ui.panes()) {
      if (!panes.has(open.id))
        continue;
      if (open.isPlaced)
        openPanes.add(open.id);
      paneStates.set(open.id, { isShown: open.isShown, isFocused: open.isFocused });
    }
  };
  const readPanes = () => void syncPanes().catch((error) => claude.ui.log(`${name} keeps its panes' shown and focused state from before: ${messageOf(error)}`, { to: "debug" }));
  const requestedSizes = new Map;
  const renders = new Set;
  const markdownRenders = new Map;
  let read;
  let isRouted = false;
  let isResizeQueued = false;
  const logOnce = (what) => {
    let hasLogged = false;
    return (failure) => {
      if (!hasLogged)
        report({ id: `render:${what}`, message: `The ${what} render failed`, description: failure });
      hasLogged = true;
    };
  };
  const renderOf = (type) => markdownRenders.get(type);
  const markdownIn = (table) => {
    const reader = read;
    if (reader === undefined)
      return;
    return (props) => {
      const pieces = reader(props.text, renderOf);
      if (pieces.every((piece) => ("text" in piece)))
        return table.Markdown(props);
      const drawClaudes = (text) => table.Markdown({ ...props, text });
      const drawings = pieces.map((piece) => {
        if ("text" in piece)
          return drawClaudes(piece.text);
        const { render, props: block } = piece;
        try {
          return drawWith(table, () => render.Component({ ...block, Default: ({ source = block.source }) => drawClaudes(source) }));
        } catch (error) {
          render.log(threw(error));
          return drawClaudes(block.source);
        }
      });
      return drawPieces(drawings.map((drawing2) => ({ drawing: drawing2, isClaudesRow: false })), "pane");
    };
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
        const component = await drawComponent(table, (Default) => render.Component({ ...block, Default }), ({ source = block.source }, isClaudesRow) => drawClaudes(source, index === 0 && isClaudesRow));
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
      claude.ui.log(`${name}: the ${pane.title} pane kept its size: ${messageOf(error)}`, { to: "debug" });
    }
  };
  const route = () => {
    if (isRouted)
      return;
    isRouted = true;
    router.add("ui.render", (e, next) => {
      const pane = panes.get(e.requestId);
      if (pane === undefined || e.component !== "Pane")
        return next(e);
      openPanes.add(pane.id);
      paneStates.set(pane.id, { isShown: true, isFocused: e.props.isFocused });
      readPanes();
      const table = claude.ui.resolve(e);
      try {
        return drawWith(table, () => pane.render(mod(), e.props), markdownIn(table));
      } catch (error) {
        paneLogs.get(pane.id)?.(`threw: ${messageOf(error)}`);
        return drawWith(table, () => Text({ color: "error", children: `The ${pane.title} pane could not draw: ${messageOf(error)}` }));
      }
    });
    router.add("ui.scroll", async (e, next) => {
      const pane = panes.get(e.requestId);
      const moved = await next(e);
      if (pane?.onScroll === undefined || e.component !== "Pane" || moved.deny !== undefined)
        return moved;
      await handle(pane, "onScroll", () => pane.onScroll?.(mod(), e));
      return moved;
    });
    router.add("ui.close", async (e, next) => {
      openPanes.delete(e.id);
      paneStates.delete(e.id);
      readPanes();
      const closed = await next(e);
      const pane = panes.get(e.id);
      if (pane?.onClose !== undefined)
        await handle(pane, "onClose", () => pane.onClose?.(mod(), e));
      return closed;
    });
  };
  const handle = async (pane, handler, run) => {
    try {
      await run();
    } catch (error) {
      report({ id: `pane:${pane.id}:${handler}`, message: `The ${pane.title} pane's ${handler} threw`, error });
    }
  };
  return {
    ui: {
      pane(pane) {
        if (panes.has(pane.id))
          throw new Error(`${name}: the pane "${pane.id}" is already added. Give each pane its own id.`);
        panes.set(pane.id, pane);
        paneLogs.set(pane.id, logOnce(`${pane.title} pane`));
        announce(`the ${pane.title} pane`);
        route();
        const handle2 = {
          get isOpen() {
            return openPanes.has(pane.id);
          },
          get isShown() {
            return paneStates.get(pane.id)?.isShown ?? false;
          },
          get isFocused() {
            return paneStates.get(pane.id)?.isFocused ?? false;
          },
          async open(options) {
            const { isPlaced } = await openAt(pane, paneSize(pane, mod().state), options?.focus);
            if (isPlaced)
              openPanes.add(pane.id);
            await syncPanes();
          },
          async close() {
            await claude.ui.close({ id: pane.id });
            openPanes.delete(pane.id);
            paneStates.delete(pane.id);
            await syncPanes();
          },
          toggle: (options) => openPanes.has(pane.id) ? handle2.close() : handle2.open(options)
        };
        return handle2;
      },
      render(place, Component) {
        const target = place;
        const markdown2 = typeof target === "string" ? undefined : target;
        const component = componentOf(place);
        if (markdown2 === undefined && component === undefined)
          throw new Error(`${name}: ${String(place)} is not a place render draws, such as ToolCall or CodeBlock.`);
        const feature = `a render of ${nameOf(place)}`;
        if (renders.has(feature))
          throw new Error(`${name}: ${feature} is already added. Render each place once.`);
        renders.add(feature);
        announce(feature);
        if (markdown2 !== undefined) {
          const markdownType = markdown2.markdown;
          markdownRenders.set(markdownType, { Component, log: logOnce(nameOf(place)) });
          routeMarkdown(markdown2.createReader);
          return {
            dispose() {
              markdownRenders.delete(markdownType);
              renders.delete(feature);
              claude.ui.invalidate("ui.render");
            }
          };
        }
        const log = logOnce(nameOf(place));
        const drawing2 = router.add("ui.render", async (e, next) => {
          if (e.component !== component)
            return next(e);
          const table = claude.ui.resolve(e);
          const drawn = await drawComponent(table, (Default) => Component({ ...e.props, Default }), (given, isClaudesRow) => next({ ...e, props: pieceProps(e.props, given, isClaudesRow) }));
          if ("failure" in drawn) {
            log(drawn.failure);
            return next(e);
          }
          if (e.component !== "AssistantMessage")
            return drawn.drawing;
          return drawWith(table, () => drawPieces([drawn], e.props.isFirstOfReply ? "opensReply" : "inReply"));
        });
        return {
          dispose() {
            drawing2.dispose();
            renders.delete(feature);
            claude.ui.invalidate("ui.render");
          }
        };
      },
      toast: toaster.toast,
      copy: toaster.copy,
      ask: (question, options) => claude.ui.ask(question, options),
      scroll: (args) => claude.ui.scroll(args)
    },
    changed() {
      if (panes.size === 0 && renders.size === 0)
        return;
      claude.ui.invalidate("ui.render");
      if (isResizeQueued)
        return;
      isResizeQueued = true;
      Promise.resolve().then(() => {
        isResizeQueued = false;
        for (const pane of panes.values()) {
          if (openPanes.has(pane.id))
            resize(pane);
        }
      });
    },
    async restorePanes() {
      if (panes.size > 0)
        await syncPanes();
    }
  };
}

// node_modules/@cmodjs/core/ui/components.js
function Tabs({ tabs, selected, onSelect, children }) {
  const row = tabs.map((tab, index) => {
    const hotkey = index < 9 ? `${index + 1}` : undefined;
    return tab.key === selected ? Text({ children: [...hotkey === undefined ? [] : [Text({ color: "claude", children: hotkey }), ": "], Text({ bold: true, underline: true, children: tab.label })] }) : Button({ plain: true, dimColor: true, key: `tab:${tab.key}`, ...hotkey === undefined ? {} : { hotkey }, label: tab.label, onPress: () => onSelect(tab.key) });
  });
  return Box({ flexDirection: "column", gap: 1, children: [Box({ gap: 3, children: row }), children] });
}
function Progress({ value, width = 24 }) {
  const filled = Math.round(Math.min(Math.max(value, 0), 100) / 100 * width);
  return Text({ children: [Text({ color: "claude", children: "█".repeat(filled) }), Text({ color: "subtle", children: "░".repeat(width - filled) })] });
}

// node_modules/@cmodjs/core/runtime/lifecycle.js
var announcedKey = "cmod:announced";
var installId = "cmod:install";
var installRetrySeconds = [2, 4, 8, 16, 32, 64, 128];
var cmodCheckMs = 1000;
var cmodWaitMs = 60000;
var cmodSlowCheckMs = 1e4;
var startHoldMs = 1e4 - 1000;
var dependencyCallMs = 30000;
var cannotStart = /failed to start: /;
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
  const declared = steps.permissions ?? [];
  if (name === cmodPluginName) {
    const installed = await cmodVersion(claude);
    return { name, root, version, store, steps, granted: declared, isInstalled: version !== undefined && installed !== undefined && isAtLeast(installed, version), shouldRecord: false };
  }
  const approved = parseConsent(await readJson(read, consentPath(store)), consentPath(store))[name] ?? [];
  const plugin = { name, root, version, store, steps, granted: declared.filter((item) => approved.includes(item)) };
  const record = await readRecord(read, store, name);
  if (Object.keys(steps).length === 0)
    return { ...plugin, isInstalled: true, shouldRecord: record?.version !== version };
  const scripts = await scriptsSha256(steps, {
    read: (path) => read(`${root}/${path}`),
    list: (folder) => filesBelow(claude, `${root}/${folder}`)
  });
  return { ...plugin, isInstalled: version !== undefined && record?.version === version && record.scriptsSha256 === scripts, shouldRecord: false };
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
async function cmodVersion(claude) {
  const result = await claude.process.run(["cmod", "--version"]).catch((error) => {
    if (cannotStart.test(messageOf(error)))
      return;
    throw error;
  });
  if (result === undefined)
    return;
  if (result.exitCode !== 0)
    throw new Error(`cmod --version ${formatExit(result.exitCode, lastLineOf(result.stderr) ?? "")}`);
  return result.stdout.trim().split(/\s+/).at(-1);
}
function createLifecycle(definition, permissionRoutes = () => {
  return;
}, options = {}, asksPerson = true) {
  let router = createRouter();
  let phase = "starting";
  let runtime;
  let programs;
  let plugin;
  const granted = new Set;
  let activation;
  let mod;
  let imports;
  let raise;
  let failure;
  let pluginOptions = options;
  const installer = createInstaller(definition.name, () => claude());
  let shouldRecord = false;
  let recording;
  let missedSessionStart;
  let settleStart = () => {
    return;
  };
  const startSettled = new Promise((resolve2) => settleStart = resolve2);
  const claude = () => {
    if (runtime === undefined)
      throw new Error(`${definition.name}: the lifecycle has not started. registerMod(addHook, mod, options) starts it at session.start.`);
    return runtime.claude;
  };
  const installing = (description) => runtime?.toaster.toast.loading("Installing", { id: installId, ...description === undefined ? {} : { description } });
  const toastFailure = (shown) => runtime?.toaster.fail(shown);
  const fail = (reason, fix, retry) => {
    phase = "failed";
    failure ??= new Error(`${definition.name}: ${reason}${/[.!?]$/.test(reason) ? "" : "."}${fix === undefined ? "" : ` ${fix}`}`);
    const again = retry === undefined ? {} : { retry: () => (failure = undefined, stopRetrying(), retry().catch(report)) };
    toastFailure({ id: installId, message: reason, ...fix === undefined ? {} : { description: fix }, ...again });
  };
  let consented;
  const installAgain = () => install(consented);
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
  const checkoutState = async () => {
    if (plugin === undefined)
      return;
    const lines = [];
    const { code } = await readLines(claude().process.spawn({ argv: ["sh", "-c", "git rev-parse HEAD && git status --porcelain=v1 -uall && git diff HEAD"], cwd: plugin.root }), (text) => void lines.push(text));
    return code === 0 ? lines.join(`
`) : undefined;
  };
  const failInstall = async (reason, when) => {
    if (when === undefined) {
      stopRetrying();
      return fail(reason, undefined, installAgain);
    }
    retryLater({ when, tries: retrying?.when === when ? retrying.tries : 0, checkout: when === "changed" ? await checkoutState() : undefined, reason });
  };
  const retryInBackground = async () => {
    const waiting = retrying;
    if (phase !== "failed" || waiting === undefined)
      return;
    if (await recover()) {
      stopRetrying();
      return whenActive();
    }
    if (waiting.when === "changed" && waiting.checkout !== undefined && await checkoutState() === waiting.checkout)
      return retryLater(waiting);
    await install(consented, true);
    await whenActive();
  };
  const finish2 = async () => {
    await programs?.refresh();
    phase = "ready";
    claude().ui.invalidate("ui.render");
  };
  const recordThroughCmod = async () => {
    if (plugin === undefined || await cmodVersion(claude()) === undefined)
      return;
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ["cmod", "setup", plugin.root, "--events"] }), (text) => {
      if (parseEvent(text).type === "done")
        shouldRecord = false;
    });
    if (shouldRecord)
      throw new Error(`cmod setup ${formatExit(code, lastError)}`);
  };
  const record = () => {
    recording ??= recordThroughCmod().catch((error) => claude().ui.log(`${definition.name} has no cmod record yet: ${messageOf(error)}`, { to: "debug" })).finally(() => {
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
    for (const [index, step] of steps.entries()) {
      if (await isStepDone(active, step))
        continue;
      const isAnswered = (await claude().session.surfaces()).length > 0 && await installer.step(active, step, index + 1, steps.length);
      if (!isAnswered) {
        runtime?.toaster.toast.warning(steps.length - index === 1 ? "Needs one more step" : `Needs ${steps.length - index} more steps`, {
          id: "cmod:steps",
          description: `Starting with ${step.title}. Finish them in /mods ${definition.name}.`,
          duration: Infinity,
          action: { label: "Finish", onClick: () => active.settings.open() }
        });
        break;
      }
    }
    await installer.close();
  };
  const activate = async () => {
    if (runtime === undefined || plugin === undefined)
      return;
    const activeRouter = createRouter();
    const active = await createMod(definition, { ...runtime, router: activeRouter, dataFolder: dataFolder(plugin.store, plugin.name), store: plugin.store, steps: plugin.steps, granted, refreshGrants, permissionRoutes, options: pluginOptions }).catch(async (error) => {
      if (error instanceof MissingOptions && await askOptions(error))
        return;
      fail(messageOf(error), error instanceof MissingOptions ? `Set ${error.keys.length === 1 ? "it" : "them"} in /config.` : undefined, begin);
      throw error;
    });
    if (active === undefined)
      return activate();
    const { added } = active;
    mod = active.mod;
    imports = active.imports;
    raise = active.raise;
    router = activeRouter;
    phase = "active";
    runtime.claude.ui.invalidate("ui.render");
    runSteps(active.mod).catch((error) => toastFailure({ id: "cmod:steps", message: "Its installer stopped", error }));
    const missed = missedSessionStart;
    missedSessionStart = undefined;
    const replay = (e) => definition.name === cmodPluginName ? activeRouter.dispatch("classic.SessionStart", e, async () => ({})) : checkedRoute("classic.SessionStart", e, async () => ({}));
    const lateAnswer = missed === undefined ? {} : await replay(missed).catch((error) => {
      toastFailure({ id: "classic.SessionStart", message: "The SessionStart hook failed", error });
      return {};
    });
    const { additionalContext, ...unread } = lateAnswer;
    for (const text of additionalContext ?? []) {
      const added2 = await runtime.claude.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
      if (added2.deny !== undefined)
        runtime.claude.ui.log(`${definition.name}: Claude Code refused its SessionStart note: ${added2.deny}`, { to: "debug" });
    }
    if (Object.keys(unread).length > 0) {
      runtime.claude.ui.log(`${definition.name} started after Claude Code's SessionStart, so Claude Code did not read ${Object.keys(unread).join(", ")} from its SessionStart hooks.`, { to: "debug" });
    }
    const version = plugin.version ?? "";
    const announced = announcedOf(await runtime.claude.store.get(announcedKey));
    if (announced?.version === version) {
      runtime.toaster.toast.dismiss(installId);
      return;
    }
    await runtime.claude.store.set(announcedKey, { version, added });
    const { toaster } = runtime;
    announcementOf(runtime.claude, plugin, granted, added, announced).then(({ message, ...options2 }) => toaster.toast.success(message, { id: installId, duration: announcementMs, ...options2 })).catch((error) => toastFailure({ id: installId, message: "Could not say what it installed", error }));
  };
  const updatesToShow = async () => {
    const [home, configHome] = await Promise.all([claude().env.home(), claude().env.configHome()]);
    const configRoot = configHome ?? `${home ?? ""}/.claude`;
    const known = await claude().fs.read(`${configRoot}/plugins/known_marketplaces.json`).then((text) => JSON.parse(text)).catch(ifMissing(undefined));
    return updatesToTurnOn(marketplaceOf(claude().plugin.root, claude().plugin.name), await claude().settings.read({ source: "user" }), known);
  };
  const askConsent = async (event) => {
    const name = definition.name;
    if ((await claude().session.surfaces()).length === 0) {
      claude().ui.log(`${name} waits for consent to run ${event.install}. Run cmod install ${name} in a terminal.`);
      return;
    }
    runtime?.toaster.toast.info("Installing", { id: installId, description: "Waiting for your answer", duration: Infinity });
    const updates = await updatesToShow().catch((error) => {
      toastFailure({ id: "cmod:updates", message: "Could not read whether its marketplace updates automatically", error });
      return;
    });
    const isAccepted = await installer.consent({ ...event, updates });
    await installer.close();
    if (isAccepted) {
      consented = event.sha256;
      return install(consented);
    }
    phase = "declined";
    runtime?.toaster.toast("Not installed", { id: installId, description: "Install it whenever you like.", duration: Infinity, action: { label: "Install", onClick: () => install().catch(report) } });
  };
  const install = async (consent, isQuiet = false) => {
    if (plugin === undefined)
      return;
    if (plugin.name === cmodPluginName)
      return bootstrap(plugin.root);
    phase = "installing";
    const found = await cmodVersion(claude());
    if (!fits(found))
      return waitForcmod(found);
    if (!isQuiet)
      installing();
    let outcome;
    let retries;
    const argv = ["cmod", "setup", plugin.root, "--events", ...consent === undefined ? [] : ["--consent", consent]];
    const { code, lastError } = await readLines(claude().process.spawn({ argv }), (text) => {
      const event = parseEvent(text);
      if (event.type === "progress" && !isQuiet)
        installing(progressOf(event));
      if (event.type === "retries")
        retries = event.when;
      if (event.type === "done" || event.type === "failed" || event.type === "needs-consent")
        outcome = event;
    });
    if (outcome?.type === "done") {
      stopRetrying();
      for (const item of plugin.steps.permissions ?? [])
        granted.add(item);
      return finish2();
    }
    if (outcome?.type === "needs-consent")
      return askConsent(outcome);
    return failInstall(outcome?.type === "failed" ? outcome.message : `cmod setup ${formatExit(code, lastError)}`, retries);
  };
  const fits = (found) => found !== undefined && isAtLeast(found, oldestCmodFor(plugin?.steps ?? {}));
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
      check ??= cmodVersion(claude()).then((version) => {
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
      installing(latest === undefined ? "Still waiting for cmod to download cmod. See cmod's own line." : `PATH finds cmod ${latest}, and ${definition.name} needs cmod ${oldestCmodFor(plugin?.steps ?? {})} or later. Run npm i -g @cmodjs/cli, or put ~/.local/bin ahead of the old cmod on PATH.`);
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
      return finish2();
    fail(`bootstrap ${formatExit(code, lastError)}`, undefined, () => bootstrap(root));
  };
  const begin = async () => {
    if (readStarted === undefined)
      return;
    const started = await readStarted(claude());
    plugin = started;
    for (const item of started.granted)
      granted.add(item);
    consentMs = await stampOf(consentPath(started.store));
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
      fail(messageOf(error), undefined, begin);
  };
  let consentMs = 0;
  const stampOf = async (path) => {
    const stat = await claude().fs.stat(path).catch(ifMissing(undefined));
    return stat?.kind === "file" ? stat.mtimeMs : 0;
  };
  let recordMs = 0;
  let readStarted;
  const recover = async () => {
    if (plugin === undefined || readStarted === undefined || phase !== "failed" && phase !== "declined")
      return false;
    const modifiedMs = await stampOf(recordPath(plugin.store, plugin.name));
    if (modifiedMs === recordMs)
      return false;
    recordMs = modifiedMs;
    const current2 = await readStarted(claude());
    if (!current2.isInstalled)
      return false;
    plugin = current2;
    failure = undefined;
    activation = undefined;
    await refreshGrants();
    await finish2();
    return true;
  };
  const refreshGrants = async () => {
    if (plugin === undefined || plugin.name === cmodPluginName)
      return;
    const path = consentPath(plugin.store);
    const modifiedMs = await stampOf(path);
    if (modifiedMs === consentMs)
      return;
    consentMs = modifiedMs;
    const approved = modifiedMs === 0 ? [] : parseConsent(JSON.parse(await claude().fs.read(path)), path)[plugin.name] ?? [];
    granted.clear();
    for (const item of plugin.steps.permissions ?? []) {
      if (approved.includes(item))
        granted.add(item);
    }
  };
  const droppedParts = new Set;
  const answerCheck = {
    get plugin() {
      return plugin?.name ?? definition.name;
    },
    isGranted: (item) => isCovered(granted, item, undefined),
    dropped(item, part) {
      if (droppedParts.has(item))
        return;
      droppedParts.add(item);
      const declared = plugin?.steps.permissions ?? [];
      const fix = declared.includes(item) ? `Turn it on in /mods ${definition.name}.` : `It needs "permissions": { "${item}": true } in package.json "cmod".`;
      runtime?.toaster.toast.warning(`Answered ${part} without your grant to "${permissionWords(item)}", so cmod dropped it`, { id: `dropped:${item}`, description: fix, duration: Infinity });
    }
  };
  const checkedRoute = async (event, e, next) => {
    let below;
    const passOn = (passed) => below ??= next(passedDown(event, e, passed, answerCheck));
    const answer = await router.dispatch(event, e, passOn);
    return await checkedAnswer(event, e, answer, () => passOn(e), answerCheck);
  };
  const whenActive = async () => {
    if (phase === "ready")
      activation ??= activate().catch(report);
    if (activation !== undefined && phase !== "active")
      await activation;
  };
  const holdUntilStarted = () => runtime === undefined ? startSettled.then(whenActive) : new Promise((resolve2) => {
    const limit = claude().clock.after(startHoldMs, resolve2);
    startSettled.then(whenActive).then(() => {
      limit.cancel();
      resolve2();
    });
  });
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
      return raise(method, payload);
    },
    async start(claudeCalls, read) {
      if (runtime !== undefined)
        return;
      programs = locatingPrograms(claudeCalls);
      runtime = { claude: programs.claude, toaster: createToaster(claudeCalls, definition.name, () => plugin?.version) };
      readStarted = read;
      try {
        await programs.refresh();
        await begin().catch(report);
      } finally {
        settleStart();
      }
    },
    async route(event, e, next) {
      if (imports !== undefined)
        bind(imports);
      if (event === "ui.render" && installer.draws(e))
        return installer.draw(e);
      if (event === "ui.close")
        installer.closed(e.id);
      if (event === "classic.SessionStart")
        missedSessionStart = undefined;
      if (event === "classic.SessionStart" && runtime === undefined) {
        missedSessionStart = e;
        return next(e);
      }
      if (shouldRecord && event === "classic.UserPromptSubmit")
        record();
      if (event === "classic.UserPromptSubmit" || event === "classic.SessionStart")
        await recover().catch((error) => claude().ui.log(`${definition.name} stays stopped: ${messageOf(error)}`, { to: "debug" }));
      const isCallToThisMod = event === "cmod.call" && e.to === definition.name;
      if (event === "cmod.call" && !isCallToThisMod)
        return next(e);
      await (event === "classic.SessionStart" || isCallToThisMod ? holdUntilStarted() : whenActive());
      if (event === "classic.SessionStart" && phase !== "active") {
        missedSessionStart = e;
        return next(e);
      }
      if (isCallToThisMod && phase !== "active") {
        const isStopped = phase === "declined" || phase === "failed";
        return { deny: isStopped ? `${definition.name} is not set up. Its toast says why.` : `${definition.name} is installing. Try again when it's ready.` };
      }
      const call = e;
      if (event === "cmod.call" && call.to === definition.name && mod !== undefined) {
        if (call.method === pendingStepsMethod)
          return { value: await pendingSteps(mod) };
        if (call.method === finishStepsMethod)
          return await runSteps(mod), { value: null };
      }
      if (event === "classic.UserPromptSubmit" || event === "classic.SessionStart")
        await refreshGrants().catch((error) => claude().ui.log(`${definition.name} keeps its grants from before: ${messageOf(error)}`, { to: "debug" }));
      if (checksAnswers(event) && phase === "active" && definition.name !== cmodPluginName)
        return checkedRoute(event, e, next);
      const answer = router.dispatch(event, e, next);
      const render = e;
      if (event !== "ui.render" || render.component !== "AbovePrompt" || runtime === undefined)
        return answer;
      return runtime.toaster.draw(await answer, runtime.claude.ui.resolve(render), render.props, render.requestId);
    }
  };
}
async function createMod(definition, runtime) {
  const { router, toaster } = runtime;
  const report = (failure) => void toaster.fail(failure);
  const claude = answeringOwnCalls(withBareRefusals(checkingKeys(runtime.claude, toaster.toast, runtime.steps.keys ?? {})), router);
  const added = [];
  const announce = (feature) => {
    added.push(feature);
  };
  const [session, root, startCwd, home, configHome] = await Promise.all([claude.session.id(), claude.session.root(), claude.session.cwd(), claude.env.home(), claude.env.configHome()]);
  const { granted } = runtime;
  const configRoot = configHome ?? (home === undefined ? undefined : `${home}/.claude`);
  const grants = {
    name: definition.name,
    declared: runtime.steps.permissions ?? [],
    granted: () => granted,
    refresh: runtime.refreshGrants,
    home,
    configRoot,
    projectRoot: () => modState.root,
    freeFolders: () => [modState.root, runtime.dataFolder],
    freeAddresses: () => programAddresses(mod)
  };
  const checked = checkingGrants(claude, grants);
  const places = { home, configRoot, projectRoot: () => modState.root };
  const files = createModFiles({
    name: definition.name,
    claude,
    places,
    checkWrite: (path) => checkWrite(grants, `metadata.update(${path})`, path),
    report
  });
  const pages = new Map;
  const settingsPages = {
    page(page) {
      if (pages.has(page.id))
        throw new Error(`${definition.name}: the settings page "${page.id}" is already added. Give each page its own id.`);
      if (page.id === changelogPage)
        throw new Error(`${definition.name}: the settings page id "${changelogPage}" opens the mod's CHANGELOG.md in /mods. Give the page another id.`);
      pages.set(page.id, { title: page.title, handle: area.ui.pane(page) });
    },
    async open(pageId) {
      if (pageId === undefined) {
        await claude.cmod.call({ to: cmodPluginName, method: "openSettings", input: { mod: definition.name } });
        return;
      }
      const page = pages.get(pageId);
      if (page === undefined)
        throw new Error(`${definition.name} has no settings page "${pageId}". It has: ${[...pages.keys()].join(", ") || "none"}.`);
      await page.handle.open({ focus: true });
    }
  };
  let cwd2 = startCwd;
  let loadedCwd = startCwd;
  let staleCwd;
  let forkedFrom;
  let parentAsked;
  let hasEarlierPrompts = true;
  let agentType;
  const area = createUi({ name: definition.name, claude, router, toaster, report, announce, mod: () => mod });
  const askParent = async () => {
    if (definition.name === cmodPluginName)
      return;
    try {
      const parent = await claude.cmod.call({ to: cmodPluginName, method: "forkParent", input: null });
      return typeof parent === "string" ? parent : undefined;
    } catch (error) {
      claude.ui.log(`${definition.name} starts without the session values of the conversation it was forked from: ${messageOf(error)}`, { to: "debug" });
      return;
    }
  };
  const forkParent = () => parentAsked ??= askParent().then((parent) => {
    forkedFrom = parent;
    return parent;
  });
  const modState = createState({ name: definition.name, initial: definition.state ?? {}, session, root, claude, report, changed: area.changed, forkParent });
  const modOptions = createOptions({ name: definition.name, declared: definition.options ?? {}, fromClaude: runtime.options, claude, report, changed: modState.changed });
  const hookOn = (hook, listener) => router.add(`classic.${hook}`, classicHook(hook, listener, report));
  const expand = (path) => homePrefix.test(path) ? resolvedPath(path, places) : path;
  const settingsFile = (source) => ({
    read: () => checked.settings.read({ source }),
    async update(values) {
      await checkSettings(grants, source, values);
      await claude.cmod.call({ to: cmodPluginName, method: "updateSettings", input: { mod: definition.name, source, project: modState.root, values } });
    }
  });
  const client = createSessionsClient({
    name: definition.name,
    claude: checked,
    report: (id, message, error) => report({ id, message, error }),
    isGranted: (permission) => flag(permission),
    hookOn: (hook, listener) => hookOn(hook, listener),
    routeOn: (event, hook) => router.add(event, hook),
    permissionRoutes: runtime.permissionRoutes
  });
  let followed;
  let isSetUp = false;
  const watches = new Set;
  const followFolders = (project, folder) => {
    if (followed === undefined)
      return;
    followed = { ...followed, project, cwd: folder };
    client.follow(followed);
  };
  const imports = {
    sessions: client.sessions,
    commands: {
      list: async () => (await checked.command.list()).map(({ name, description, source, plugin }) => ({ name, description, source, ...plugin === undefined ? {} : { plugin } })),
      run: async (command, args) => {
        const { text, context } = await checked.command.run({ command, ...args === undefined ? {} : { args } });
        return { ...text === undefined ? {} : { text }, ...context === undefined || context.length === 0 ? {} : { note: context.join(`
`) } };
      },
      beforeRun: (...args) => client.listen("beforeRun", args),
      onRun: (...args) => client.listen("onRun", args)
    },
    config: {
      list: async () => (await checked.config.list()).map(({ key, label, description, kind, value, options, provider, isLocked }) => ({
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
    model: { complete: (completion, options) => checked.model.complete(completion, options) },
    fs: {
      read: (path) => checked.fs.read(expand(path)),
      write: (path, text) => checked.fs.write(expand(path), text),
      exists: (path) => checked.fs.exists(expand(path)),
      find: (glob) => files.find(glob),
      list: async (path) => (await checked.fs.list(path === undefined ? undefined : expand(path))).map(({ name, kind, size, mtimeMs, isLink }) => ({ name, isFile: kind === "file", isFolder: kind === "dir", isLink, size, modifiedAt: mtimeMs })),
      async stat(path, options) {
        const { kind, size, mtimeMs, isLink, realPath } = await checked.fs.stat(expand(path), options);
        return { isFile: kind === "file", isFolder: kind === "dir", isLink, size, modifiedAt: mtimeMs, ...realPath === undefined ? {} : { realPath } };
      },
      onChange({ path }, listener) {
        if (isSetUp)
          throw new Error(`${definition.name}: fs.onChange works only in setup, because Claude Code reads the paths it watches when a session starts.`);
        const paths = [path].flat().map((each) => resolvedPath(each, places));
        const watch = { paths, listener };
        watches.add(watch);
        if (watches.size === 1) {
          hookOn("SessionStart", () => ({ watchPaths: [...new Set([...watches].flatMap((each) => each.paths))] }));
          hookOn("FileChanged", ({ file_path, event }) => {
            for (const each of watches)
              if (each.paths.some((watched) => relativePath(watched, file_path) !== undefined))
                Promise.resolve(each.listener({ path: file_path, type: event })).catch((error) => report({ id: "fs:onChange", message: "The fs.onChange listener failed", error }));
            return;
          });
        }
        return { dispose: () => void watches.delete(watch) };
      }
    },
    metadata: {
      read: (path) => files.read(path),
      update: (path, change) => files.update(path, change)
    },
    process: {
      run: (argv, init) => checked.process.run(argv, init),
      spawn: (argv, init) => checked.process.spawn({ ...init, argv })
    },
    http: { fetch: (url, init) => checked.http.fetch(url, init) }
  };
  const allowed = (permission) => ({ allows: (value) => isCovered(granted, itemOf(permission, value), home) });
  const flag = (permission) => isCovered(granted, permission, home);
  const timer = (ms, subject, start, listener) => {
    let isRunning = false;
    const started = start(checkedMs(definition.name, `mod.${subject}`, ms), () => {
      if (isRunning)
        return;
      isRunning = true;
      Promise.resolve().then(() => {
        bind(imports);
        return listener();
      }).catch((error) => report({ id: `${subject}:${ms}`, message: `The ${subject} ${ms} ms timer failed`, error })).finally(() => {
        isRunning = false;
      });
    });
    return { dispose: () => started.cancel() };
  };
  const mod = {
    name: definition.name,
    folder: claude.plugin.root,
    dataFolder: runtime.dataFolder,
    state: modState.state,
    get options() {
      return modOptions.values;
    },
    permissions: {
      get conversation() {
        return flag("conversation");
      },
      get prompt() {
        return flag("prompt");
      },
      get model() {
        return flag("model");
      },
      get tasks() {
        return flag("tasks");
      },
      get tools() {
        return flag("tools");
      },
      get approve() {
        return flag("approve");
      },
      network: allowed("network"),
      run: allowed("run"),
      files: allowed("files"),
      config: allowed("config")
    },
    every: (ms, listener) => timer(ms, "every", claude.clock.every, listener),
    after: (ms, listener) => timer(ms, "after", claude.clock.after, listener),
    use: (job) => job({ mod, announce, reserveName }),
    log: (text, options) => claude.ui.log(`${definition.name}: ${text}`, { to: options?.to ?? "debug" }),
    ui: { ...area.ui, notice: (callId, text) => claude.ui.notice(callId, text) },
    settings: settingsPages,
    dependencies: dependencyCalls(claude, (call, task) => beforeDeadline(claude, { ms: dependencyCallMs }, call, task))
  };
  bind(imports);
  const followSession = async (isAfterCd = false) => {
    try {
      const [nextRoot, reportedCwd] = await Promise.all([claude.session.root(), claude.session.cwd()]);
      const oldCwd = cwd2;
      const hasMovedRoot = nextRoot !== modState.root;
      if (isAfterCd && hasMovedRoot && relativePath(nextRoot, reportedCwd) === undefined)
        staleCwd = reportedCwd;
      if (reportedCwd !== staleCwd)
        staleCwd = undefined;
      const nextCwd = staleCwd === undefined ? reportedCwd : nextRoot;
      if (!hasMovedRoot && nextCwd === oldCwd)
        return;
      cwd2 = nextCwd;
      followFolders(nextRoot, nextCwd);
      await modState.moveTo(nextRoot).catch((error) => {
        if (cwd2 === nextCwd)
          cwd2 = loadedCwd;
        followFolders(modState.root, cwd2);
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
  const followCurrent = async (title) => {
    const [id, model, usage] = await Promise.all([claude.session.id(), claude.session.model(), claude.session.usage()]);
    followed = { id, title: title ?? "", project: modState.root, cwd: cwd2, model, startedAt: new Date(usage.startedAt).toISOString(), ...forkedFrom === undefined ? {} : { forkedFrom }, ...agentType === undefined ? {} : { agentType } };
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
    await modState.switchSession(e.session_id, e.source, e.transcript_path).catch((error) => {
      report({ id: "cmod:session", message: `Kept its session values from before the ${e.source}`, error });
    });
    await followCurrent(e.session_title).catch((error) => report({ id: "cmod:current", message: "Kept the details of the session from before", error }));
    return next(e);
  });
  router.add("classic.UserPromptSubmit", async (e, next) => {
    staleCwd = undefined;
    await followSession();
    const isPerson = e.source === undefined || e.source === "user" || e.source === "sdk";
    await followCurrent(e.session_title || (isPerson && !hasEarlierPrompts && client.sessions.current.title === "" ? firstLine(e.prompt) : undefined)).catch((error) => report({ id: "cmod:current", message: "Kept the details of the session from before", error }));
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
  const api = Object.fromEntries(Object.entries(definition.api ?? {}).map(([method, run]) => [method, (input) => run(input, mod)]));
  const conversations = definition.name === cmodPluginName ? serveConversations({ claude, router, store: runtime.store, project: () => modState.root, report: (id, message, error) => report({ id, message, error }) }) : undefined;
  router.add("cmod.call", async (e, next) => {
    if (e.to !== definition.name)
      return next(e);
    const call = e;
    if (e.method === conversationMethods.changed && call.caller === cmodPluginName) {
      const { session: changedSession, change, isInProject } = e.input;
      if (changedSession !== client.sessions.current.id && !flag("conversation"))
        return { value: null };
      client.changed(changedSession, change, isInProject !== false);
      return { value: null };
    }
    if (e.method === conversationMethods.before && call.caller === cmodPluginName) {
      const { session: asking, event, change, isInProject } = e.input;
      return { value: await client.answerBefore(asking, event, change, isInProject !== false) ?? null };
    }
    if (e.method === settingsPagesMethod)
      return { value: [...pages].map(([id, { title }]) => ({ id, title })) };
    if (e.method === openPageMethod) {
      await settingsPages.open(String(e.input));
      return { value: null };
    }
    const served = await conversations?.answer(call);
    return served ?? answerCall(definition.name, api, e);
  });
  const agents = toolCalls(claude, router);
  keepEngine(mod, { claude: checked, router, toolCalls: agents, report });
  const names = new Set;
  const reserveName = (type, name, taken) => {
    const key = `${type}:${name}`;
    if (names.has(key))
      throw new Error(taken);
    names.add(key);
    return { dispose: () => void names.delete(key) };
  };
  await failsAs("its state did not load", () => modState.load());
  await failsAs("its options did not load", () => modOptions.load(root));
  const missing = modOptions.missing;
  if (missing.length > 0)
    throw new MissingOptions(missing, missing.map((key) => definition.options?.[key]?.title ?? key));
  await failsAs("the details of its session did not load", () => followCurrent(undefined));
  await failsAs("its setup function threw", () => definition.setup(mod));
  isSetUp = true;
  const permissionHooks = permissionEvents.filter((event) => router.has(event));
  if (permissionHooks.length > 0 && runtime.permissionRoutes() === undefined) {
    throw new Error(`it decides permissions on ${listed(permissionHooks)}, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod`);
  }
  await failsAs("its open panes did not load", () => area.restorePanes());
  return { mod, added, imports, raise: client.raise };
}
function checkingKeys(claude, toast, keys) {
  const bound2 = Object.entries(keys);
  if (bound2.length === 0)
    return claude;
  const addCommand2 = (command) => {
    for (const [key, commandName] of bound2) {
      if (commandName === command.name && command.immediate !== true) {
        toast.warning(`${key} runs /${command.name}, which waits for Claude's turn to end`, { id: `key:${key}`, description: `It adds a row to the conversation. Give /${command.name} immediate: true.`, duration: Infinity });
      }
    }
    return claude.command.register(command);
  };
  return { ...claude, command: { ...claude.command, register: addCommand2 } };
}
var longestTimerMs = 2147483647;
function checkedMs(name, subject, ms) {
  if (!Number.isInteger(ms) || ms <= 0 || ms > longestTimerMs)
    throw new Error(`${name}: ${subject} is ${ms}. Give a whole number of milliseconds above 0 and at most ${longestTimerMs}.`);
  return ms;
}
async function failsAs(subject, step) {
  try {
    await step();
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
async function startMod($, eventInput, passOn) {
  const claude = {
    plugin: { name: $.plugin.name, root: $.plugin.root },
    ui: {
      status: (text) => $.ui.status(text),
      log: (text, options) => $.ui.log(text, options),
      notice: (toolUseId, text) => $.ui.notice(toolUseId, text),
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
      set: (key, value) => $.store.set(key, value),
      delete: (key) => $.store.delete(key),
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
    cmod: { call: (input) => $.cmod.call(input) }
  };
  const [, answer] = await Promise.all([lifecycle.start(claude, readPlugin), passOn(eventInput)]);
  return answer;
}
function routeToMod(_$, eventInput, passOn) {
  return lifecycle.route(passOn.event, eventInput, (passed) => passOn(passed));
}
function routeCallToMod(_$, eventInput, passOn) {
  const called = { ...eventInput, caller: passOn.origin.plugin };
  return lifecycle.route("cmod.call", called, (passed) => passOn(Object.fromEntries(Object.entries(passed).filter(([key]) => key !== "caller"))));
}
function registerMod(addHook, definition, options) {
  permissionCheck = undefined;
  registered = definition;
  lifecycle = createLifecycle(definition, () => permissionCheck, options);
  addHook("session.start", startMod);
  addHook("classic.Setup", routeToMod);
  addHook("classic.SessionStart", routeToMod);
  addHook("classic.SessionEnd", routeToMod);
  addHook("classic.UserPromptSubmit", routeToMod);
  addHook("classic.UserPromptExpansion", routeToMod);
  addHook("classic.InstructionsLoaded", routeToMod);
  addHook("classic.ConfigChange", routeToMod);
  addHook("classic.DirectoryAdded", routeToMod);
  addHook("classic.PreModelSwitch", routeToMod);
  addHook("classic.PostModelSwitch", routeToMod);
  addHook("classic.PermissionDenied", routeToMod);
  addHook("classic.PostToolUse", routeToMod);
  addHook("classic.PostToolUseFailure", routeToMod);
  addHook("classic.PostToolBatch", routeToMod);
  addHook("classic.MessageDisplay", routeToMod);
  addHook("classic.SubagentStart", routeToMod);
  addHook("classic.SubagentStop", routeToMod);
  addHook("classic.TaskCreated", routeToMod);
  addHook("classic.TaskCompleted", routeToMod);
  addHook("classic.TeammateIdle", routeToMod);
  addHook("classic.Elicitation", routeToMod);
  addHook("classic.ElicitationResult", routeToMod);
  addHook("classic.Notification", routeToMod);
  addHook("classic.PreCompact", routeToMod);
  addHook("classic.PostCompact", routeToMod);
  addHook("classic.Stop", routeToMod);
  addHook("classic.StopFailure", routeToMod);
  addHook("classic.FileChanged", routeToMod);
  addHook("classic.WorktreeCreate", routeToMod);
  addHook("classic.WorktreeRemove", routeToMod);
  addHook("tool.call", routeToMod);
  addHook("prompt.submit", routeToMod);
  addHook("prompt.context", routeToMod);
  addHook("command.run", routeToMod);
  addHook("session.measure", routeToMod);
  addHook("skill.prompt", routeToMod);
  addHook("ui.render", routeToMod);
  addHook("ui.press", routeToMod);
  addHook("ui.scroll", routeToMod);
  addHook("ui.close", routeToMod);
  addHook("cmod.call", routeCallToMod);
  if (definition.name !== cmodPluginName)
    return;
  addHook("session.append", routeToMod);
  addHook("session.compact", routeToMod);
  addHook("session.receive", routeToMod);
  addHook("agent.spawn", routeToMod);
  addHook("prompt.attachment", routeToMod);
  addHook("turn.start", routeToMod);
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
    const { claude, router, report } = engineOf(mod);
    if (!commandName.test(name))
      throw new Error(`${mod.name}: "${name}" is not a slash command name. Use 1 to 64 letters, digits, "_", or "-", without the slash.`);
    const reserved = reserveName("slashCommand", name, `${mod.name}: the slash command /${name} is already added. Give each slashCommand its own name.`);
    let registered2;
    claude.command.register({ name, description, ...argumentHint === undefined ? {} : { argumentHint }, ...immediate === undefined ? {} : { immediate } }).then(({ command }) => {
      registered2 = command;
    }, (error) => {
      report({ id: `command:${name}`, message: `/${name} is not added`, error });
    });
    announce(`/${name}`);
    const answering = router.add("command.run", async (e, next) => {
      if (e.command !== registered2)
        return next(e);
      try {
        return answerOf(await withinDeadline(mod, deadline, `/${name}`, () => reply({ args: e.args, positionals: splitWords(e.args) }, mod)));
      } catch (error) {
        return { text: `/${name} failed: ${oneLine(error)}` };
      }
    });
    return {
      dispose() {
        answering.dispose();
        reserved.dispose();
      }
    };
  };
}
function answerOf(reply) {
  if (reply === undefined)
    return {};
  if (typeof reply === "string")
    return { text: reply };
  return { ...reply.text === undefined ? {} : { text: reply.text }, ...reply.note === undefined ? {} : { context: [reply.note] } };
}
function splitWords(args) {
  return $parse(args, (key) => `$${key}`).flatMap((entry) => {
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

// node_modules/@cmodjs/core/ui/define-pane.js
var paneId = /^[A-Za-z0-9_-]{1,64}$/;
var sizeKeys2 = ["columns", "rows"];
function definePane(pane) {
  if (!paneId.test(pane.id))
    throw new Error(`definePane: "${pane.id}" is not a pane id. Use 1 to 64 letters, digits, "_", or "-".`);
  for (const key of sizeKeys2) {
    const size = pane[key];
    if (typeof size !== "function" && size !== undefined && (!Number.isInteger(size) || size <= 0))
      throw new Error(`definePane: the pane "${pane.id}" has ${key} ${size}. Use a whole number above 0, or leave it out.`);
  }
  return pane;
}

// ../../../../../private/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/cmod-publish-cmod-oWAVhr/release/src/mods.ts
var modsMemory = { selected: null, tab: "options", notice: null, removing: null, views: [] };
var tabs = [
  { key: "options", label: "Options" },
  { key: "permissions", label: "Permissions" },
  { key: "keys", label: "Keys" },
  { key: "pages", label: "Pages" },
  { key: "changelog", label: "Changelog" }
];
var tabsOf = (view) => tabs.filter(({ key }) => key !== "changelog" || view.changelog.length > 0);
async function storeOf(mod) {
  const { claude } = engineOf(mod);
  return storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() });
}
async function readConsent(mod) {
  const path = consentPath(await storeOf(mod));
  return await fs.exists(path) ? parseConsent(JSON.parse(await fs.read(path)), path) : {};
}
function modsPanel(mod) {
  const load = async () => {
    const store = await storeOf(mod);
    const consent = await readConsent(mod);
    const rows = await engineOf(mod).claude.config.list();
    const enabledPlugins = (await engineOf(mod).claude.settings.read())["enabledPlugins"];
    const turnedOff = Object.entries(isObject(enabledPlugins) ? enabledPlugins : {}).filter(([, isEnabled]) => isEnabled === false).map(([id]) => id.replace(/@[^@]*$/, ""));
    const names = await fs.exists(`${store}/records`) ? (await fs.list(`${store}/records`)).filter((entry) => entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -".json".length)) : [];
    const read = (path) => fs.read(path).catch(ifMissing(undefined));
    const records = (await Promise.all(names.map((name) => readRecord(read, store, name)))).filter((record) => record !== undefined);
    const views = await Promise.all(records.map(async (record) => {
      const manifest = await fs.read(`${record.root}/package.json`).then(JSON.parse, ifMissing(undefined));
      const plugin = await fs.read(`${record.root}/.claude-plugin/plugin.json`).then(JSON.parse, ifMissing(undefined));
      const declared = (isObject(manifest) ? readSteps(manifest)?.permissions : undefined) ?? [];
      const granted = consent[record.name] ?? [];
      const ask = async (method) => {
        const answer = await engineOf(mod).claude.cmod.call({ to: record.name, method, input: null }).catch((error) => {
          mod.log(`${record.name} did not answer ${method}: ${messageOf(error)}`);
          return;
        });
        return Array.isArray(answer) ? answer : [];
      };
      const pages = await ask(settingsPagesMethod);
      const pendingSteps = await ask(pendingStepsMethod);
      const changelog = changelogSections(await read(`${record.root}/CHANGELOG.md`) ?? "");
      return {
        name: record.name,
        version: record.version,
        description: isObject(plugin) && typeof plugin["description"] === "string" ? plugin["description"] : undefined,
        isOn: !turnedOff.includes(record.name),
        permissions: declared.map((item) => ({ item, isOn: granted.includes(item) })),
        keys: Object.entries(record.keys).map(([key, command]) => [key, `/${command}`]),
        options: rows.filter((row) => row.key.startsWith(`${record.name}.`)),
        pages,
        pendingSteps,
        changelog
      };
    }));
    return views.sort((left, right) => left.name.localeCompare(right.name));
  };
  const refresh = async () => {
    try {
      mod.state.memory.views = await load();
    } catch (error) {
      mod.state.memory.notice = `The mods did not load: ${messageOf(error)}`;
    }
  };
  const act = (task) => void task().then((notice) => {
    mod.state.memory.notice = notice ?? null;
    return refresh();
  }).catch((error) => void (mod.state.memory.notice = messageOf(error)));
  const toggle = (name, { item, isOn }) => act(async () => {
    const split = item.indexOf(":");
    const words = split === -1 ? [item] : [item.slice(0, split), item.slice(split + 1)];
    const { exitCode, stdout, stderr } = await process.run(["cmod", "permission", name, ...words, isOn ? "off" : "on"]);
    return exitCode === 0 ? stdout.trim() : `cmod permission ${name} ${formatExit(exitCode, cmodError(stderr, "permission"))}`;
  });
  const remove = (name) => act(async () => {
    mod.state.memory.removing = null;
    mod.state.memory.notice = `Removing ${name}…`;
    const { exitCode, stderr } = await process.run(["cmod", "remove", name], { timeoutMs: longestMs });
    if (exitCode === 0)
      return `Removed ${name}. This session stops running it after /reload-plugins.`;
    return `cmod remove ${name} ${formatExit(exitCode, cmodError(stderr, "remove"))}`;
  });
  const turn = (name, isOn) => act(async () => {
    const action = isOn ? "enable" : "disable";
    const { exitCode, stderr } = await process.run(["cmod", action, name]);
    if (exitCode === 0)
      return `Turned ${name} ${isOn ? "on" : "off"}. This session follows after /reload-plugins.`;
    return `cmod ${action} ${name} ${formatExit(exitCode, cmodError(stderr, action))}`;
  });
  const setOption = (name, row, text) => act(async () => {
    const value = text.split(",").map((item) => item.trim()).join(",");
    const { exitCode, stderr } = await process.run(["cmod", "option", name, row.key.slice(name.length + 1), value]);
    if (exitCode === 0)
      return `Saved ${row.label}. ${name} reads it at its next start.`;
    return `cmod option ${name} ${formatExit(exitCode, cmodError(stderr, "option"))}`;
  });
  const drawTab = (view, tab) => {
    if (tab === "options") {
      if (view.options.length === 0)
        return Text({ dimColor: true, children: `${view.name} has no options.` });
      return Box({
        flexDirection: "column",
        gap: 1,
        children: view.options.map((row) => Box({
          flexDirection: "column",
          children: [
            Text({ children: [Text({ bold: true, children: row.label }), row.isLocked ? Text({ dimColor: true, children: "  set by your organization" }) : ""] }),
            row.isLocked ? Text({ children: String(row.value) }) : Input({ key: `option:${row.key}`, label: "› ", value: Array.isArray(row.value) ? row.value.join(", ") : String(row.value), submitLabel: "save", onSubmit: (text) => setOption(view.name, row, text) })
          ]
        }))
      });
    }
    if (tab === "permissions") {
      if (view.permissions.length === 0)
        return Text({ dimColor: true, children: `${view.name} asks for no permissions.` });
      return Box({ flexDirection: "column", children: view.permissions.map((permission) => Button({ plain: true, key: `permission:${permission.item}`, label: `${permission.isOn ? "[x]" : "[ ]"} ${permissionWords(permission.item)}`, onPress: () => toggle(view.name, permission) })) });
    }
    if (tab === "keys") {
      if (view.keys.length === 0)
        return Text({ dimColor: true, children: `${view.name} binds no keys.` });
      return Box({ flexDirection: "column", children: view.keys.map(([key, command]) => Text({ children: `${key.padEnd(12)}${command}` })) });
    }
    if (tab === "changelog") {
      return Box({
        flexDirection: "column",
        gap: 1,
        children: view.changelog.map(({ version, date: date2, text }) => Box({
          key: `changelog:${version}`,
          flexDirection: "column",
          children: [
            Text({ children: [Text({ bold: true, children: version }), Text({ dimColor: true, children: `${date2 === undefined ? "" : ` · ${date2}`}${version === view.version ? " · installed" : ""}` })] }),
            Markdown({ text: text === "" ? "_No changes listed._" : text })
          ]
        }))
      });
    }
    if (view.pages.length === 0)
      return Text({ dimColor: true, children: `${view.name} adds no pages.` });
    return Box({ gap: 2, children: view.pages.map((page) => Button({ key: `page:${page.id}`, label: page.title, onPress: () => act(async () => (await engineOf(mod).claude.cmod.call({ to: view.name, method: openPageMethod, input: page.id }), undefined)) })) });
  };
  const pane = definePane({
    id: "mods",
    title: "Mods",
    closeOnEscape: true,
    render(current2) {
      const { selected, tab, notice, removing, views } = current2.state.memory;
      const view = views.find((each) => each.name === selected) ?? views[0];
      if (view === undefined)
        return Text({ dimColor: true, children: notice ?? "No mod is set up yet. Add one with /plugin." });
      const shownTab = tabsOf(view).some(({ key }) => key === tab) ? tab : "options";
      const list = Box({
        flexDirection: "column",
        minWidth: 18,
        children: views.map((each) => {
          const label = `${each === view ? "▸" : " "} ${each.name}${each.isOn ? "" : " (off)"}`;
          return each === view ? Text({ bold: true, children: label }) : Button({ plain: true, key: `mod:${each.name}`, label, onPress: () => void Object.assign(current2.state.memory, { selected: each.name, removing: null }) });
        })
      });
      const actions = view.name === "cmod" ? [] : removing === view.name ? [
        Box({
          flexDirection: "column",
          children: [
            Text({ color: "warning", children: `Remove ${view.name}? Its uninstall step runs, and Claude Code deletes it.` }),
            Box({
              gap: 2,
              children: [
                Button({ key: "keep", label: "Keep", onPress: () => void (current2.state.memory.removing = null) }),
                Button({ key: "remove-confirmed", label: "Remove", onPress: () => remove(view.name) })
              ]
            })
          ]
        })
      ] : [
        Box({
          gap: 2,
          children: [
            Button({ key: "turn", label: view.isOn ? "Turn off" : "Turn on", onPress: () => turn(view.name, !view.isOn) }),
            Button({ key: "remove", label: "Remove", onPress: () => void (current2.state.memory.removing = view.name) })
          ]
        })
      ];
      const details = Box({
        flexDirection: "column",
        gap: 1,
        children: [
          Box({
            flexDirection: "column",
            children: [
              Text({ children: [Text({ bold: true, children: view.name }), Text({ dimColor: true, children: ` ${view.version}` })] }),
              ...view.description === undefined ? [] : [Text({ dimColor: true, children: view.description })],
              ...view.isOn ? [] : [Text({ color: "warning", children: "Off: Claude Code does not load it." })]
            ]
          }),
          ...actions,
          ...view.pendingSteps.length === 0 ? [] : [
            Box({
              gap: 2,
              children: [
                Text({ color: "warning", children: `Needs setup: ${view.pendingSteps.join(", ")}` }),
                Button({ key: "finish", label: "Finish setup", onPress: () => act(async () => (await engineOf(mod).claude.cmod.call({ to: view.name, method: finishStepsMethod, input: null }), undefined)) })
              ]
            })
          ],
          Tabs({ tabs: tabsOf(view), selected: shownTab, onSelect: (key) => void (current2.state.memory.tab = key), children: drawTab(view, shownTab) }),
          ...notice === null ? [] : [Text({ dimColor: true, children: notice })]
        ]
      });
      return Box({ gap: 2, children: [list, details] });
    }
  });
  const handle = mod.ui.pane(pane);
  return {
    async open(name, page) {
      await refresh();
      const view = mod.state.memory.views.find((each) => each.name === name);
      if (name !== undefined) {
        if (view === undefined)
          throw new Error(`${name} is not a mod cmod set up. cmod list shows the mods.`);
        mod.state.memory.selected = name;
        mod.state.memory.tab = page === changelogPage ? "changelog" : "options";
      }
      if (view !== undefined && page === changelogPage) {
        await handle.open({ focus: true });
        const shown = view.changelog.some(({ version }) => version === view.version) ? view.version : unreleased;
        await mod.ui.scroll({ to: { key: `changelog:${shown}` }, block: "start" });
        return;
      }
      if (name !== undefined && page !== undefined) {
        await engineOf(mod).claude.cmod.call({ to: name, method: openPageMethod, input: page });
        return;
      }
      await handle.open({ focus: true });
    }
  };
}

// ../../../../../private/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/cmod-publish-cmod-oWAVhr/release/src/mod.ts
var cmodGlobal = { installedPlugins: null };
var cmodSession = { tip: null };
var newestMessages = 8;
async function tipOf(mod) {
  const messages = await engineOf(mod).claude.session.messages();
  if (messages.length === 0)
    return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([messages.length, messages.slice(-newestMessages)])));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
var panels = new WeakMap;
var cmodPlugin = defineMod({
  name: "cmod",
  state: { global: cmodGlobal, session: cmodSession, memory: modsMemory },
  api: {
    async forkParent(_input, mod) {
      const tip = await tipOf(mod);
      if (tip === null)
        return null;
      const { claude } = engineOf(mod);
      const current2 = await claude.session.id();
      return (await sessionsWith(claude, mod.name, "tip", tip)).find((session) => session !== current2) ?? null;
    },
    async openSettings(input, mod) {
      const panel = panels.get(mod);
      if (panel === undefined)
        throw new Error("cmod has not started its /mods panel yet.");
      await panel.open(input.mod, input.page);
      return null;
    },
    async updateSettings(input, mod) {
      const { claude } = engineOf(mod);
      await runCmod(claude, ["settings", input.mod, input.source, JSON.stringify(input.values), "--project", input.project], await claude.session.id());
      return null;
    }
  },
  setup(mod) {
    const triedRemovals = new Set;
    const mods = modsPanel(mod);
    panels.set(mod, mods);
    mod.use(slashCommand({
      name: "mods",
      description: "See your mods, turn them off or remove them, and change their options, permissions, keys, and pages",
      argumentHint: "[mod] [page]",
      immediate: true,
      async reply({ positionals }) {
        const [name, page] = positionals;
        await mods.open(name, page);
      }
    }));
    const { claude, report } = engineOf(mod);
    readConsent(mod).then(async (consent) => Object.entries(consent).some(([name, granted]) => name !== mod.name && granted.includes("conversation")) ? runCmod(claude, ["history", "index"], await claude.session.id()) : undefined).catch((error) => mod.log(messageOf(error)));
    const tearDown = async (name) => {
      const { exitCode, stdout, stderr } = await process.run(["cmod", "teardown", name, "--events"], { timeoutMs: longestMs });
      const outcome = parseEvent(stdout.trim().split(`
`).at(-1) ?? "");
      const isAnswered = outcome.type === "done" || outcome.type === "missing" || outcome.type === "failed";
      if (isAnswered)
        mod.state.global.installedPlugins = (mod.state.global.installedPlugins ?? []).filter((installed) => installed !== name);
      if (outcome.type === "done")
        mod.ui.toast.success(`${name} is uninstalled`, { description: "A session that still runs it stops after /reload-plugins." });
      else if (outcome.type === "failed")
        report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, description: outcome.message });
      else if (exitCode !== 0)
        report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, description: `cmod teardown ${formatExit(exitCode, cmodError(stderr, "teardown"))}` });
    };
    const watchRemovals = async () => {
      const enabledPlugins = (await settings.user.read())["enabledPlugins"];
      const current2 = [...new Set(Object.keys(enabledPlugins ?? {}).map((key) => key.replace(/@[^@]*$/, "")))];
      const previous = mod.state.global.installedPlugins;
      const removed = (previous ?? []).filter((name) => !current2.includes(name));
      const installed = [...current2, ...removed];
      if (previous === null || previous.length !== installed.length || !installed.every((name) => previous.includes(name)))
        mod.state.global.installedPlugins = installed;
      for (const name of removed) {
        if (triedRemovals.has(name))
          continue;
        triedRemovals.add(name);
        tearDown(name).catch((error) => report({ id: `teardown:${name}`, message: `Could not uninstall ${name}`, error }));
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
        return;
      const startedAt = await claude.clock.now();
      const result = JSON.parse(await runCmod(claude, ["rules", "--project", project, "--json"], await claude.session.id()));
      const times2 = await changedAt(result.watched);
      synced = { project, watched: result.watched, stamp: times2.some((at) => at >= startedAt - 1000) ? "" : times2.join(",") };
      await noteRules(result);
    };
    const noteRules = async (result) => {
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
      for (const text of [...notes, ...gone.map((name) => `The ${name} mod's rules no longer apply.`)]) {
        const added = await claude.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
        if (added.deny !== undefined)
          mod.log(`Claude Code refused the rules note: ${added.deny}`);
      }
    };
    const keepRules = async () => {
      following = following.then(followRules).catch((error) => report({ id: "rules", message: "Could not link the mods' rules", error }));
      await following;
    };
    sessions.current.beforeSessionStart(keepRules);
    sessions.current.beforePrompt(keepRules, { timeoutMs: 60000 });
    sessions.current.onTurnEnd(async () => {
      mod.state.session.tip = await tipOf(mod);
    });
  }
});

// ../../../../../private/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/cmod-publish-cmod-oWAVhr/release/hooks/register.ts
function register(addHook, options) {
  addHook("engine.create", async (_$, eventInput, passOn) => {
    const built2 = await passOn(eventInput);
    const cmod = {
      async call(input) {
        return { deny: notInstalled(input.to) };
      }
    };
    return { ...built2, cmod };
  });
  registerMod(addHook, cmodPlugin, options);
}
export {
  register
};
