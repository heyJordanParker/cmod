// node_modules/@cmodjs/core/options.js
var optionKey = /^[A-Za-z_]\w*$/;
function checkOptions(name, options) {
  for (const [key, declared] of Object.entries(options)) {
    const at = `${name}: options.${key}`;
    if (!optionKey.test(key))
      throw new Error(`${at} is not an option name. Use letters, digits, and _, starting with a letter, as Claude Code passes each option on as CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}.`);
    if (declared.title.trim() === "")
      throw new Error(`${at} needs a title, the label /config shows.`);
    if (declared.kind === "choice" && (declared.choices ?? []).length === 0)
      throw new Error(`${at} is a choice with no choices. Give option.choice(['a', 'b'], { ... }).`);
    if (declared.kind === "choice" && declared.default !== undefined && !(declared.choices ?? []).includes(declared.default))
      throw new Error(`${at} defaults to ${String(declared.default)}, which is not one of its choices: ${(declared.choices ?? []).join(", ")}.`);
  }
  return options;
}
function isUnset(value) {
  return value === undefined || value === "" || Array.isArray(value) && value.length === 0;
}
function fitsOption(declared, value) {
  const kind = declared.kind;
  if (kind === "toggle")
    return typeof value === "boolean" ? undefined : "takes true or false";
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return "takes a number";
    if (declared.min !== undefined && value < declared.min)
      return `takes ${declared.min} or more`;
    if (declared.max !== undefined && value > declared.max)
      return `takes ${declared.max} or less`;
    return;
  }
  if (kind === "list")
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? undefined : "takes a list of text";
  if (typeof value !== "string")
    return "takes text";
  if (kind === "choice" && !(declared.choices ?? []).includes(value))
    return `takes one of: ${(declared.choices ?? []).join(", ")}`;
  return;
}

// node_modules/@cmodjs/core/runtime/deadline.js
var longestMs = 600000;
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
// node_modules/@cmodjs/core/utils/text.js
function listed(items) {
  if (items.length <= 1)
    return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function formatExit(code, reason) {
  const exit = code === null ? "was stopped by a signal" : `exited ${code}`;
  const clause = reason.trim().replace(/[.!?]+$/, "");
  return clause ? `${exit}: ${clause}` : exit;
}

// node_modules/@cmodjs/core/runtime/dependencies.js
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
function notInstalled(name) {
  return `${name} is not installed. Run cmod install ${name}.`;
}

// node_modules/@cmodjs/core/mod.js
function defineMod(definition) {
  if (definition.name.trim() === "")
    throw new Error("defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.");
  if (definition.options !== undefined)
    checkOptions(definition.name, definition.options);
  return definition;
}

// node_modules/@cmodjs/core/records.js
var listPermissions = ["network", "run", "files"];
var flagPermissions = ["conversation", "prompt", "model", "agents", "tools", "config", "approve"];
var permissionNames = [...listPermissions, ...flagPermissions];
var hostName = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
var programName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
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
    const example = name === "network" ? '["api.github.com"]' : name === "run" ? '["gh"], or "*" for any program' : '["~/.zshrc"]';
    if (!Array.isArray(value) || value.length === 0 || !value.every((each) => typeof each === "string"))
      throw new Error(`${at} sets "${name}" to ${JSON.stringify(value)}. Write a list, such as "${name}": ${example}.`);
    for (const each of value) {
      const isPath = /^(~\/|\/)/.test(each) && !each.split("/").includes("..");
      const isValid = name === "network" ? hostName.test(each) || isPath : name === "run" ? programName.test(each) : isPath;
      if (!isValid)
        throw new Error(`${at} lists "${each}" under "${name}". Write ${name === "network" ? 'a host alone, such as "api.github.com", or a socket path, such as "/var/run/docker.sock"' : name === "run" ? `a program's command, such as "gh"` : 'a path that starts with ~/ or /, such as "~/.zshrc"'}.`);
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
      return "Read this conversation";
    case "prompt":
      return "Add text Claude reads and start turns";
    case "model":
      return "Ask a model, which uses your plan";
    case "agents":
      return "Start agents";
    case "tools":
      return "Use and change Claude's tool calls";
    case "config":
      return "Change your Claude Code settings";
    case "approve":
      return "Approve Claude's tool calls for you";
    default:
      return item;
  }
}
var settingsPagesMethod = "cmod:settingsPages";
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
function oldestCmodFor(steps) {
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
    return { kind: "progress", done: Number(progress[1]), total: Number(progress[2]), label: progress[3] ?? "" };
  const consent = /^needs-consent (\S+)\t([^\t]*)\t([^\t]*)(?:\t(.*))?$/.exec(line);
  if (consent !== null) {
    const [keys = "", ...permissions] = (consent[4] ?? "").split("\t");
    return { kind: "needs-consent", sha256: consent[1], install: consent[2], uninstall: consent[3], keys, permissions: permissions.filter((item) => item !== "") };
  }
  const done = /^done (\S+)(?: (\S+))?$/.exec(line);
  if (done !== null)
    return { kind: "done", name: done[1], ...done[2] === undefined ? {} : { version: done[2] } };
  const missing = /^missing (\S+)$/.exec(line);
  if (missing !== null)
    return { kind: "missing", name: missing[1] };
  const failed = /^failed (-?\d+)(?:\t(.*))?$/.exec(line);
  if (failed !== null)
    return { kind: "failed", code: Number(failed[1]), message: failed[2] ?? "" };
  return { kind: "log", text: line.replace(/^log /, "") };
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
function bind(r) {
  return r.test.bind(r);
}
var format = {
  date,
  time: time.bind(undefined, false),
  "date-time": date_time,
  duration: DURATION,
  uri,
  "uri-reference": bind(URIREF),
  "uri-template": bind(URITEMPLATE),
  url: bind(URL_),
  email: EMAIL,
  hostname: bind(HOSTNAME),
  ipv4: bind(IPV4),
  ipv6: bind(IPV6),
  regex,
  uuid: bind(UUID),
  "json-pointer": bind(JSON_POINTER),
  "json-pointer-uri-fragment": bind(JSON_POINTER_URI_FRAGMENT),
  "relative-json-pointer": bind(RELATIVE_JSON_POINTER)
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
function expandHome(path, home) {
  const prefix = /^(~|\$HOME)(?=\/|$)/.exec(path)?.[0];
  return prefix === undefined ? path : `${home}${path.slice(prefix.length)}`;
}
function relativePath(base, path) {
  if (path === base)
    return "";
  const prefix = base === "/" ? "/" : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

// node_modules/@cmodjs/core/runtime/tool-calls.js
var reservedKeys = ["tool", "tool_use_id", "consent", "agentId"];
function toolInputOf(envelope) {
  return Object.fromEntries(Object.entries(envelope).filter(([key]) => !reservedKeys.includes(key)));
}
var keptCalls = 100;
function toolCalls(claude, router) {
  let mainAgentType;
  const agentIds = new Map;
  const cwds = new Map;
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
    cwds.set(e.tool_use_id, await claude.session.cwd());
    for (const oldest of cwds.keys()) {
      if (cwds.size <= keptCalls)
        break;
      cwds.delete(oldest);
    }
    if (e.agentId === undefined)
      return next(e);
    agentIds.set(e.tool_use_id, e.agentId);
    try {
      return await next(e);
    } finally {
      agentIds.delete(e.tool_use_id);
    }
  });
  for (const event of ["classic.PostToolUse", "classic.PostToolUseFailure"]) {
    router.add(event, async (e, next) => {
      try {
        return await next(e);
      } finally {
        cwds.delete(e.tool_use_id);
      }
    });
  }
  return {
    async agentOf(toolUseId) {
      const agentId = toolUseId === undefined ? undefined : agentIds.get(toolUseId);
      const agentType = agentId === undefined ? mainAgentType : (await claude.agent.list()).find((agent) => agent.id === agentId)?.type;
      return { ...agentId === undefined ? {} : { agentId }, ...agentType === undefined ? {} : { agentType } };
    },
    cwdOf: (toolUseId) => cwds.get(toolUseId)
  };
}

// node_modules/@cmodjs/core/utils/parse-shell.js
var markerPattern = /\u0001(\d+)\u0001/g;
var descriptorPattern = /[0-9]+(?=[<>])/y;
var assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
var dynamicPattern = /[$`]/;
var homePrefix = /^\$HOME(?=\/|$)/;
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
  } catch {
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
  let command = newCommand(false);
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
      command = newCommand(false);
      index += 1;
      continue;
    }
    folder = finish(command, operator, folder, result);
    command = newCommand(operator === "|" || operator === "|&");
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
function newCommand(isPipedIn) {
  return { words: [], redirects: [], isPipedIn };
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
  const stdin = here !== undefined ? { kind: "text", text: here.target.text } : command.isPipedIn ? { kind: "pipe" } : undefined;
  const changed = addCommand(first, args, folder, stdin, result);
  const isPiped = command.isPipedIn || operator === "|" || operator === "|&" || operator === "&";
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
  if (program === "xargs" && stdin?.kind !== "text")
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
    const readsCodeFromPipe = stdin?.kind === "pipe" && (script === undefined || script.text === "-");
    if (flags.some((flag) => inlineFlags.includes(flag)) || stdin?.kind === "text" || readsCodeFromPipe)
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
  if (stdin?.kind === "text")
    parseLine(stdin.text, folder, result);
  if (stdin?.kind === "pipe")
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
  if (dynamicPattern.test(joined.replace(homePrefix, "")))
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
  const absolute = (path, folder = workspace.cwd) => resolve(folder, expandHome(path, workspace.home));
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
function inputOf(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
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
  const stat = await fs.stat(path).catch(() => {
    return;
  });
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
var permissionEvents = ["tool.check", "classic.PermissionRequest"];
var flags = ["suppressOriginalPrompt", "reloadSkills", "retry"];
var readFields = {
  SessionStart: ["additionalContext", "initialUserMessage", "sessionTitle", "watchPaths", "reloadSkills"],
  SessionEnd: [],
  UserPromptSubmit: ["additionalContext", "sessionTitle", "suppressOriginalPrompt"],
  InstructionsLoaded: [],
  PreToolUse: ["additionalContext", "permissionDecision", "permissionDecisionReason", "updatedInput"],
  PermissionRequest: ["decision"],
  PermissionDenied: ["retry"],
  PostToolUse: ["additionalContext", "updatedToolOutput", "updatedMCPToolOutput"],
  PostToolUseFailure: ["additionalContext"],
  PostToolBatch: ["additionalContext"],
  SubagentStart: ["additionalContext"],
  SubagentStop: ["additionalContext"],
  Notification: [],
  PreCompact: [],
  Stop: ["additionalContext"],
  StopFailure: [],
  CwdChanged: [],
  FileChanged: []
};
function classicHook(name, event, hook, claude, calls) {
  const hookInputOf = async (e) => {
    if (event !== "PostToolUse" && event !== "PostToolUseFailure")
      return e;
    const input = e;
    const cwd2 = calls.cwdOf(input.tool_use_id) ?? input.cwd;
    return { ...input, files: await callFiles(name, claude, { tool: input.tool_name, input: inputOf(input.tool_input) }, cwd2) };
  };
  const resultOf = async (e) => {
    const answer = await hook(await hookInputOf(e));
    if (answer === undefined)
      return;
    if (answer.systemMessage !== undefined)
      claude.ui.log(answer.systemMessage);
    return classicResult(event, answer);
  };
  const routed = async (e, next) => {
    const ours = await resultOf(e).catch((error) => {
      const reason = `${name}: the ${event} hook failed: ${messageOf(error)}`;
      if (event === "PermissionRequest")
        return { decision: { behavior: "deny", message: reason } };
      claude.ui.log(reason);
      return;
    });
    if (ours === undefined)
      return next(e);
    return mergeClassic(await next(e), ours);
  };
  return routed;
}
function preToolUseHook(name, hook, claude, calls, held) {
  return async (e, next) => {
    let ours;
    try {
      const answer = await hook(await preToolUseInput(name, e, claude, calls.agentOf));
      if (answer?.systemMessage !== undefined)
        claude.ui.log(answer.systemMessage);
      ours = answer === undefined ? {} : classicResult("PreToolUse", answer);
    } catch (error) {
      return { deny: `${name}: the PreToolUse hook failed: ${messageOf(error)}` };
    }
    if (typeof ours["deny"] === "string")
      return { deny: ours["deny"] };
    const decided = heldDecisionOf(ours);
    if (decided !== undefined && held === undefined) {
      return { deny: `${name}: the PreToolUse hook answered permissionDecision "${decided.decision}", so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod.` };
    }
    const updated = ours["updatedInput"];
    const reserved = Object.fromEntries(Object.entries(e).filter(([key]) => reservedKeys.includes(key)));
    const earlier = held?.get(e.tool_use_id);
    if (decided !== undefined)
      held?.set(e.tool_use_id, earlier !== undefined && strictness.indexOf(earlier.decision) >= strictness.indexOf(decided.decision) ? earlier : decided);
    let result;
    try {
      result = await next(updated === undefined ? e : { ...reserved, ...updated });
    } finally {
      if (decided !== undefined)
        held?.delete(e.tool_use_id);
    }
    const context = ours["additionalContext"];
    if (context === undefined || result.deny !== undefined)
      return result;
    return { ...result, context: [...result.context ?? [], ...context] };
  };
}
function heldDecisionHook(held) {
  return async (e, next) => {
    const below = await next(e);
    const ours = e.tool_use_id === undefined ? undefined : held.get(e.tool_use_id);
    return ours === undefined || below.decision === "deny" ? below : ours;
  };
}
function heldDecisionOf(ours) {
  if (ours["allow"] !== undefined)
    return { decision: "allow" };
  if (typeof ours["ask"] !== "string")
    return;
  return ours["ask"] === "" ? { decision: "ask" } : { decision: "ask", reason: ours["ask"] };
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
async function preToolUseInput(name, envelope, claude, agentOf) {
  const { tool, tool_use_id } = envelope;
  const [session_id, cwd2, { agentId, agentType }] = await Promise.all([claude.session.id(), claude.session.cwd(), agentOf(tool_use_id)]);
  const tool_input = toolInputOf(envelope);
  return {
    session_id,
    cwd: cwd2,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input,
    tool_use_id,
    ...agentId === undefined ? {} : { agent_id: agentId },
    ...agentType === undefined ? {} : { agent_type: agentType },
    files: await callFiles(name, claude, { tool, input: tool_input }, cwd2)
  };
}
async function callFiles(name, claude, use, cwd2) {
  try {
    const home = await claude.env.home();
    if (home === undefined)
      throw new Error("HOME is not set, so ~ in a path has no meaning.");
    const { shell, reads, writes } = callEffects(use, { cwd: cwd2, home, fs: claude.fs });
    const known = (accesses) => accesses.map(({ path }) => path).filter((path) => shell === undefined || !dynamicPattern.test(path));
    const read = await Promise.all(known(reads).map(async (path) => (await claude.fs.stat(path).catch(() => {
      return;
    }))?.kind === "file" ? [path] : []));
    return { read: read.flat(), changed: known(writes) };
  } catch (error) {
    claude.ui.log(`${name}: the ${use.tool} call lists no files: ${messageOf(error)}`, { to: "debug" });
    return { read: [], changed: [] };
  }
}
function classicResult(event, answer) {
  const result = {};
  const unread = (field) => new Error(`it answered ${field}, which ${event} does not read. Remove it from the answer.`);
  if (event === "PreToolUse") {
    if (answer.continue === false || answer.stopReason !== undefined)
      throw unread("continue or stopReason");
    if (answer.decision === "block")
      result["deny"] = answer.reason ?? "";
  } else {
    if (answer.continue === false)
      result["preventContinuation"] = true;
    if (answer.stopReason !== undefined)
      result["stopReason"] = answer.stopReason;
    if (answer.decision === "block")
      result["block"] = answer.reason ?? "";
  }
  const specific = answer.hookSpecificOutput ?? {};
  if (specific.hookEventName !== undefined && specific.hookEventName !== event) {
    throw new Error(`it answered hookSpecificOutput.hookEventName "${specific.hookEventName}". Set it to "${event}" or leave it out.`);
  }
  for (const [field, value] of Object.entries(specific)) {
    if (field === "hookEventName" || value === undefined || value === false && flags.includes(field))
      continue;
    if (!readFields[event].includes(field))
      throw unread(`hookSpecificOutput.${field}`);
    if (field === "additionalContext")
      result["additionalContext"] = [value];
    else if (field === "permissionDecision") {
      const reason = specific.permissionDecisionReason ?? "";
      result[value] = value === "allow" ? true : reason;
    } else if (field !== "permissionDecisionReason")
      result[field] = value;
  }
  return result;
}
var strictness = ["allow", "ask", "deny"];
function mergeClassic(below, ours) {
  const merged = { ...below, ...ours };
  const context = [...below["additionalContext"] ?? [], ...ours["additionalContext"] ?? []];
  if (context.length > 0)
    merged["additionalContext"] = context;
  return merged;
}

// node_modules/@cmodjs/core/runtime/grants.js
class PermissionRefused extends Error {
}
var configFiles = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"];
var startsTurns = ["CronCreate"];
var ownSchedule = ["CronDelete", "CronList"];
async function checkGrant(grants, call, item) {
  if (item === undefined)
    return;
  await grants.refresh();
  if (!isCovered(grants.granted(), item, grants.home))
    throw new PermissionRefused(refusal(grants, call, item));
}
function checkWrite(grants, call, path) {
  return checkGrant(grants, call, writeItem(grants, path));
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
        await gate(`http.fetch(${url})`, `network:${init?.socketPath ?? hostOf(url)}`);
        return claude.http.fetch(url, init);
      }
    },
    config: {
      ...claude.config,
      set: async (args) => {
        await gate("config.set", "config");
        return claude.config.set(args);
      }
    },
    session: {
      ...claude.session,
      messages: async (...args) => {
        await gate("session.messages", "conversation");
        return claude.session.messages(...args);
      },
      append: async (args) => {
        await gate("session.append", "prompt");
        return claude.session.append(args);
      }
    },
    prompt: {
      submit: async (args) => {
        await gate("session.submit", "prompt");
        return claude.prompt.submit(args);
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
        await gate("agent.spawn", "agents");
        return claude.agent.spawn(args);
      }
    },
    tool: {
      ...claude.tool,
      call: async (input) => {
        const item = startsTurns.includes(input.tool) ? "prompt" : ownSchedule.includes(input.tool) ? undefined : "tools";
        await gate(`tool.call(${input.tool})`, item);
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
      const running = await started.catch(() => {
        return;
      });
      return await running?.return?.(value) ?? { done: true, value };
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
  if (configFiles.some((file) => `${root}/${file}` === path))
    return "config";
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
  suppressOriginalPrompt: "prompt",
  updatedToolOutput: "prompt",
  updatedMCPToolOutput: "prompt",
  updatedInput: "tools",
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
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
function expanded(path, home) {
  return path.startsWith("~/") && home !== undefined ? `${home}${path.slice(1)}` : path;
}

// node_modules/@cmodjs/core/runtime/programs.js
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
      names = new Set((await claude.fs.list(programs).catch(() => [])).map((entry) => entry.name));
      folder = programs;
    }
  };
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
    return { kind: "frontmatter" };
  if (hashComments.includes(extension) || hashCommentNames.includes(name))
    return { kind: "comment", prefix: "#" };
  if (slashComments.includes(extension))
    return { kind: "comment", prefix: "//" };
  if (dashComments.includes(extension))
    return { kind: "comment", prefix: "--" };
  if (extension === "" && firstLine?.startsWith("#!") === true)
    return { kind: "comment", prefix: "#" };
  return { kind: "sidecar" };
}
function readMetadata(text, format2) {
  const lines = text.split(`
`);
  if (format2.kind === "comment") {
    const region2 = commentRegion(lines, format2.prefix);
    return { metadata: region2 === undefined ? {} : asRecord(mapEntries(region2.lines, region2.start + 2, 0)) };
  }
  const region = format2.kind === "frontmatter" ? frontmatterRegion(lines) : { start: -1, end: lines.length, lines };
  if (region === undefined)
    return { metadata: {} };
  const block = metadataBlock(region);
  const name = format2.kind === "frontmatter" ? topLevelScalar(region, "name") : undefined;
  return { metadata: block === undefined ? {} : asRecord(block.entries), ...name === undefined ? {} : { name } };
}
function writeMetadata(text, format2, metadata) {
  const lines = text.split(`
`);
  const entries = Object.entries(metadata);
  if (format2.kind === "comment") {
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
  if (format2.kind === "sidecar") {
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
    } catch {
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
  } catch {
    return;
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
  if (path === "~" || path.startsWith("~/")) {
    if (places.home === undefined)
      throw new Error(`${path} starts with ~, and HOME is not set. Start Claude Code with HOME set.`);
    return resolve(`${places.home}${path.slice(1)}`);
  }
  return path.startsWith("/") ? resolve(path) : resolve(places.projectRoot(), path);
}
function createModFiles({ name, claude, places, checkWrite: checkWrite2 }) {
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
    const format2 = formatOf(realPath, firstLine);
    const holder = format2.kind === "sidecar" ? `${realPath}${sidecarSuffix}` : realPath;
    const sidecar = format2.kind === "sidecar" ? await claude.fs.stat(holder).catch(() => {
      return;
    }) : undefined;
    return { realPath, format: format2, holder, signature: `${stat.mtimeMs}:${stat.size}:${sidecar?.kind === "file" ? `${sidecar.mtimeMs}:${sidecar.size}` : ""}` };
  };
  const textOf = async (holder) => (await claude.fs.stat(holder).catch(() => {
    return;
  }))?.kind === "file" ? claude.fs.read(holder) : "";
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
        claude.ui.log(`${name}: ${failure}`);
      logged.add(failure);
    }
    cache.set(path, { signature: located.signature, read });
    return read;
  };
  const matchesOf = async (pattern) => {
    const absolute = resolvedPath(pattern, places);
    const scanned = export_picomatch.scan(absolute);
    if (!scanned.isGlob)
      return (await claude.fs.stat(absolute).catch(() => {
        return;
      }))?.kind === "file" ? [absolute] : [];
    const isMatch = export_picomatch(absolute, { dot: true });
    const entersSkipped = skippedFolders.filter((folder) => scanned.glob.split("/").includes(folder));
    const maxDepth = scanned.glob.includes("**") ? Number.POSITIVE_INFINITY : scanned.glob.split("/").length;
    const found = [];
    const visited = new Set;
    const walk2 = async (folder, depth) => {
      const real = (await claude.fs.stat(folder, { resolve: true }).catch(() => {
        return;
      }))?.realPath ?? folder;
      if (visited.has(real))
        return;
      visited.add(real);
      const entries = await claude.fs.list(folder).catch(() => []);
      await Promise.all(entries.map(async (entry) => {
        const path = `${folder}/${entry.name}`;
        const kind = entry.isLink === true ? (await claude.fs.stat(path).catch(() => {
          return;
        }))?.kind : entry.kind;
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
    if ((await claude.fs.stat(base).catch(() => {
      return;
    }))?.kind === "dir")
      await walk2(base, 0);
    return found;
  };
  return {
    async find(glob) {
      const patterns = typeof glob === "string" ? [glob] : glob;
      const paths = [...new Set((await Promise.all(patterns.map(matchesOf))).flat())].sort();
      const kept = paths.filter((path) => !(path.endsWith(sidecarSuffix) && paths.includes(path.slice(0, -sidecarSuffix.length))));
      return Promise.all(kept.map(async (path) => {
        const read = await readEntry(path);
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
var drawing;
function drawWith(table, draw, markdown2) {
  const outer = drawing;
  drawing = { table, markdown: markdown2 };
  try {
    return draw();
  } finally {
    drawing = outer;
  }
}
function element(name) {
  const construct = (props) => {
    if (drawing === undefined)
      throw new Error(`${name} was called outside a render. Use it inside a pane's render or a slot's component.`);
    if (name === "Markdown" && drawing.markdown !== undefined)
      return drawing.markdown(props);
    return drawing.table[name](props);
  };
  return construct;
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
var installerPaneId = "cmod-installer";
function createInstaller(name, claude) {
  let page;
  let isOpen = false;
  const show = async (build, cancelled) => {
    page?.cancel();
    const answer = new Promise((resolve2) => {
      const done = (value) => {
        if (page === shown)
          page = undefined;
        resolve2(value);
      };
      const shown = { ...build(done), cancel: () => done(cancelled) };
      page = shown;
    });
    if (!isOpen) {
      isOpen = true;
      await claude().ui.open({ id: installerPaneId, title: `Install ${name}`, focus: true, holdToasts: true, closeOnEscape: true });
    }
    claude().ui.invalidate("ui.render");
    return answer;
  };
  const frame = (title, body, actions) => Box({ flexDirection: "column", gap: 1, paddingX: 1, children: [Text({ bold: true, children: title }), ...body, Box({ gap: 3, children: actions })] });
  const bullet = (text) => Text({ children: [Text({ color: "claude", children: "◆ " }), text] });
  return {
    draws: (e) => e.component === "Pane" && e.requestId === installerPaneId,
    draw(e) {
      return drawWith(claude().ui.resolve(e), () => page?.draw(e.props) ?? Text({ dimColor: true, children: `${name} is installing.` }));
    },
    closed(id) {
      if (id !== installerPaneId)
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
          if (option.kind === "secret")
            return Box({ flexDirection: "column", children: [label, Text({ dimColor: true, children: `Set it in /config, where Claude Code keeps it in your keychain, then press Next.` })] });
          const failure = failures.get(key);
          const field = Input({
            key: `option:${key}`,
            label: "› ",
            placeholder: option.kind === "choice" ? (option.choices ?? []).join(", ") : option.kind === "toggle" ? "true or false" : option.kind === "list" ? "comma-separated" : "",
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
            const isDone = await Promise.resolve(step.isDone(mod)).catch(() => false);
            if (isDone)
              answer(true);
            else {
              notice = `Finish ${step.title} first.`;
              claude().ui.invalidate("ui.render");
            }
          };
          return frame(`${step.title}  (${index} of ${total})`, [body, ...notice === undefined ? [] : [Text({ color: "warning", children: notice })]], [Button({ key: "not-now", hotkey: "n", label: "Not now", onPress: () => answer(false) }), Button({ key: "next", hotkey: "x", label: index === total ? "Finish" : "Next", onPress: () => void next() })]);
        }
      }), false);
    },
    async close() {
      page = undefined;
      if (!isOpen)
        return;
      isOpen = false;
      await claude().ui.close({ id: installerPaneId });
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
function createOptions({ name, declared, fromClaude, claude, changed }) {
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
    const ignore = (reason) => claude.ui.log(`${path} ${reason}`);
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
      else if (option.kind === "secret")
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
  return option.default ?? (option.kind === "list" ? Object.freeze([]) : option.kind === "number" ? undefined : "");
}

// node_modules/@cmodjs/core/runtime/router.js
function createRouter() {
  const hooks = new Map;
  return {
    add(event, hook) {
      const chain = hooks.get(event) ?? [];
      chain.push(hook);
      hooks.set(event, chain);
    },
    has: (event) => hooks.has(event),
    dispatch(event, e, next) {
      const chain = hooks.get(event);
      const call = async (index, current) => {
        const hook = chain?.[index];
        if (hook === undefined)
          return next(current);
        return hook(current, (passed) => call(index + 1, passed));
      };
      return call(0, e);
    }
  };
}

// node_modules/@cmodjs/core/runtime/state.js
var lifetimes = ["memory", "session", "project", "global"];
var keptPerValue = 20;
var listeners = new WeakMap;
function createState({ name, initial, session, root, claude, changed: redraw }) {
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
    turn = run.catch(() => {
      return;
    });
    return run;
  };
  const ownersKey = (lifetime, key) => `${name}.${key}.${lifetime === "project" ? "projects" : "sessions"}.`;
  const storeKey = (lifetime, key, owner) => lifetime === "global" ? `${name}.${key}` : `${ownersKey(lifetime, key)}${owner}`;
  const read = (lifetime, key, owner) => claude.store.get(storeKey(lifetime, key, owner));
  const write = async (lifetime, key, value, owner) => {
    if (lifetime === "global")
      return claude.store.set(storeKey(lifetime, key, owner), value);
    await claude.store.delete(storeKey(lifetime, key, owner));
    await claude.store.set(storeKey(lifetime, key, owner), value);
    const owners = (await claude.store.keys()).filter((stored) => stored.startsWith(ownersKey(lifetime, key)));
    for (const oldest of owners.slice(0, -keptPerValue))
      await claude.store.delete(oldest);
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
  const copySession = async (nextSession) => {
    for (const key of Object.keys(declared.session)) {
      const saved = await read("session", key, sessionId);
      if (saved !== undefined)
        await write("session", key, saved, nextSession);
    }
  };
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
          claude.ui.log(`${name} could not keep state.${lifetime}.${key}: ${messageOf(error)}. Keep only JSON data in mod.state.`);
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
    load: () => inTurn(() => loadGroups(lifetimes, { root: projectRoot, session: sessionId })),
    moveTo: (nextRoot) => inTurn(async () => nextRoot === projectRoot ? undefined : loadGroups(["project"], { root: nextRoot, session: sessionId })),
    switchSession: (nextSession, source) => inTurn(async () => {
      if (nextSession === sessionId)
        return;
      if (source === "fork")
        await copySession(nextSession);
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

// node_modules/@cmodjs/core/ui/components.js
function Tabs({ tabs, selected, onSelect, children }) {
  const row = tabs.map((tab, index) => {
    const hotkey = index < 9 ? `${index + 1}` : undefined;
    return tab.key === selected ? Text({ children: [...hotkey === undefined ? [] : [Text({ color: "claude", children: hotkey }), ": "], Text({ bold: true, underline: true, children: tab.label })] }) : Button({ plain: true, dimColor: true, key: `tab:${tab.key}`, ...hotkey === undefined ? {} : { hotkey }, label: tab.label, onPress: () => onSelect(tab.key) });
  });
  return Box({ flexDirection: "column", gap: 1, children: [Box({ gap: 3, children: row }), children] });
}
function ProgressBar({ done, total, width = 24 }) {
  const filled = total > 0 ? Math.round(Math.min(done / total, 1) * width) : 0;
  return Text({ children: [Text({ color: "claude", children: "█".repeat(filled) }), Text({ color: "subtle", children: "░".repeat(width - filled) }), "  ", Text({ dimColor: true, children: `${done}/${total}` })] });
}

// node_modules/@cmodjs/core/runtime/ui.js
var spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
var spinnerMs = 100;
var bullet = "⏺";
var widestBar = 30;
var narrowestBar = 10;
var sizeKeys = ["columns", "rows"];
function createProgress(claude) {
  const lines = [];
  let frame = 0;
  let timer;
  const changed = () => {
    const isSpinning = lines.some((line) => line.failure === undefined && line.waiting === undefined);
    if (isSpinning && timer === undefined) {
      timer = claude.clock.every(spinnerMs, () => {
        frame += 1;
        claude.ui.invalidate("ui.render");
      });
    }
    if (!isSpinning && timer !== undefined) {
      timer.cancel();
      timer = undefined;
    }
    claude.ui.invalidate("ui.render");
  };
  return {
    get isShown() {
      return lines.length > 0;
    },
    start(title) {
      const line = { title, step: undefined, waiting: undefined, failure: undefined };
      lines.push(line);
      changed();
      return {
        report(step) {
          line.step = step;
          line.waiting = undefined;
          changed();
        },
        wait(text) {
          line.waiting = text;
          changed();
        },
        fail(reason, fix) {
          line.failure = { reason, fix };
          changed();
        },
        end() {
          const index = lines.indexOf(line);
          if (index >= 0)
            lines.splice(index, 1);
          changed();
        }
      };
    },
    draw(drawn, table, columns) {
      return drawWith(table, () => Box({ flexDirection: "column", children: [drawn, ...lines.map((line) => drawLine(line, frame, columns))] }));
    }
  };
}
function drawLine(line, frame, columns) {
  const title = Text({ bold: true, children: line.title });
  if (line.failure !== undefined) {
    return Box({
      flexDirection: "column",
      children: [
        Box({ children: [Box({ minWidth: 2, children: Text({ color: "error", children: "✗" }) }), Text({ children: [title, "  ", Text({ color: "error", children: line.failure.reason })] })] }),
        Box({ paddingLeft: 2, children: Text({ dimColor: true, children: line.failure.fix }) })
      ]
    });
  }
  if (line.waiting !== undefined) {
    return Text({ wrap: "truncate-end", children: [Text({ color: "warning", children: "◌" }), " ", title, "  ", Text({ dimColor: true, children: line.waiting })] });
  }
  const glyph = Text({ color: "claude", children: spinner[frame % spinner.length] });
  if (line.step === undefined)
    return Text({ wrap: "truncate-end", children: [glyph, " ", title, Text({ dimColor: true, children: "…" })] });
  const { done, total, label = "" } = line.step;
  const width = barWidth(columns, `${line.title}${done}/${total}${label}`.length);
  return Text({ wrap: "truncate-end", children: [glyph, " ", title, "  ", ProgressBar({ done, total, width }), ...label === "" ? [] : ["  ", label]] });
}
function barWidth(columns, textLength) {
  if (columns === undefined)
    return widestBar;
  const spacing = 2 + 2 + 2 + 2;
  return Math.max(narrowestBar, Math.min(widestBar, columns - textLength - spacing));
}
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
function createUi({ name, claude, router, progress, announce, mod }) {
  const panes = new Map;
  const paneLogs = new Map;
  const openPanes = new Set;
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
        claude.ui.log(`${name}: the ${what} render ${failure}`);
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
  const routeMarkdown = (kind) => {
    if (read !== undefined)
      return;
    const reader = kind.createReader();
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
      claude.ui.log(`${name}: the ${pane.title} pane's ${handler} threw: ${messageOf(error)}`);
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
          async open(options) {
            const { isPlaced } = await openAt(pane, paneSize(pane, mod().state), options?.focus);
            if (isPlaced)
              openPanes.add(pane.id);
          },
          async close() {
            await claude.ui.close({ id: pane.id });
            openPanes.delete(pane.id);
          },
          toggle: (options) => openPanes.has(pane.id) ? handle2.close() : handle2.open(options)
        };
        return handle2;
      },
      render(slot, Component) {
        const place = slot;
        const feature = "markdown" in place ? `a render of markdown ${place.markdown.name}` : `a render of ${place.component}`;
        if (renders.has(feature))
          throw new Error(`${name}: ${feature} is already added. Render each slot once.`);
        renders.add(feature);
        announce(feature);
        if ("markdown" in place) {
          const kind = place.markdown;
          markdownRenders.set(kind.type, { Component, log: logOnce(`markdown ${kind.name}`) });
          routeMarkdown(kind);
          return;
        }
        const { component } = place;
        const log = logOnce(component);
        router.add("ui.render", async (e, next) => {
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
      },
      toast: (text, options) => claude.ui.toast(text, options),
      async progress(title, task) {
        const line = progress.start(title);
        try {
          return await task((step) => line.report(step));
        } finally {
          line.end();
        }
      },
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
      if (panes.size === 0)
        return;
      for (const open of await claude.ui.panes()) {
        if (open.isPlaced && panes.has(open.id))
          openPanes.add(open.id);
      }
    }
  };
}

// node_modules/@cmodjs/core/runtime/lifecycle.js
var cmodPluginName = "cmod";
var announcedKey = "cmod:announced";
var cmodCheckMs = 1000;
var cmodWaitMs = 60000;
var sessionStartHoldMs = 1e4 - 1000;
var dependencyCallMs = 30000;
var cannotStart = /failed to start: /;
var missingPath = /(?:^|: )(?:ENOENT|ENOTDIR)\b/;
var shellTools = ["Bash", "PowerShell"];
async function readPlugin(claude) {
  const { name, root } = claude.plugin;
  const read = async (path) => {
    const stat = await claude.fs.stat(path).catch((error) => {
      if (missingPath.test(messageOf(error)))
        return;
      throw error;
    });
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
    throw new Error(`${path} is not JSON (${messageOf(error)}). Fix the file, then run /reload-plugins.`);
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
function createLifecycle(definition, checksPermissions = () => true, options = {}, asksPerson = true) {
  let router = createRouter();
  let phase = "starting";
  let runtime;
  let programs;
  let plugin;
  const granted = new Set;
  let line;
  let activation;
  let mod;
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
  const showLine = () => {
    line ??= runtime?.progress.start(`Installing ${definition.name}`);
    return line;
  };
  const endLine = () => {
    line?.end();
    line = undefined;
  };
  const fail = (reason, fix) => {
    phase = "failed";
    failure ??= new Error(`${definition.name}: ${reason}${/[.!?]$/.test(reason) ? "" : "."} ${fix}`);
    showLine().fail(reason, fix);
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
      if (parseEvent(text).kind === "done")
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
    const value = option.kind === "number" ? Number(text) : option.kind === "toggle" ? text.trim() === "true" : option.kind === "list" ? text.split(",").map((item) => item.trim()).filter((item) => item !== "") : text;
    const misfit = option.kind === "toggle" && !["true", "false"].includes(text.trim()) ? "takes true or false" : fitsOption(option, value);
    if (misfit !== undefined)
      return `${option.title} ${misfit}.`;
    const saved = await claude().config.set({ key: `${plugin.name}.${key}`, value });
    return saved.deny;
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
  const pendingSteps = async (active) => {
    const pending = [];
    for (const step of definition.installer ?? [])
      if (!await Promise.resolve(step.isDone(active)).catch(() => false))
        pending.push(step.title);
    return pending;
  };
  const runSteps = async (active) => {
    const steps = asksPerson ? definition.installer ?? [] : [];
    for (const [index, step] of steps.entries()) {
      if (await Promise.resolve(step.isDone(active)).catch(() => false))
        continue;
      const isAnswered = (await claude().session.surfaces()).length > 0 && await installer.step(active, step, index + 1, steps.length);
      if (!isAnswered) {
        claude().ui.log(`${definition.name} needs ${steps.length - index === 1 ? "one more step" : `${steps.length - index} more steps`}, starting with ${step.title}. Run /mods ${definition.name} to finish.`);
        break;
      }
    }
    await installer.close();
  };
  const activate = async () => {
    if (runtime === undefined || plugin === undefined)
      return;
    const activeRouter = createRouter();
    const active = await createMod(definition, { ...runtime, router: activeRouter, dataFolder: dataFolder(plugin.store, plugin.name), steps: plugin.steps, granted, refreshGrants, checksPermissions, options: pluginOptions }).catch(async (error) => {
      if (error instanceof MissingOptions && await askOptions(error))
        return;
      fail(messageOf(error), error instanceof MissingOptions ? `Set ${error.keys.length === 1 ? "it" : "them"} in /config.` : "Fix it, then run /reload-plugins.");
      throw error;
    });
    if (active === undefined)
      return activate();
    const { added } = active;
    mod = active.mod;
    router = activeRouter;
    phase = "active";
    runtime.claude.ui.invalidate("ui.render");
    endLine();
    runSteps(active.mod).catch((error) => claude().ui.log(`${definition.name}: its installer stopped: ${messageOf(error)}`));
    const missed = missedSessionStart;
    missedSessionStart = undefined;
    const lateAnswer = missed === undefined ? {} : await activeRouter.dispatch("classic.SessionStart", missed, async () => ({})).catch((error) => {
      claude().ui.log(`${definition.name}: the SessionStart hook failed: ${messageOf(error)}`);
      return {};
    });
    if (Object.keys(lateAnswer).length > 0) {
      runtime.claude.ui.log(`${definition.name} started after Claude Code's SessionStart, so Claude Code did not read the answer of its SessionStart hooks.`, { to: "debug" });
    }
    const version = plugin.version ?? "";
    if (await runtime.claude.store.get(announcedKey) === version)
      return;
    await runtime.claude.store.set(announcedKey, version);
    runtime.claude.ui.toast(`${definition.name} is ready`);
    if (added.length > 0)
      runtime.claude.ui.log(`${definition.name} added ${listed(added)}.`);
  };
  const updatesToShow = async () => {
    const [home, configHome] = await Promise.all([claude().env.home(), claude().env.configHome()]);
    const configRoot = configHome ?? `${home ?? ""}/.claude`;
    const known = await claude().fs.read(`${configRoot}/plugins/known_marketplaces.json`).then((text) => JSON.parse(text), () => {
      return;
    });
    return updatesToTurnOn(marketplaceOf(claude().plugin.root, claude().plugin.name), await claude().settings.read({ source: "user" }), known);
  };
  const askConsent = async (event) => {
    const name = definition.name;
    if ((await claude().session.surfaces()).length === 0) {
      showLine().wait(`Waiting for consent: run cmod install ${name}`);
      claude().ui.log(`${name} waits for consent to run ${event.install}. Run cmod install ${name} in a terminal.`);
      return;
    }
    showLine().wait("Waiting for your answer");
    if (await installer.consent({ ...event, updates: await updatesToShow().catch(() => {
      return;
    }) }))
      return install(event.sha256);
    await installer.close();
    phase = "declined";
    endLine();
    claude().ui.log(`${name} is not installed. Run cmod install ${name} to install it.`);
  };
  const install = async (consent) => {
    if (plugin === undefined)
      return;
    if (plugin.name === cmodPluginName)
      return bootstrap(plugin.root);
    phase = "installing";
    const found = await cmodVersion(claude());
    if (!fits(found))
      return waitForcmod(found);
    endLine();
    const progress = showLine();
    let outcome;
    const argv = ["cmod", "setup", plugin.root, "--events", ...consent === undefined ? [] : ["--consent", consent]];
    const { code, lastError } = await readLines(claude().process.spawn({ argv }), (text) => {
      const event = parseEvent(text);
      if (event.kind === "progress")
        progress.report(event);
      if (event.kind === "done" || event.kind === "failed" || event.kind === "needs-consent")
        outcome = event;
    });
    if (outcome?.kind === "done") {
      for (const item of plugin.steps.permissions ?? [])
        granted.add(item);
      return finish2();
    }
    if (outcome?.kind === "needs-consent")
      return askConsent(outcome);
    const reason = outcome?.kind === "failed" ? outcome.message : `cmod setup ${formatExit(code, lastError)}`;
    fail(reason, `Fix the cause, then run: cmod install ${definition.name}`);
  };
  const fits = (found) => found !== undefined && isAtLeast(found, oldestCmodFor(plugin?.steps ?? {}));
  const waitForcmod = (found) => {
    phase = "waiting";
    showLine().wait("Waiting for cmod");
    let latest = found;
    let check;
    const stop = () => {
      timer.cancel();
      longWait.cancel();
    };
    const timer = claude().clock.every(cmodCheckMs, () => {
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
    const longWait = claude().clock.after(cmodWaitMs, () => showLine().wait(latest === undefined ? "Still waiting for cmod to download cmod. See cmod's own line." : `PATH finds cmod ${latest}, and ${definition.name} needs cmod ${oldestCmodFor(plugin?.steps ?? {})} or later. Run npm i -g @cmodjs/cli, or put ~/.local/bin ahead of the old cmod on PATH.`));
  };
  const bootstrap = async (root) => {
    const progress = showLine();
    phase = "installing";
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ["sh", "-c", "./setup/bootstrap.sh"], cwd: root }), (text) => {
      const event = parseEvent(text);
      if (event.kind === "progress")
        progress.report(event);
    });
    if (code === 0)
      return finish2();
    fail(`bootstrap ${formatExit(code, lastError)}`, `Run ./setup/bootstrap.sh in ${root} to see the whole log.`);
  };
  const report = (error) => {
    failure = error;
    if (phase !== "failed")
      fail(messageOf(error), `Run cmod install ${definition.name} in a terminal to see the whole log.`);
  };
  let consentMs = 0;
  const consentStamp = async (path) => {
    const stat = await claude().fs.stat(path).catch(() => {
      return;
    });
    return stat?.kind === "file" ? stat.mtimeMs : 0;
  };
  const refreshGrants = async () => {
    if (plugin === undefined || plugin.name === cmodPluginName)
      return;
    const path = consentPath(plugin.store);
    const modifiedMs = await consentStamp(path);
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
      claude().ui.log(`${definition.name} answered ${part} without your grant to "${permissionWords(item)}", so cmod dropped it. ${fix}`);
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
  const holdSessionStart = () => new Promise((resolve2) => {
    const limit = claude().clock.after(sessionStartHoldMs, resolve2);
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
    async start(claudeCalls, read) {
      if (runtime !== undefined)
        return;
      programs = locatingPrograms(claudeCalls);
      runtime = { claude: programs.claude, progress: createProgress(claudeCalls) };
      try {
        await programs.refresh();
        const started = await read(claudeCalls).catch((error) => {
          report(error);
          return;
        });
        if (started === undefined)
          return;
        plugin = started;
        for (const item of started.granted)
          granted.add(item);
        consentMs = await consentStamp(consentPath(started.store));
        if (started.isInstalled) {
          shouldRecord = started.shouldRecord;
          if (shouldRecord)
            record();
          return await activate().catch(report);
        }
        if (started.version === undefined)
          return fail("no version to install", 'Add "version" to .claude-plugin/plugin.json, then run /reload-plugins.');
        install().catch(report);
      } finally {
        settleStart();
      }
    },
    async route(event, e, next) {
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
      await (event === "classic.SessionStart" ? holdSessionStart() : whenActive());
      if (event === "classic.SessionStart" && phase !== "active")
        missedSessionStart = e;
      if (event === "cmod.call" && phase !== "active" && e.to === definition.name) {
        const isStopped = phase === "declined" || phase === "failed";
        return { deny: isStopped ? notInstalled(definition.name) : `${definition.name} is installing. Try again when it's ready.` };
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
      if (checksAnswers(event) && phase === "active")
        return checkedRoute(event, e, next);
      const answer = router.dispatch(event, e, next);
      const render = e;
      if (event !== "ui.render" || render.component !== "AbovePrompt" || runtime === undefined || !runtime.progress.isShown)
        return answer;
      return runtime.progress.draw(await answer, runtime.claude.ui.resolve(render), render.viewport?.columns);
    }
  };
}
async function createMod(definition, runtime) {
  const { router, progress } = runtime;
  const claude = checkingKeys(runtime.claude, definition.name, runtime.steps.keys ?? {});
  const added = [];
  const hookEvents = [];
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
    freeFolders: () => [modState.root, runtime.dataFolder]
  };
  const checked = checkingGrants(claude, grants);
  const files = createModFiles({
    name: definition.name,
    claude,
    places: { home, configRoot, projectRoot: () => modState.root },
    checkWrite: (path) => checkWrite(grants, `metadata.update(${path})`, path)
  });
  const pages = new Map;
  const settingsPages = {
    page(page) {
      if (pages.has(page.id))
        throw new Error(`${definition.name}: the settings page "${page.id}" is already added. Give each page its own id.`);
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
  const area = createUi({ name: definition.name, claude, router, progress, announce, mod: () => mod });
  const modState = createState({ name: definition.name, initial: definition.state ?? {}, session, root, claude, changed: area.changed });
  const modOptions = createOptions({ name: definition.name, declared: definition.options ?? {}, fromClaude: runtime.options, claude, changed: modState.changed });
  const held = runtime.checksPermissions() ? new Map : undefined;
  const mod = {
    name: definition.name,
    state: modState.state,
    get options() {
      return modOptions.values;
    },
    dataFolder: runtime.dataFolder,
    on(event, hook, options) {
      const bounded = options?.timeoutMs === undefined ? hook : timedHook(definition.name, event, hook, checkedMs(definition.name, `the ${event} hook's timeoutMs`, options.timeoutMs), claude);
      if (!hookEvents.includes(event))
        hookEvents.push(event);
      if (event === "PreToolUse")
        router.add("tool.call", preToolUseHook(definition.name, bounded, claude, agents, held));
      else
        router.add(`classic.${event}`, classicHook(definition.name, event, bounded, claude, agents));
    },
    use: (job) => job({ mod, announce, reserveName, toolCalls: agents }),
    every(ms, hook) {
      let isRunning = false;
      return claude.clock.every(checkedMs(definition.name, "mod.every", ms), () => {
        if (isRunning)
          return;
        isRunning = true;
        Promise.resolve().then(hook).catch((error) => claude.ui.log(`${definition.name}: the every ${ms} ms hook failed: ${messageOf(error)}`)).finally(() => {
          isRunning = false;
        });
      });
    },
    ui: area.ui,
    process: {
      run: (argv, init) => checked.process.run(argv, init),
      spawn: (argv, init) => checked.process.spawn({ ...init, argv })
    },
    fs: {
      read: (path) => checked.fs.read(path),
      write: (path, text) => checked.fs.write(path, text),
      list: (path) => checked.fs.list(path),
      exists: (path) => checked.fs.exists(path),
      stat: (path, options) => checked.fs.stat(path, options),
      find: (glob) => files.find(glob)
    },
    metadata: {
      read: (path) => files.read(path),
      update: (path, change) => files.update(path, change)
    },
    http: { fetch: (url, init) => checked.http.fetch(url, init) },
    settings: settingsPages,
    session: {
      messages: (args) => args === undefined ? checked.session.messages() : checked.session.messages({ agentId: args.agentId }),
      async append(text) {
        const added2 = await checked.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
        if (added2.deny !== undefined)
          throw new Error(`${definition.name}: Claude Code refused the note: ${added2.deny}`);
      },
      async submit(text) {
        const submitted = await checked.prompt.submit({ text });
        if ("drop" in submitted && typeof submitted.drop === "string")
          throw new Error(`${definition.name}: Claude Code dropped the prompt: ${submitted.drop}`);
      }
    },
    agent: { spawn: (args) => checked.agent.spawn(args) },
    model: { complete: (completion, options) => checked.model.complete(completion, options) },
    permissions: {
      has: (name, value) => isCovered(granted, itemOf(name, value), home)
    },
    claude: { ...checked, on: (event, hook) => router.add(event, hook) },
    get projectRoot() {
      return modState.root;
    },
    get cwd() {
      return cwd2;
    },
    dependencies: dependencyCalls(claude, (call, task) => beforeDeadline(claude, { ms: dependencyCallMs }, call, task))
  };
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
      await modState.moveTo(nextRoot).catch((error) => {
        if (cwd2 === nextCwd)
          cwd2 = loadedCwd;
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
      claude.ui.log(`${definition.name} keeps the state of ${modState.root} until the next prompt or folder move: ${messageOf(error)}`);
    }
  };
  router.add("classic.SessionStart", async (e, next) => {
    await modState.switchSession(e.session_id, e.source).catch((error) => {
      claude.ui.log(`${definition.name} kept its session values from before the ${e.source}: ${messageOf(error)}`);
    });
    return next(e);
  });
  router.add("classic.UserPromptSubmit", async (e, next) => {
    staleCwd = undefined;
    await followSession();
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
    if (e.command === "cd")
      await followSession(true);
    return answer;
  });
  router.add("skill.prompt", userSkillHook(claude));
  const api = Object.fromEntries(Object.entries(definition.api ?? {}).map(([method, run]) => [method, (input) => run(input, mod)]));
  router.add("cmod.call", async (e, next) => {
    if (e.to !== definition.name)
      return next(e);
    if (e.method === settingsPagesMethod)
      return { value: [...pages].map(([id, { title }]) => ({ id, title })) };
    if (e.method === openPageMethod) {
      await settingsPages.open(String(e.input));
      return { value: null };
    }
    return answerCall(definition.name, api, e);
  });
  const agents = toolCalls(claude, router);
  const names = new Set;
  const reserveName = (kind, name, taken) => {
    const key = `${kind}:${name}`;
    if (names.has(key))
      throw new Error(taken);
    names.add(key);
  };
  await failsAs("its state did not load", () => modState.load());
  await failsAs("its options did not load", () => modOptions.load(root));
  const missing = modOptions.missing;
  if (missing.length > 0)
    throw new MissingOptions(missing, missing.map((key) => definition.options?.[key]?.title ?? key));
  await failsAs("its setup function threw", () => definition.setup(mod));
  const permissionHooks = permissionEvents.filter((event) => router.has(event));
  if (permissionHooks.length > 0 && !runtime.checksPermissions()) {
    throw new Error(`it decides permissions on ${listed(permissionHooks)}, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod`);
  }
  if (held !== undefined && hookEvents.includes("PreToolUse"))
    router.add("tool.check", heldDecisionHook(held));
  await failsAs("its open panes did not load", () => area.restorePanes());
  if (hookEvents.length > 0)
    added.push(`${hookEvents.length === 1 ? "a hook" : "hooks"} on ${listed(hookEvents)}`);
  return { mod, added };
}
function checkingKeys(claude, name, keys) {
  const bound = Object.entries(keys);
  if (bound.length === 0)
    return claude;
  const register = (command) => {
    for (const [key, commandName] of bound) {
      if (commandName === command.name && command.immediate !== true) {
        claude.ui.log(`${name}: ${key} runs /${command.name}, which waits for Claude's turn to end and adds a row to the conversation. Give /${command.name} immediate: true.`);
      }
    }
    return claude.command.register(command);
  };
  return { ...claude, command: { ...claude.command, register } };
}
var longestTimerMs = 2147483647;
function checkedMs(name, subject, ms) {
  if (!Number.isInteger(ms) || ms <= 0 || ms > longestTimerMs)
    throw new Error(`${name}: ${subject} is ${ms}. Give a whole number of milliseconds above 0 and at most ${longestTimerMs}.`);
  return ms;
}
function timedHook(name, event, hook, ms, claude) {
  return (input) => new Promise((resolve2, reject) => {
    const timer = claude.clock.after(ms, () => {
      claude.ui.log(`${name}: the ${event} hook passed its ${ms / 1000} s timeout`);
      resolve2(undefined);
    });
    Promise.resolve().then(() => hook(input)).then((answer) => {
      timer.cancel();
      resolve2(answer);
    }, (error) => {
      timer.cancel();
      reject(error);
    });
  });
}
async function failsAs(subject, step) {
  try {
    await step();
  } catch (error) {
    throw new Error(`${subject}: ${messageOf(error)}`, { cause: error });
  }
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
function lastLineOf(text) {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed.slice(trimmed.lastIndexOf(`
`) + 1).trim();
}

// node_modules/@cmodjs/core/register.js
var lifecycle;
var checksPermissions = false;
var registered;
async function startMod($, eventInput, passOn) {
  const claude = {
    plugin: { name: $.plugin.name, root: $.plugin.root },
    ui: {
      toast: (text, options) => $.ui.toast(text, options),
      status: (text) => $.ui.status(text),
      log: (text, options) => $.ui.log(text, options),
      notice: (toolUseId, text) => $.ui.notice(toolUseId, text),
      invalidate: (event) => $.ui.invalidate(event),
      ask: (question, options) => $.ui.ask(question, options),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      panes: () => $.ui.panes(),
      scroll: (args) => $.ui.scroll(args),
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
    config: { list: () => $.config.list(), set: (args) => $.config.set(args) },
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
      append: (args) => $.session.append(args)
    },
    prompt: { submit: (args) => $.prompt.submit(args) },
    model: { complete: (request, options) => $.model.complete(request, options) },
    command: { register: (command) => $.command.register(command) },
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
  await lifecycle.start(claude, readPlugin);
  return passOn(eventInput);
}
function routeToMod(_$, eventInput, passOn) {
  return lifecycle.route(passOn.event, eventInput, (passed) => passOn(passed));
}
function registerMod(addHook, definition, options) {
  checksPermissions = false;
  registered = definition;
  lifecycle = createLifecycle(definition, () => checksPermissions, options);
  addHook("session.start", startMod);
  addHook("classic.SessionStart", routeToMod);
  addHook("classic.SessionEnd", routeToMod);
  addHook("classic.UserPromptSubmit", routeToMod);
  addHook("classic.InstructionsLoaded", routeToMod);
  addHook("classic.PermissionDenied", routeToMod);
  addHook("classic.PostToolUse", routeToMod);
  addHook("classic.PostToolUseFailure", routeToMod);
  addHook("classic.PostToolBatch", routeToMod);
  addHook("classic.SubagentStart", routeToMod);
  addHook("classic.SubagentStop", routeToMod);
  addHook("classic.Notification", routeToMod);
  addHook("classic.PreCompact", routeToMod);
  addHook("classic.Stop", routeToMod);
  addHook("classic.StopFailure", routeToMod);
  addHook("classic.FileChanged", routeToMod);
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
  addHook("cmod.call", routeToMod);
}

// node_modules/@cmodjs/core/jobs/context.js
function modWithin({ mod }, deadline, workTree = async () => {
  return;
}) {
  const { claude } = mod;
  const within = (call, task) => beforeDeadline(claude, deadline, call, task);
  const folderOf2 = async (cwd2) => {
    const folder = cwd2 ?? await workTree();
    return folder === undefined ? {} : { cwd: folder };
  };
  const overrides = {
    process: {
      async run(argv, init) {
        const folder = await folderOf2(init?.cwd);
        const timeoutMs = Math.min(init?.timeoutMs ?? deadline.ms, deadline.longestMs ?? deadline.ms);
        return beforeDeadline(claude, { ...deadline, ms: timeoutMs }, "mod.process.run", mod.process.run(argv, { ...init, ...folder, timeoutMs }));
      },
      spawn: (argv, init) => spawnWithin(claude, deadline, folderOf2(init?.cwd).then((folder) => mod.process.spawn(argv, { ...init, ...folder })))
    },
    fs: {
      read: (path) => within("mod.fs.read", mod.fs.read(path)),
      write: (path, text) => within("mod.fs.write", mod.fs.write(path, text)),
      list: (path) => within("mod.fs.list", mod.fs.list(path)),
      exists: (path) => within("mod.fs.exists", mod.fs.exists(path)),
      stat: (path, options) => within("mod.fs.stat", mod.fs.stat(path, options)),
      find: (glob) => within("mod.fs.find", mod.fs.find(glob))
    },
    http: { fetch: (url, init) => within("mod.http.fetch", mod.http.fetch(url, init)) },
    dependencies: dependencyCalls(claude, within)
  };
  return Object.assign(Object.create(mod), overrides);
}
function spawnWithin(claude, deadline, started) {
  async function* pieces() {
    const stream = await started;
    let finish2 = () => {
      return;
    };
    const running = beforeDeadline(claude, deadline, "mod.process.spawn", new Promise((resolve2) => finish2 = resolve2));
    const passed = running.then(() => new Promise(() => {
      return;
    }));
    try {
      for (;; ) {
        const piece = await Promise.race([stream.next(), passed]);
        if (piece.done === true)
          return piece.value;
        yield piece.value;
      }
    } finally {
      finish2();
      stream.return?.();
    }
  }
  const result = started.then((stream) => stream.result);
  result.catch(() => {
    return;
  });
  return Object.assign(pieces(), { result });
}

// node_modules/@cmodjs/core/jobs/slash-command.js
var deadline = { ms: 30000, longestMs, job: "slashCommand" };
var commandName = /^[A-Za-z0-9_-]{1,64}$/;
function slashCommand(options) {
  const { name, description, argumentHint, immediate, reply } = options;
  return (job) => {
    const { mod, announce, reserveName } = job;
    const { claude } = mod;
    if (!commandName.test(name))
      throw new Error(`${mod.name}: "${name}" is not a slash command name. Use 1 to 64 letters, digits, "_", or "-", without the slash.`);
    reserveName("slashCommand", name, `${mod.name}: the slash command /${name} is already added. Give each slashCommand its own name.`);
    let registered2;
    claude.command.register({ name, description, ...argumentHint === undefined ? {} : { argumentHint }, ...immediate === undefined ? {} : { immediate } }).then(({ command }) => {
      registered2 = command;
    }, (error) => {
      claude.ui.log(`${mod.name}: /${name} is not added: ${oneLine(error)}`);
    });
    announce(`/${name}`);
    const replyMod = modWithin(job, deadline);
    claude.on("command.run", async (e, next) => {
      if (e.command !== registered2)
        return next(e);
      try {
        return answerOf(await reply({ args: e.args, positionals: splitWords(e.args) }, replyMod));
      } catch (error) {
        return { text: `/${name} failed: ${oneLine(error)}` };
      }
    });
  };
}
function answerOf(reply) {
  if (reply === undefined)
    return {};
  if (typeof reply === "string")
    return { text: reply };
  return { ...reply.text === undefined ? {} : { text: reply.text }, ...reply.context === undefined ? {} : { context: [reply.context] } };
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

// ../../../../../private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/cmod-publish-cmod-mbqyK5/release/src/mods.ts
var modsMemory = { selected: null, tab: "options", notice: null, views: [] };
var tabs = [
  { key: "options", label: "Options" },
  { key: "permissions", label: "Permissions" },
  { key: "keys", label: "Keys" },
  { key: "pages", label: "Pages" }
];
function modsPanel(mod) {
  const load = async () => {
    const store = storeFolder({ HOME: await mod.claude.env.home(), XDG_DATA_HOME: await mod.claude.env.dataHome() });
    const consent = await mod.fs.exists(consentPath(store)) ? parseConsent(JSON.parse(await mod.fs.read(consentPath(store))), consentPath(store)) : {};
    const rows = await mod.claude.config.list();
    const names = await mod.fs.exists(`${store}/records`) ? (await mod.fs.list(`${store}/records`)).filter((entry) => entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -".json".length)) : [];
    const read = (path) => mod.fs.read(path).catch(() => {
      return;
    });
    const records = (await Promise.all(names.map((name) => readRecord(read, store, name)))).filter((record) => record !== undefined);
    const views = await Promise.all(records.map(async (record) => {
      const manifest = await mod.fs.read(`${record.root}/package.json`).then(JSON.parse, () => {
        return;
      });
      const declared = (isObject(manifest) ? readSteps(manifest)?.permissions : undefined) ?? [];
      const granted = consent[record.name] ?? [];
      const ask = async (method) => {
        const answer = await mod.claude.cmod.call({ to: record.name, method, input: null }).catch(() => {
          return;
        });
        return isObject(answer) && Array.isArray(answer["value"]) ? answer["value"] : [];
      };
      const pages = await ask(settingsPagesMethod);
      const pendingSteps = await ask(pendingStepsMethod);
      return {
        name: record.name,
        version: record.version,
        permissions: declared.map((item) => ({ item, isOn: granted.includes(item) })),
        keys: Object.entries(record.keys ?? {}).map(([key, command]) => [key, `/${command}`]),
        options: rows.filter((row) => row.key.startsWith(`${record.name}.`)),
        pages,
        pendingSteps
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
    const { exitCode, stdout, stderr } = await mod.process.run(["cmod", "permission", name, ...words, isOn ? "off" : "on"]);
    return exitCode === 0 ? stdout.trim() : stderr.trim();
  });
  const setOption = (row, text) => act(async () => {
    const listed2 = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
    const value = row.kind === "number" ? Number(text) : row.kind === "boolean" ? text.trim() === "true" : Array.isArray(row.value) ? listed2 : text;
    const saved = await mod.claude.config.set({ key: row.key, value });
    return saved.deny ?? `Saved ${row.label}.`;
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
            row.isLocked ? Text({ children: String(row.value) }) : Input({ key: `option:${row.key}`, label: "› ", value: Array.isArray(row.value) ? row.value.join(", ") : String(row.value), submitLabel: "save", onSubmit: (text) => setOption(row, text) })
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
    if (view.pages.length === 0)
      return Text({ dimColor: true, children: `${view.name} adds no pages.` });
    return Box({ gap: 2, children: view.pages.map((page) => Button({ key: `page:${page.id}`, label: page.title, onPress: () => act(async () => (await mod.claude.cmod.call({ to: view.name, method: openPageMethod, input: page.id }), undefined)) })) });
  };
  const pane = definePane({
    id: "mods",
    title: "Mods",
    closeOnEscape: true,
    render(current) {
      const { selected, tab, notice, views } = current.state.memory;
      const view = views.find((each) => each.name === selected) ?? views[0];
      if (view === undefined)
        return Text({ dimColor: true, children: "No mod is set up yet. Run cmod install <owner/repo> to add one." });
      const list = Box({
        flexDirection: "column",
        minWidth: 18,
        children: views.map((each) => each === view ? Text({ bold: true, children: `▸ ${each.name}` }) : Button({ plain: true, key: `mod:${each.name}`, label: `  ${each.name}`, onPress: () => void (current.state.memory.selected = each.name) }))
      });
      const details = Box({
        flexDirection: "column",
        gap: 1,
        children: [
          Text({ children: [Text({ bold: true, children: view.name }), Text({ dimColor: true, children: ` ${view.version}` })] }),
          ...view.pendingSteps.length === 0 ? [] : [
            Box({
              gap: 2,
              children: [
                Text({ color: "warning", children: `Needs setup: ${view.pendingSteps.join(", ")}` }),
                Button({ key: "finish", label: "Finish setup", onPress: () => act(async () => (await mod.claude.cmod.call({ to: view.name, method: finishStepsMethod, input: null }), undefined)) })
              ]
            })
          ],
          Tabs({ tabs, selected: tab, onSelect: (key) => void (current.state.memory.tab = key), children: drawTab(view, tab) }),
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
      if (name !== undefined) {
        if (!mod.state.memory.views.some((view) => view.name === name))
          throw new Error(`${name} is not a mod cmod set up. cmod list shows the mods.`);
        mod.state.memory.selected = name;
        mod.state.memory.tab = "options";
      }
      if (name !== undefined && page !== undefined) {
        await mod.claude.cmod.call({ to: name, method: openPageMethod, input: page });
        return;
      }
      await handle.open({ focus: true });
    }
  };
}

// ../../../../../private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/cmod-publish-cmod-mbqyK5/release/src/mod.ts
var panels = new WeakMap;
var cmodPlugin = defineMod({
  name: "cmod",
  state: { global: { installedPlugins: null }, memory: modsMemory },
  api: {
    async openSettings(input, mod) {
      const panel = panels.get(mod);
      if (panel === undefined)
        throw new Error("cmod has not started its /mods panel yet.");
      await panel.open(input.mod, input.page);
      return null;
    }
  },
  setup(mod) {
    const triedRemovals = new Set;
    const mods = modsPanel(mod);
    panels.set(mod, mods);
    mod.use(slashCommand({
      name: "mods",
      description: "See and change your mods: options, permissions, keys, and pages",
      argumentHint: "[mod] [page]",
      immediate: true,
      async reply({ positionals }) {
        const [name, page] = positionals;
        await mods.open(name, page);
      }
    }));
    const tearDown = async (name) => {
      const { exitCode, stdout, stderr } = await mod.process.run(["cmod", "teardown", name, "--events"], { timeoutMs: longestMs });
      const outcome = parseEvent(stdout.trim().split(`
`).at(-1) ?? "");
      const isAnswered = outcome.kind === "done" || outcome.kind === "missing" || outcome.kind === "failed";
      if (isAnswered)
        mod.state.global.installedPlugins = (mod.state.global.installedPlugins ?? []).filter((installed) => installed !== name);
      if (outcome.kind === "done")
        mod.ui.toast(`${name} is uninstalled. A session that still runs it stops after /reload-plugins.`);
      else if (outcome.kind === "failed")
        mod.ui.toast(outcome.message);
      else if (exitCode !== 0)
        mod.ui.toast(`cmod teardown ${name} exited ${exitCode}: ${stderr.trim().split(`
`).at(-1)}`);
    };
    const watchRemovals = async () => {
      const enabledPlugins = (await mod.claude.settings.read({ source: "user" }))["enabledPlugins"];
      const current = [...new Set(Object.keys(enabledPlugins ?? {}).map((key) => key.replace(/@[^@]*$/, "")))];
      const previous = mod.state.global.installedPlugins;
      const removed = (previous ?? []).filter((name) => !current.includes(name));
      const installed = [...current, ...removed];
      if (previous === null || previous.length !== installed.length || !installed.every((name) => previous.includes(name)))
        mod.state.global.installedPlugins = installed;
      for (const name of removed) {
        if (triedRemovals.has(name))
          continue;
        triedRemovals.add(name);
        tearDown(name).catch((error) => {
          mod.ui.toast(`cmod teardown ${name} did not run: ${messageOf(error)}`);
        });
      }
    };
    mod.on("SessionStart", watchRemovals);
    mod.on("UserPromptSubmit", watchRemovals);
  }
});

// ../../../../../private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/cmod-publish-cmod-mbqyK5/release/hooks/register.ts
function register(addHook, options) {
  addHook("engine.create", async (_$, eventInput, passOn) => {
    const built = await passOn(eventInput);
    const cmod = {
      async call(input) {
        return { deny: notInstalled(input.to) };
      }
    };
    return { ...built, cmod };
  });
  registerMod(addHook, cmodPlugin, options);
}
export {
  register
};
