import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Tabs, Tab, Switch, Progress, ProgressTrack, ProgressIndicator, Popover, TextView, InputState, Input, TextareaState, Textarea, EditorState, Editor } from "gpui-base";
import { exec, checking, terminals, focused, readTextFile, theme, run, props, appHome, settings, notify, panes, layout } from "herdr";
import { WebSocket } from "websocket";
import { writeFile, readFile, mkdir, exists, readdir, unlink } from "fs/promises";
import { Buffer } from "buffer";
import { createHash } from "crypto";
import { deflateSync } from "zlib";
import { init, update, screen, entryOf, keyOf, QUIET_LOADING_MS } from "./panel.js";

const HOMES = 'printf "%s\\n%s" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${XDG_DATA_HOME:-$HOME/.local/share}/cmod"';
const RESIZE_MS = 250;
const SHOW_MS = 5_000;
const LOCATE_RETRY_MS = 2_000;
const UI = {
  text: { caption: 12, body: 13, title: 14 },
  height: { inline: 18, control: 26, header: 40 },
  icon: { small: 12, body: 14 },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { pill: 4, control: 6, panel: 8 },
  dot: 8,
  indent: 16,
  field: 220,
  menu: 180,
  note: 320,
  cell: 8,
  line: 20,
};
const MIN_COLUMNS = 20;
const CODE_ROWS = 30;
const ICONS = "mods/workspace-chrome";
const DRAWN = "mods/cmod/.drawn";
const SPACES = { xs: 0.25, sm: 0.5, md: 1, lg: 1.5, xl: 2 };
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const THEMED = {
  text: "foreground", inverseText: "background", inactive: "muted", subtle: "muted", secondaryText: "muted", userMessageBackground: "selected",
  claude: "accent", suggestion: "accent", remember: "ansi4", permission: "ansi4", ide: "ansi4", planMode: "ansi6", autoAccept: "ansi5",
  success: "ansi2", error: "ansi1", warning: "ansi3", merged: "ansi5", promptBorder: "border", bashBorder: "ansi5",
  diffAdded: "ansi2", diffRemoved: "ansi1", diffAddedDimmed: "ansi2", diffRemovedDimmed: "ansi1", diffAddedWord: "ansi10", diffRemovedWord: "ansi9",
};
const SURFACES = { userMessageBackground: "selected", inactive: "selected", subtle: "raised", secondaryText: "raised", promptBorder: "raised", gray: "raised", grey: "raised" };
const BORDERS = new Set(["subtle", "inactive", "secondaryText", "promptBorder", "userMessageBackground", "text", "gray", "grey"]);
const TONES = { info: "working", success: "done", warning: "ansi3", critical: "blocked" };
const CELL_TEXT = /[─-▟]| {2,}/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const messageOf = (error) => String(error?.message ?? error);
const handlerOf = (value) => (typeof value?.$cmodHandler === "number" ? value.$cmodHandler : undefined);
const shownProblem = (problem) => problem.replace(/^cmod ui: /, "");
const cmodTabs = () => new Set(panes().filter((pane) => pane.mod === "cmod").map((pane) => pane.tab));
const terminalFont = () => settings().font_family ?? "JetBrains Mono";
const titled = (text) => (text.length === 0 ? text : `${text[0].toUpperCase()}${text.slice(1)}`);
const icon = (name, size = UI.icon.small) => svg(`${ICONS}/${name}.svg`).size(size).flex_none();

const pathTo = (node, isWanted) => {
  if (node === null || typeof node !== "object") return null;
  if (isWanted(node)) return [node];
  for (const child of node.children ?? []) {
    const path = pathTo(child, isWanted);
    if (path !== null) return [node, ...path];
  }
  return null;
};

const textOf = (children) => {
  const all = [children].flat(Infinity).filter((each) => each !== null && each !== undefined && typeof each !== "boolean");
  return all.every((each) => typeof each === "string" || typeof each === "number") ? all.join("") : undefined;
};

const wordsIn = (children) => [children].flat(Infinity).map((each) => (typeof each === "string" || typeof each === "number" ? String(each) : each?.$cmodElement === "Text" ? wordsIn(each.props?.children) : "\u2060")).join("");

const across = (value) => (typeof value === "string" && value.endsWith("%") ? value : typeof value === "number" ? value * UI.cell : undefined);
const down = (value) => (typeof value === "string" && value.endsWith("%") ? value : typeof value === "number" ? value * UI.line : undefined);
const spaceOf = (value) => (typeof value === "number" ? value : SPACES[value]);

const colorOf = (value, t, role = "text") => {
  if (typeof value !== "string") return undefined;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (role === "surface" && SURFACES[value] !== undefined) return t[SURFACES[value]];
  if (role === "border" && BORDERS.has(value)) return t.border;
  const bright = value.endsWith("Bright");
  const ansi = ANSI.indexOf(bright ? value.slice(0, -"Bright".length) : value);
  if (ansi >= 0) return t[`ansi${ansi + (bright ? 8 : 0)}`];
  if (value === "gray" || value === "grey") return t.muted;
  return t[THEMED[value] ?? value];
};

const toneOf = (tone, t) => (TONES[tone] === undefined ? t.muted : t[TONES[tone]]);
const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? `${color}${alpha}` : undefined);

const walk = (node, path, visit) => {
  if (Array.isArray(node)) return node.forEach((each, index) => walk(each, `${path}.${index}`, visit));
  if (node === null || typeof node !== "object" || typeof node.$cmodElement !== "string") return;
  const given = node.props ?? {};
  visit(node.$cmodElement, given, path);
  for (const [name, value] of Object.entries(given)) if (name === "children" || name === "actions" || name === "trailing") walk(value, `${path}.${name}`, visit);
};

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

const pngOf = (rgba, width, height) => {
  const stride = width * 4;
  const rows = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array(PNG_SIGNATURE), pngChunk("IHDR", header), pngChunk("IDAT", new Uint8Array(deflateSync(rows))), pngChunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  parts.reduce((at, part) => (png.set(part, at), at + part.length), 0);
  return png;
};

let swept = null;

const deleteDrawn = async (names) => {
  for (const name of new Set(names)) if (await exists(`${appHome()}/${DRAWN}/${name}`)) await unlink(`${appHome()}/${DRAWN}/${name}`);
};

const deleteEveryDrawn = async () => {
  if (await exists(`${appHome()}/${DRAWN}`)) await deleteDrawn(await readdir(`${appHome()}/${DRAWN}`));
};

const drawnFile = async (bytes, extension, uses) => {
  await swept;
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
  const path = `${appHome()}/${DRAWN}/${name}`;
  uses.add(name);
  if (!(await exists(path))) {
    await mkdir(`${appHome()}/${DRAWN}`, { recursive: true });
    await writeFile(path, bytes);
  }
  return `${DRAWN}/${name}`;
};

const imageFileOf = async (name, given, uses) => {
  if (name === "Svg") return typeof given.source === "string" ? drawnFile(new Uint8Array(Buffer.from(given.source, "utf8")), "svg", uses) : null;
  const source = given.source ?? {};
  if (typeof source.png === "string") return drawnFile(new Uint8Array(Buffer.from(source.png, "base64")), "png", uses);
  if (typeof source.rgba === "string" && Number.isInteger(source.width) && Number.isInteger(source.height)) return drawnFile(pngOf(new Uint8Array(Buffer.from(source.rgba, "base64")), source.width, source.height), "png", uses);
  if (typeof source.file === "string") return drawnFile(await readFile(source.file), typeof source.format === "string" ? source.format : "png", uses);
  return null;
};

const rasterRows = (cells, columns) => {
  const bytes = new Uint8Array(Buffer.from(cells, "base64"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorFrom = (word) => (word === 0x01000000 ? null : `#${(word & 0xffffff).toString(16).padStart(6, "0")}`);
  const width = Math.max(1, Math.floor(columns));
  const rows = [];
  let row = [];
  for (let offset = 0, index = 0; offset + 12 <= bytes.length; offset += 12, index += 1) {
    const glyph = String.fromCodePoint(view.getUint32(offset, true));
    const fg = colorFrom(view.getUint32(offset + 4, true));
    const bg = colorFrom(view.getUint32(offset + 8, true));
    const last = row[row.length - 1];
    if (last && last.fg === fg && last.bg === bg) last.text += glyph;
    else row.push({ text: glyph, fg, bg });
    if ((index + 1) % width === 0) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
};


export default class Cmod extends View {
  init(_props, cx) {
    const given = props() ?? {};
    const show = given.show ?? "views";
    this.model = init({
      show,
      area: given.area,
      page: show === "page" ? { mod: given.mod, id: given.id, title: given.title ?? given.id } : null,
      session: show === "page" ? given.session ?? null : null,
      client: `herdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      isWindow: given.overlay !== undefined,
      now: Date.now(),
    });
    this.socket = null;
    this.calls = new Map();
    this.lastCall = 0;
    this.drawnParts = new Map();
    this.retired = [];
    this.located = null;
    this.openMenu = null;
    this.pageTabs = new Map();
    this.openingTabs = [];
    this.resizing = 0;
    this.isTicking = false;
    if (checking()) return;
    if (swept === null) {
      swept = deleteEveryDrawn();
      cx.spawn(async () => swept.catch((error) => notify({ title: "cmod kept old drawings", body: messageOf(error), level: "warning" })));
    }
    this.homes = null;
    cx.timer.every(SHOW_MS, (cx) => this.dispatch({ type: "renew" }, cx));
    this.dispatch({ type: "connect" }, cx);
  }

  dispatch(message, cx) {
    const before = this.model;
    const [model, effects] = update(before, { ...message, now: Date.now() });
    this.model = model;
    for (const effect of effects) this.perform(effect, cx);
    if (message.type !== "tick" && Object.keys(model).every((key) => key === "now" || model[key] === before[key])) return;
    this.prepareShown(cx);
    cx.notify();
  }

  perform(effect, cx) {
    if (effect.type === "connect") return cx.spawn((cx) => this.connect(cx));
    if (effect.type === "connectAfter") return cx.timer.after(effect.ms, (cx) => this.dispatch({ type: "connect" }, cx));
    if (effect.type === "call") return this.call(effect, cx);
    if (effect.type === "openPage") return this.openPage(effect.session, effect.page, effect.isAsked);
    if (effect.type === "closePage") return this.closePage(effect.key);
    if (effect.type === "reveal") return this.revealSelf();
    throw new Error(`The cmod panel performs no ${effect.type}.`);
  }

  homesOf() {
    this.homes ??= exec("sh", ["-c", HOMES]).then((answer) => {
      const [claude, store] = answer.stdout.split("\n");
      return { claude, store };
    }, (error) => {
      this.homes = null;
      throw error;
    });
    return this.homes;
  }

  async connect(cx) {
    try {
      const { store } = await this.homesOf();
      const text = await readTextFile(`${store}/serve.json`);
      if (text === null) throw new Error(`cmod serve is not running: ${store}/serve.json does not exist. A Claude Code session with the cmod plugin starts it.`);
      const { url, token } = JSON.parse(text);
      const socket = await WebSocket.connect(`${url}?token=${encodeURIComponent(token)}`);
      this.socket = socket;
      this.dispatch({ type: "connected" }, cx);
      await this.read(socket, cx);
    } catch (error) {
      this.socket = null;
      this.calls.clear();
      this.dispatch({ type: "disconnected", error: messageOf(error) }, cx);
    }
  }

  async read(socket, cx) {
    for (;;) {
      const data = await socket.read();
      const message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      if (typeof message.method === "string") {
        if (message.method === "$/on") this.dispatch({ type: "heard", event: message.params?.id, payload: message.params?.payload }, cx);
        else if (message.id !== undefined) await socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `The cmod Herdr panel answers no ${message.method}.` } }));
        continue;
      }
      const effect = this.calls.get(message.id);
      this.calls.delete(message.id);
      if (effect === undefined) continue;
      if (message.error !== undefined) {
        if (effect.failed !== null) this.dispatch({ ...effect.failed, error: messageOf(message.error.message) }, cx);
      } else if (effect.ok !== null) this.dispatch({ ...effect.ok, result: message.result }, cx);
    }
  }

  call(effect, cx) {
    if (this.socket === null) return;
    this.lastCall += 1;
    const id = this.lastCall;
    this.calls.set(id, effect);
    const socket = this.socket;
    cx.spawn(async () => socket.write(JSON.stringify({ jsonrpc: "2.0", id, method: effect.method, params: effect.params })));
  }

  async close() {
    const told = this.model.told;
    if (this.socket !== null && told.session !== null) await this.socket.write(JSON.stringify({ jsonrpc: "2.0", method: "cmod/UI.show", params: [told.session, this.model.client, []] }));
    await this.socket?.close();
    await deleteDrawn([...this.drawnParts.values()].flatMap((drawn) => [...drawn.files]));
  }

  target() {
    if (this.model.show === "page") return null;
    const address = props()?.terminal ?? focused()?.terminal ?? null;
    if (address === null) return null;
    const terminal = terminals().find((each) => each.address === address);
    return { address, pid: terminal?.foreground?.pid ?? terminal?.pid ?? null };
  }

  locate(cx) {
    const target = this.target();
    if (target === null) return;
    const located = `${target.address}:${target.pid}`;
    if (located === this.located) return;
    this.located = located;
    cx.spawn(async (cx) => {
      try {
        const session = await this.sessionOf(target);
        if (this.located === located) this.dispatch({ type: "focused", session }, cx);
      } catch (error) {
        if (this.located !== located) return;
        this.located = null;
        cx.timer.after(LOCATE_RETRY_MS, (cx) => cx.notify());
        notify({ title: "cmod could not find the focused session", body: messageOf(error), level: "warning" });
      }
    });
  }

  async sessionOf({ address, pid }) {
    if (pid === null || address.includes("/")) return null;
    const record = await readTextFile(`${(await this.homesOf()).claude}/sessions/${pid}.json`);
    return record === null ? null : /"sessionId"\s*:\s*"([^"]+)"/.exec(record)?.[1] ?? null;
  }

  prepareShown(cx) {
    const now = screen(this.model);
    const session = this.model.target;
    const wanted = new Set();
    for (const part of now.all ?? now.parts ?? []) {
      const key = `${session}\n${part.key}`;
      wanted.add(key);
      const tree = part.drawn?.tree ?? null;
      const known = this.drawnParts.get(key);
      if (known?.tree === tree) continue;
      const drawn = known ?? { session, key: part.key, tree: null, fields: new Map(), prepared: new Map(), files: new Set() };
      drawn.tree = tree;
      this.drawnParts.set(key, drawn);
      cx.spawn(async (cx) => {
        await this.prepare(drawn);
        if (drawn.tree === tree) cx.notify();
      });
    }
    for (const [key, drawn] of this.drawnParts) {
      if (wanted.has(key) || drawn.session === session) continue;
      this.retired.push(...[...drawn.fields.values()].map((field) => field.state));
      this.drawnParts.delete(key);
      cx.spawn(async () => deleteDrawn([...drawn.files].filter((name) => ![...this.drawnParts.values()].some((each) => each.files.has(name)))));
    }
  }

  async prepare(drawn) {
    const kept = new Set();
    const files = [];
    const uses = new Set();
    walk(drawn.tree, drawn.key, (name, given, path) => {
      if (name === "Input") kept.add(this.prepareField(drawn, given));
      if (name === "Code") kept.add(this.prepareCode(drawn, given, path));
      if (name === "Raster") drawn.prepared.set(path, rasterRows(typeof given.cells === "string" ? given.cells : "", typeof given.columns === "number" ? given.columns : 1));
      if (name === "Image" || name === "Svg") files.push(imageFileOf(name, given, uses).then((file) => void drawn.prepared.set(path, file)));
    });
    await Promise.all(files);
    const replaced = drawn.files;
    drawn.files = uses;
    await deleteDrawn([...replaced].filter((name) => ![...this.drawnParts.values()].some((each) => each.files.has(name))));
    for (const [key, field] of drawn.fields) {
      if (kept.has(key)) continue;
      this.retired.push(field.state);
      drawn.fields.delete(key);
    }
  }

  prepareField(drawn, given) {
    const key = `input:${given.key}`;
    const value = typeof given.value === "string" ? given.value : "";
    const known = drawn.fields.get(key);
    if (known) {
      if (known.value !== value && known.state.value() !== value) known.state.set_value(value);
      Object.assign(known, { value, onInput: handlerOf(given.onInput), onSubmit: handlerOf(given.onSubmit) });
      return key;
    }
    const rows = typeof given.rows === "number" && given.rows > 1 ? Math.floor(given.rows) : 1;
    const options = { value, ...(typeof given.placeholder === "string" ? { placeholder: given.placeholder } : {}) };
    const state = rows > 1 ? TextareaState.new({ ...options, rows }) : InputState.new(options);
    const field = { state, rows, value, onInput: handlerOf(given.onInput), onSubmit: handlerOf(given.onSubmit) };
    state.on("change", (_event, cx) => this.press(drawn, field.onInput, { key: given.key, kind: "change", value: state.value() }, cx));
    state.on("submit", (_event, cx) => this.press(drawn, field.onSubmit, { key: given.key, kind: "submit", value: state.value() }, cx));
    drawn.fields.set(key, field);
    return key;
  }

  prepareCode(drawn, given, path) {
    const key = `code:${given.key ?? path}`;
    const source = typeof given.source === "string" ? given.source : "";
    const known = drawn.fields.get(key);
    if (known) {
      if (known.value !== source) known.state.set_value(source);
      known.value = source;
      return key;
    }
    const t = theme();
    const language = given.language ?? (typeof given.path === "string" && given.path.includes(".") ? given.path.split(".").pop() : given.format === "diff" ? "diff" : "text");
    const state = EditorState.new({
      language, value: source, readonly: true, line_numbers: typeof given.startLine === "number", soft_wrap: given.wrap !== "truncate-end",
      font_family: terminalFont(), syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    drawn.fields.set(key, { state, value: source });
    return key;
  }

  press(drawn, handler, input, cx) {
    if (handler === undefined) return;
    this.dispatch({ type: "press", session: drawn.session, key: drawn.key, handler, input }, cx);
  }

  openLink(href, cx) {
    if (/^https?:\/\//.test(href)) return cx.open_url(href);
    cx.write_to_clipboard(href);
    notify({ title: "Copied the link", body: "Paste it where you open it.", level: "info" });
  }

  revealSelf() {
    const own = JSON.stringify(props() ?? {});
    const isCmodViews = (node) => node.type === "block" && node.content?.mod === "cmod" && (node.content.props?.show ?? "views") === "views";
    const path = pathTo(layout(), (node) => isCmodViews(node) && JSON.stringify(node.content.props ?? {}) === own) ?? pathTo(layout(), isCmodViews);
    if (path === null) return;
    path.forEach((node, index) => {
      const child = path[index + 1];
      if (node.type === "stack" && child !== undefined && node.active !== child.id) run("layout.select", { stack: node.id, child: child.id });
      if (node.hidden === true) run("layout.show", { id: node.id });
    });
  }

  openPage(session, page, isAsked) {
    const key = keyOf(page);
    const tab = this.pageTabs.get(key);
    if (tab !== undefined && cmodTabs().has(tab)) return isAsked ? run("tab.select", { id: tab }) : null;
    this.openingTabs.push({ key, before: cmodTabs() });
    run("tab.new", { name: page.title, mod: "cmod", props: { show: "page", session, mod: page.mod, id: page.id, title: page.title }, ...(isAsked ? {} : { focus: false }) });
  }

  closePage(key) {
    const tab = this.pageTabs.get(key);
    this.pageTabs.delete(key);
    if (tab !== undefined && cmodTabs().has(tab)) run("tab.close", { id: tab });
  }

  notePageTabs() {
    if (this.openingTabs.length === 0) return;
    const known = new Set(this.pageTabs.values());
    const shown = cmodTabs();
    this.openingTabs = this.openingTabs.filter(({ key, before }) => {
      const tab = [...shown].find((each) => !before.has(each) && !known.has(each));
      if (tab === undefined) return true;
      this.pageTabs.set(key, tab);
      known.add(tab);
      return false;
    });
  }

  resized(size, cx) {
    const inset = this.model.show === "widgets" ? 0 : UI.space.md * 2;
    const columns = Math.max(MIN_COLUMNS, Math.floor((size.width / (Number(settings().zoom) || 1) - inset) / UI.cell));
    if (columns === this.model.columns) return;
    this.dispatch({ type: "resized", columns }, cx);
    const resizing = (this.resizing += 1);
    cx.timer.after(RESIZE_MS, (cx) => {
      if (this.resizing === resizing) this.dispatch({ type: "redrawShown" }, cx);
    });
  }

  releaseRetired(cx) {
    if (this.retired.length === 0) return;
    const released = this.retired;
    this.retired = [];
    cx.timer.after(0, () => {
      for (const each of released) each.release();
    });
  }


  render(cx) {
    if (!checking()) this.locate(cx);
    this.notePageTabs();
    this.releaseRetired(cx);
    const t = theme();
    const now = screen({ ...this.model, now: Date.now() });
    if (now.kind === "loading" && now.isQuiet && !this.isTicking) {
      this.isTicking = true;
      cx.timer.after(QUIET_LOADING_MS, (cx) => {
        this.isTicking = false;
        this.dispatch({ type: "tick" }, cx);
      });
    }
    if (this.model.show === "widgets") {
      return h_flex().id("cmod-root").size_full().min_w(0).gap(UI.space.md).items_center().text_size(UI.text.body).text_color(t.foreground)
        .on_size_change((size, cx) => this.resized(size, cx))
        .children((now.parts ?? []).map((part) => this.part(part, t)))
        .when(now.problem != null, (el) => el.child(this.alert(shownProblem(now.problem ?? ""), t).truncate()));
    }
    const isCard = this.model.show === "views" && !this.model.isWindow;
    return v_flex().id("cmod-root").size_full().min_h(0).min_w(0).text_size(UI.text.body).text_color(t.foreground)
      .when(isCard, (el) => el.rounded(UI.radius.panel).overflow_hidden().bg(t.background).border_1().border_color(t.border))
      .on_size_change((size, cx) => this.resized(size, cx))
      .when(now.kind === "ready" && this.model.show === "views" && now.views.length + now.pages.length > 0, (el) => el.child(this.header(now, t)))
      .child(this.body(now, t))
      .when(now.kind === "ready" && now.problem != null, (el) => el.child(this.problemBar(now.problem ?? "", t)));
  }

  body(now, t) {
    if (now.kind === "noSession") return this.emptyState("No session in focus", "Click a terminal running Claude Code to see its views here.", t);
    if (now.kind === "noPage") return this.emptyState("This page has no session", "Open it again from its session's views.", t);
    if (now.kind === "unreached") return this.emptyState("cmod serve isn't reachable", shownProblem(now.message ?? ""), t, { label: "Try again", run: (cx) => this.dispatch({ type: "connect" }, cx) });
    if (now.kind === "refused") return this.emptyState("This session can't show its views here", shownProblem(now.message ?? ""), t, { label: "Try again", run: (cx) => this.dispatch({ type: "retry" }, cx) });
    if (now.kind === "loading") return now.isQuiet ? v_flex().id("cmod-body").flex_1() : this.note("Loading this session's views", t, "status");
    if (now.parts.length === 1 && this.isLoneNote(now.parts[0])) return this.note(textOf(now.parts[0].drawn?.tree?.props?.children) ?? "", t);
    return v_flex().id("cmod-body").flex_1().min_h(0).min_w(0).p(UI.space.md).gap(UI.space.lg).overflow_y_scrollbar().children(now.parts.map((part) => this.part(part, t)));
  }

  isLoneNote(part) {
    const tree = part.drawn?.tree;
    return tree?.$cmodElement === "Text" && textOf(tree.props?.children) !== undefined;
  }

  note(text, t, role = "label") {
    return v_flex().id("cmod-note").flex_1().min_h(0).p(UI.space.md)
      .child(div().max_w(UI.note).text_color(t.muted).role(role).accessibility_label(text).child(text));
  }

  emptyState(title, text, t, action) {
    return v_flex().id("cmod-empty").flex_1().min_h(0).gap(UI.space.xs).p(UI.space.md)
      .child(div().role("heading").accessibility_label(title).font_semibold().child(title))
      .child(div().role("label").accessibility_label(text).max_w(UI.note).text_color(t.muted).child(text))
      .when(action !== undefined, (el) => el.child(div().pt(UI.space.sm).self_start().child(this.control(Button.new("cmod-empty-action"), "filled", t).accessibility_label(action?.label ?? "").on_click((_event, cx) => action?.run(cx)).child(action?.label ?? ""))));
  }

  alert(text, t) {
    return div().text_size(UI.text.caption).text_color(t.blocked).role("alert").accessibility_label(text).child(text);
  }

  problemBar(problem, t) {
    const isConnection = this.model.connection.status !== "open";
    return h_flex().id("cmod-problem").flex_none().gap(UI.space.sm).items_center().px(UI.space.md).py(UI.space.xs).border_t(1).border_color(t.border)
      .child(this.alert(isConnection ? `Reconnecting to cmod serve: ${shownProblem(problem)}` : shownProblem(problem), t).flex_1().min_w(0))
      .child(this.control(Button.new("cmod-problem-retry"), "subtle", t).accessibility_label("Try again").on_click((_event, cx) => this.dispatch({ type: isConnection ? "connect" : "retry" }, cx)).child("Try again"));
  }

  control(el, kind, t) {
    el = el.flex().flex_none().items_center().justify_center().gap(UI.space.xs).h(UI.height.control).px(UI.space.sm).rounded(UI.radius.control).text_size(UI.text.body).cursor_pointer().max_w_full();
    if (kind === "primary") return el.font_medium().bg(t.solid).text_color(t.solid_foreground).hover((h) => h.opacity(0.9));
    if (kind === "filled") return el.bg(t.raised).text_color(t.foreground).hover((h) => h.bg(t.hover));
    if (kind === "subtle") return el.text_color(t.foreground).hover((h) => h.bg(t.hover));
    return el.text_color(t.muted).hover((h) => h.bg(t.hover).text_color(t.foreground));
  }

  choice(el, isChosen, t) {
    return el.flex().flex_none().items_center().gap(UI.space.xs).h(UI.height.control).px(UI.space.sm).rounded(UI.radius.control).text_size(UI.text.body).cursor_pointer()
      .when(isChosen, (e) => e.bg(t.selected).text_color(t.foreground).font_medium())
      .when(!isChosen, (e) => e.text_color(t.muted).hover((h) => h.bg(t.hover).text_color(t.foreground)));
  }

  header(now, t) {
    const shown = now.shown;
    const viewTabs = now.views.map((view, index) => {
      const key = keyOf(view);
      const isSelected = shown !== undefined && key === keyOf(shown);
      return this.choice(Tab.new(`cmod-tab-${key}`).selected(isSelected).set_position(index + 1, now.views.length).accessibility_label(titled(view.title)), isSelected, t)
        .on_click((_event, cx) => this.dispatch({ type: "select", key }, cx))
        .child(titled(view.title));
    });
    const session = this.model.target;
    const pageTabs = now.pages.map((page) =>
      this.choice(Button.new(`cmod-page-${keyOf(page)}`).role("link").accessibility_label(`${titled(page.title)}, opens in its own tab`).tooltip(`Opens ${titled(page.title)} in its own tab`), false, t)
        .on_click(() => this.openPage(session, page, true))
        .child(titled(page.title)),
    );
    return h_flex().id("cmod-header").flex_none().h(UI.height.header).px(UI.space.sm).items_center().border_b(1).border_color(t.border).child(
      Tabs.new("cmod-tabs").accessibility_label("Views").h_flex().flex_1().min_w(0).h_full().items_center().gap(2).overflow_x_scroll()
        .children(viewTabs)
        .when(pageTabs.length > 0, (el) => el.child(div().flex_none().w(UI.space.sm)).children(pageTabs)),
    );
  }

  part(part, t) {
    const drawn = this.drawnParts.get(`${this.model.target}\n${part.key}`);
    const tree = part.drawn?.tree ?? null;
    const error = part.drawn?.error ?? null;
    if (tree === null && error !== null) return this.alert(error, t);
    if (tree === null && this.model.show === "widgets") return div().id(`part-${part.key}`);
    if (tree === null) {
      return h_flex().id(`part-${part.key}`).gap(UI.space.xs).role("status").accessibility_label(`${titled(part.title)}: Drawing…`)
        .child(div().font_medium().child(titled(part.title)))
        .child(div().text_color(t.muted).child("Drawing…"));
    }
    if (drawn === undefined) return div().id(`part-${part.key}`);
    if (this.isLoneNote(part)) return div().text_color(t.muted).role("label").accessibility_label(textOf(tree.props?.children)).child(textOf(tree.props?.children));
    return v_flex().id(`part-${part.key}`).min_w(0).gap(UI.space.sm)
      .children(this.nodes(tree, drawn, drawn.key, t))
      .when(error !== null, (el) => el.child(this.alert(error ?? "", t)));
  }

  nodes(value, drawn, path, t, inColumn = true) {
    if (Array.isArray(value)) return value.flatMap((each, index) => this.nodes(each, drawn, `${path}.${index}`, t, inColumn));
    if (value === null || value === undefined || typeof value === "boolean") return [];
    if (typeof value === "string" || typeof value === "number") return [div().child(String(value))];
    const draw = this.elements[value.$cmodElement];
    if (draw === undefined) return [div().text_color(t.muted).child(`Herdr draws no ${value.$cmodElement}.`)];
    const element = draw.call(this, value.props ?? {}, drawn, path, t, inColumn);
    return element === null ? [] : [element];
  }

  get elements() {
    return {
      Box: this.box, Text: this.text, Button: this.button, Link: this.link, Code: this.code, Markdown: this.markdown, Input: this.input, Select: this.select, Image: this.picture, Svg: this.picture, Raster: this.raster,
      Tabs: this.tabs, Split: this.split, Panel: this.panel, Toggle: this.toggle, Tooltip: this.tooltip, Help: this.help, Dialog: this.dialog, Pagination: this.pagination, Progress: this.progress,
      List: this.list, ListItem: this.listItem, Badge: this.badge, Banner: this.banner,
    };
  }

  box(given, drawn, path, t) {
    if (given.display === "none" && given.hover?.display !== "flex") return null;
    const isColumn = given.flexDirection === "column" || given.flexDirection === "column-reverse";
    let el = div().flex().min_w(0);
    el = isColumn ? el.flex_col() : el.flex_row();
    if (given.flexWrap === "wrap") el = el.flex_wrap();
    const children = [given.children].flat(Infinity);
    const align = given.alignItems ?? (isColumn ? undefined : "center");
    el = { "flex-start": (e) => e.items_start(), center: (e) => e.items_center(), "flex-end": (e) => e.items_end(), stretch: (e) => e.items_stretch() }[align]?.(el) ?? el;
    el = { "flex-start": (e) => e.self_start(), center: (e) => e.self_center(), "flex-end": (e) => e.self_end() }[given.alignSelf]?.(el) ?? el;
    el = { "flex-start": (e) => e.justify_start(), center: (e) => e.justify_center(), "flex-end": (e) => e.justify_end(), "space-between": (e) => e.justify_between(), "space-around": (e) => e.justify_around(), "space-evenly": (e) => e.justify_evenly() }[given.justifyContent]?.(el) ?? el;
    if (typeof given.flexGrow === "number" && given.flexGrow > 0) el = el.flex_grow(given.flexGrow);
    if (given.flexShrink === 0) el = el.flex_shrink_0();
    const gapX = spaceOf(given.columnGap ?? given.gap);
    const gapY = spaceOf(given.rowGap ?? given.gap) ?? (given.flexWrap === "wrap" && !isColumn ? 1 : undefined);
    if (gapX !== undefined) el = el.gap_x(gapX * UI.space.sm);
    if (gapY !== undefined) el = el.gap_y(gapY * UI.space.sm);
    const isBordered = typeof given.borderStyle === "string";
    for (const [side, axis, method] of [["Top", "Y", "t"], ["Right", "X", "r"], ["Bottom", "Y", "b"], ["Left", "X", "l"]]) {
      const padding = spaceOf(given[`padding${side}`] ?? given[`padding${axis}`] ?? given.padding);
      const margin = spaceOf(given[`margin${side}`] ?? given[`margin${axis}`] ?? given.margin);
      const inset = (padding ?? 0) * UI.space.sm + (isBordered ? UI.space.md : 0);
      if (inset > 0) el = el[`p${method}`](inset);
      if (margin !== undefined && margin !== 0) el = el[`m${method}`](margin * UI.space.sm);
    }
    for (const [prop, method, size] of [["width", "w", across], ["height", "h", down], ["minWidth", "min_w", across], ["minHeight", "min_h", down]]) {
      const value = size(given[prop]);
      if (value !== undefined) el = el[method](value);
    }
    if (given.position === "absolute") {
      el = el.absolute();
      for (const [side, size] of [["top", down], ["right", across], ["bottom", down], ["left", across]]) {
        const value = size(given[side]);
        if (value !== undefined) el = el[side](value);
      }
    }
    const background = colorOf(given.backgroundColor, t, "surface");
    if (isBordered) {
      el = el.border_1().border_color(colorOf(given.borderColor, t, "border") ?? t.border).rounded(UI.radius.panel);
      if (given.borderStyle === "dashed" || given.borderStyle === "classic") el = el.border_dashed();
    } else if (background !== undefined) el = el.rounded(UI.radius.control);
    if (background !== undefined) el = el.bg(background);
    if (given.overflow === "hidden" || isBordered) el = el.overflow_hidden();
    const hoverBackground = colorOf(given.hover?.backgroundColor, t, "surface");
    if (typeof given.key === "string") el = el.id(`${drawn.key}:${given.key}`).when(hoverBackground !== undefined, (e) => e.hover((h) => h.bg(hoverBackground)));
    return el.when(children.some((child) => child?.props?.position === "absolute"), (e) => e.relative()).children(this.nodes(given.children, drawn, `${path}.children`, t, isColumn));
  }

  styled(el, given, t) {
    const background = colorOf(given.backgroundColor, t, "surface");
    const ink = given.color === "inverseText" && background !== undefined ? t.foreground : colorOf(given.color, t);
    if (given.inverse === true) el = el.bg(colorOf(given.color ?? "text", t, "surface") ?? t.foreground).text_color(background ?? t.background);
    else {
      if (ink !== undefined && given.dimColor !== true) el = el.text_color(ink);
      else if (given.dimColor === true) el = el.text_color(t.muted);
      if (background !== undefined) el = el.bg(background);
    }
    if (given.bold === true || given.weight === "bold" || given.weight === "semibold") el = el.font_semibold();
    else if (given.weight === "medium") el = el.font_medium();
    if (given.italic === true) el = el.italic();
    if (given.underline === true) el = el.underline();
    if (given.strikethrough === true) el = el.line_through();
    const size = { caption: UI.text.caption, footnote: UI.text.caption, heading: UI.text.title, title: UI.text.title }[given.size];
    if (size !== undefined) el = el.text_size(size);
    if (given.size === "heading" || given.size === "title") el = el.font_semibold();
    if (typeof given.wrap === "string" && given.wrap !== "wrap") el = el.truncate();
    return el;
  }

  text(given, drawn, path, t) {
    const words = textOf(given.children);
    const row = CELL_TEXT.test(wordsIn(given.children)) ? h_flex().min_w(0).font_family(terminalFont()).whitespace_nowrap() : h_flex().flex_wrap().min_w(0);
    if (words === undefined) return this.styled(row, given, t).children(this.nodes(given.children, drawn, `${path}.children`, t, false));
    let el = this.styled(div().role("label").accessibility_label(words.trim()), given, t).child(words);
    if (CELL_TEXT.test(words)) el = el.font_family(terminalFont()).whitespace_nowrap();
    return el;
  }

  button(given, drawn, path, t, inColumn) {
    const handler = handlerOf(given.onPress);
    const label = typeof given.label === "string" ? given.label : undefined;
    const words = textOf(given.children);
    const key = typeof given.key === "string" ? given.key : label ?? words ?? path;
    const name = (label ?? words ?? key).trim();
    const kind = given.variant === "primary" ? "primary" : given.variant === "secondary" || given.plain !== true ? "filled" : given.dimColor === true ? "muted" : "subtle";
    let el = this.control(Button.new(`${drawn.key}:${key}`).accessibility_label(name), kind, t);
    if (inColumn) el = el.self_start();
    el = el.on_click((_event, cx) => (handler !== undefined ? this.press(drawn, handler, { key }, cx) : typeof given.href === "string" ? this.openLink(given.href, cx) : undefined));
    if (label === undefined && words === undefined && given.children !== undefined && !(Array.isArray(given.children) && given.children.length === 0)) return el.child(h_flex().min_w(0).gap(UI.space.xs).children(this.nodes(given.children, drawn, `${path}.children`, t, false)));
    return el.child(div().min_w(0).truncate().child(name));
  }

  link(given, drawn, _path, t) {
    const href = typeof given.href === "string" ? given.href : "";
    const shown = textOf(given.children) || (typeof given.label === "string" ? given.label : href);
    return Button.new(`${drawn.key}:link:${href}`).accessibility_label(shown).role("link").cursor_pointer().rounded(UI.radius.pill).text_color(t.accent).hover((h) => h.underline()).focus((f) => f.underline())
      .on_click((_event, cx) => this.openLink(href, cx)).child(shown);
  }

  code(given, drawn, path, t) {
    const field = drawn.fields.get(`code:${given.key ?? path}`);
    const source = typeof given.source === "string" ? given.source : "";
    const rows = Math.min(Math.max(source.split("\n").length, 1), CODE_ROWS);
    if (!field) return div().font_family(terminalFont()).text_size(UI.text.caption).text_color(t.muted).child(source);
    return div().id(`${drawn.key}:code:${given.key ?? path}`).h(rows * UI.line + UI.space.md).rounded(UI.radius.control).border_1().border_color(t.border).bg(t.background).overflow_hidden().child(Editor.new(field.state).size_full());
  }

  markdown(given, drawn, path, t) {
    const handler = handlerOf(given.onLinkPress);
    const pressable = Array.isArray(given.pressableLinks) ? given.pressableLinks : undefined;
    const key = typeof given.key === "string" ? given.key : path;
    let el = TextView.markdown(`${drawn.key}:markdown:${key}`, typeof given.text === "string" ? given.text : "").selectable(true)
      .on_link_click((url, cx) => (handler !== undefined && (pressable === undefined || pressable.includes(url)) ? this.press(drawn, handler, { key, link: { href: url } }, cx) : this.openLink(url, cx)));
    if (given.dimColor === true) el = el.text_color(t.muted);
    return el;
  }

  input(given, drawn, _path, t) {
    const field = drawn.fields.get(`input:${given.key}`);
    const label = typeof given.label === "string" ? given.label : undefined;
    const name = label ?? (typeof given.placeholder === "string" ? given.placeholder : given.key);
    if (!field) return div().text_color(t.muted).child(typeof given.value === "string" ? given.value : "");
    let control = (field.rows > 1 ? Textarea : Input).new(field.state).accessibility_label(name).px(UI.space.sm).rounded(UI.radius.control).border_1().border_color(t.input).bg(t.background).text_size(UI.text.body).text_color(t.foreground);
    control = field.rows > 1 ? control.min_h(field.rows * UI.line + UI.space.md) : control.h(UI.height.control);
    if (label === undefined) return control.w_full().min_w(0);
    return h_flex().id(`${drawn.key}:field:${given.key}`).w_full().min_w(0).gap(UI.space.md).items_center()
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(control.w(UI.field).flex_none());
  }

  select(given, drawn, _path, t) {
    const handler = handlerOf(given.onSelect);
    const options = Array.isArray(given.options) ? given.options.filter((option) => typeof option?.value === "string") : [];
    const label = typeof given.label === "string" ? given.label : given.key;
    const id = `${drawn.key}:select:${given.key}`;
    const isOpen = this.openMenu === id;
    const chosen = options.find((option) => option.value === given.value);
    const shownOf = (option) => (typeof option.label === "string" ? option.label : option.value);
    const trigger = div().id(`${id}:trigger`).role("button").accessibility_label(`${label}: ${chosen === undefined ? "none" : shownOf(chosen)}`)
      .flex().flex_none().items_center().gap(UI.space.xs).h(UI.height.control).px(UI.space.sm).max_w_full().rounded(UI.radius.control).border_1().border_color(t.border).cursor_pointer()
      .bg(isOpen ? t.hover : t.raised).hover((el) => el.bg(t.hover))
      .child(div().min_w(0).truncate().when(chosen === undefined, (el) => el.text_color(t.muted)).child(chosen === undefined ? label : shownOf(chosen)))
      .child(icon("chevron-down").text_color(t.muted));
    const menu = v_flex().id(`${id}:menu`).role("menu").accessibility_label(label).min_w(UI.menu).p(UI.space.xs).gap(1).rounded(UI.radius.panel).border_1().border_color(t.border).bg(t.popover).shadow_lg().children(
      options.map((option) => {
        const isSelected = option.value === given.value;
        return Button.new(`${id}:${option.value}`).role("menu_item_radio").selected(isSelected).accessibility_label(shownOf(option))
          .h(UI.height.control).px(UI.space.sm).flex().items_center().gap(UI.space.sm).rounded(UI.radius.pill).cursor_pointer().text_color(t.foreground).hover((el) => el.bg(t.hover))
          .on_click((_event, cx) => {
            this.openMenu = null;
            this.press(drawn, handler, { key: given.key, value: option.value }, cx);
            cx.notify();
          })
          .child(div().flex_none().size(UI.icon.small).text_color(t.accent).when(isSelected, (el) => el.child(icon("check"))))
          .child(div().min_w(0).truncate().child(shownOf(option)));
      }),
    );
    return Popover.new(id).open(isOpen).on_open_change((open, cx) => {
      this.openMenu = open ? id : null;
      cx.notify();
    }).trigger(trigger).content(menu);
  }

  picture(given, drawn, path, t) {
    const label = typeof given.label === "string" ? given.label : typeof given.alt === "string" ? given.alt : "";
    const file = drawn.prepared.get(path);
    const frame = div().role("image").accessibility_label(label);
    if (!file) return frame.text_color(t.dim).child(label);
    const width = typeof given.columns === "number" ? given.columns * UI.cell : given.width;
    const height = typeof given.rows === "number" ? given.rows * UI.line : given.height;
    let picture = image(file);
    if (typeof width === "number") picture = picture.w(width);
    if (typeof height === "number") picture = picture.h(height);
    return frame.child(picture);
  }

  raster(given, drawn, path) {
    const rows = drawn.prepared.get(path) ?? [];
    const label = typeof given.label === "string" ? given.label : "";
    return v_flex().role("image").accessibility_label(label).font_family(terminalFont()).line_height(UI.line).children(
      rows.map((row) => h_flex().children(row.map((cells) => {
        let el = div().whitespace_nowrap().child(cells.text);
        if (cells.fg !== null) el = el.text_color(cells.fg);
        if (cells.bg !== null) el = el.bg(cells.bg);
        return el;
      }))),
    );
  }

  tabs(given, drawn, path, t) {
    const tabs = Array.isArray(given.tabs) ? given.tabs : [];
    const strip = Tabs.new(`${drawn.key}:${given.key ?? ""}tabs`).accessibility_label("Sections").h_flex().min_w(0).flex_wrap().gap(2).children(
      tabs.map((each, index) => {
        const isSelected = each.isSelected === true;
        return this.choice(Tab.new(`${drawn.key}:${given.key ?? ""}tab:${each.key}`).selected(isSelected).set_position(index + 1, tabs.length).accessibility_label(each.label), isSelected, t)
          .on_click((_event, cx) => this.press(drawn, handlerOf(each.onSelect), { key: `${given.key ?? ""}tab:${each.key}` }, cx))
          .child(each.label);
      }),
    );
    return v_flex().min_w(0).gap(UI.space.md).child(strip).children(this.nodes(given.children, drawn, `${path}.children`, t));
  }

  split(given, drawn, path, t) {
    const children = Array.isArray(given.children) ? given.children : [given.children];
    return h_flex().min_w(0).gap(UI.space.lg).items_start().children(children.map((child, index) => v_flex().flex_1().min_w(0).gap(UI.space.sm).children(this.nodes(child, drawn, `${path}.children.${index}`, t))));
  }

  panel(given, drawn, path, t) {
    const title = typeof given.title === "string" ? given.title : "";
    const description = typeof given.description === "string" && given.description !== "" ? given.description : undefined;
    const hasHeader = description !== undefined || given.actions !== undefined;
    const body = this.nodes(given.children, drawn, `${path}.children`, t);
    if (path === drawn.key && !hasHeader) return v_flex().flex_grow(1).min_w(0).gap(UI.space.lg).role("region").accessibility_label(title).children(body);
    const heading = div().flex_1().min_w(0).truncate().role("heading").accessibility_label(title)
      .when(hasHeader, (el) => el.text_size(UI.text.title).font_semibold().text_color(t.foreground))
      .when(!hasHeader, (el) => el.text_size(UI.text.caption).font_semibold().text_color(t.muted))
      .child(title);
    return v_flex().flex_grow(1).min_w(0).gap(UI.space.sm).when(!hasHeader, (el) => el.pt(UI.space.sm)).role("region").accessibility_label(title)
      .child(h_flex().min_w(0).gap(UI.space.sm).items_center().child(heading).when(given.actions !== undefined, (el) => el.child(h_flex().flex_none().gap(UI.space.sm).children(this.nodes(given.actions, drawn, `${path}.actions`, t, false)))))
      .when(description !== undefined, (el) => el.child(div().text_color(t.muted).child(description ?? "")))
      .child(v_flex().min_w(0).gap(UI.space.md).pt(hasHeader ? UI.space.sm : 0).children(body));
  }

  toggle(given, drawn, _path, t) {
    const label = typeof given.label === "string" ? given.label : "";
    const checked = given.checked === true;
    const track = div().flex_none().w(32).h(18).rounded(9).p(2).flex().items_center().bg(checked ? t.accent : t.border).when(checked, (el) => el.justify_end())
      .child(div().size(14).rounded(7).bg(checked ? t.accent_foreground : t.foreground));
    return Switch.new(`${drawn.key}:${given.key ?? ""}toggle:${label}`).checked(checked).accessibility_label(label).w_full().min_w(0).min_h(UI.height.control).flex().items_center().gap(UI.space.md).cursor_pointer()
      .on_change((_checked, cx) => this.press(drawn, handlerOf(given.onToggle), { key: `${given.key ?? ""}toggle:${label}` }, cx))
      .child(div().flex_1().min_w(0).child(label)).child(track);
  }

  tooltip(given, drawn, path, t) {
    return h_flex().min_w(0).tooltip(typeof given.text === "string" ? given.text : "").children(this.nodes(given.children, drawn, `${path}.children`, t, false));
  }

  help(given, drawn, _path, t) {
    const text = typeof given.text === "string" ? given.text : "";
    const isOpen = given.isOpen === true;
    return v_flex().min_w(0).gap(UI.space.xs)
      .child(Button.new(`${drawn.key}:${given.key ?? ""}help:${text}`).accessibility_label("Help").tooltip(text).flex_none().size(UI.height.inline).flex().items_center().justify_center().rounded(UI.height.inline / 2).border_1().border_color(t.border).text_size(UI.text.caption).text_color(t.muted).cursor_pointer().hover((el) => el.text_color(t.foreground))
        .on_click((_event, cx) => this.press(drawn, handlerOf(given.onToggle), { key: `${given.key ?? ""}help-button:${text}` }, cx)).child("?"))
      .when(isOpen, (el) => el.child(div().max_w(UI.note).p(UI.space.sm).rounded(UI.radius.control).bg(t.raised).text_size(UI.text.caption).role("note").accessibility_label(text).child(text)));
  }

  dialog(given, drawn, path, t) {
    const title = typeof given.title === "string" ? given.title : "";
    return v_flex().min_w(0).gap(UI.space.md).p(UI.space.lg).rounded(UI.radius.panel).border_1().border_color(t.border).bg(t.popover ?? t.background).role("dialog").accessibility_label(title)
      .child(div().text_size(UI.text.title).font_semibold().role("heading").accessibility_label(title).child(title))
      .child(v_flex().min_w(0).gap(UI.space.sm).children(this.nodes(given.children, drawn, `${path}.children`, t)))
      .child(h_flex().flex_wrap().gap(UI.space.sm).children(this.nodes(given.actions, drawn, `${path}.actions`, t, false)));
  }

  pagination(given, drawn, _path, t) {
    const step = (handler, label) => {
      const isOff = handlerOf(handler) === undefined;
      return this.control(Button.new(`${drawn.key}:page:${label}`), "subtle", t).accessibility_label(label).disabled(isOff).when(isOff, (el) => el.opacity(0.45).cursor_default())
        .on_click((_event, cx) => this.press(drawn, handlerOf(handler), { key: label }, cx)).child(label);
    };
    return h_flex().role("navigation").accessibility_label("Pages").gap(UI.space.sm).items_center()
      .child(step(given.onPrevious, "Previous"))
      .child(div().text_color(t.muted).child(`${given.page ?? 1} of ${given.pages ?? 1}`))
      .child(step(given.onNext, "Next"));
  }

  progress(given, drawn, _path, t) {
    const value = typeof given.value === "number" ? Math.min(Math.max(given.value, 0), 100) : 0;
    const label = typeof given.label === "string" ? given.label : `${Math.round(value)}%`;
    const width = typeof given.width === "number" ? given.width * UI.cell : undefined;
    const sections = Array.isArray(given.sections) ? given.sections.filter((each) => typeof each?.value === "number") : [{ value }];
    const buffer = typeof given.buffer === "number" ? Math.min(given.buffer, 100) - value : 0;
    const parts = [...sections.map((each) => [Math.max(each.value, 0), colorOf(each.color, t) ?? (each.tone === undefined ? t.accent : toneOf(each.tone, t))]), ...(buffer > 0 ? [[buffer, tint(t.muted, "66") ?? t.muted]] : [])];
    return Progress.new(`${drawn.key}:progress:${label}`).value(value).accessibility_label(label).flex().items_center().min_w(0).when(width === undefined, (el) => el.flex_1()).when(width !== undefined, (el) => el.w(width ?? 0))
      .child(ProgressTrack.new().w_full().h(6).rounded(3).bg(t.border).overflow_hidden().flex()
        .children(parts.map(([share, color]) => ProgressIndicator.new().h_full().w(`${share}%`).bg(color))));
  }

  list(given, drawn, path, t) {
    return v_flex().min_w(0).gap(1).role("list").accessibility_label(typeof given.label === "string" ? given.label : "").children(this.nodes(given.children, drawn, `${path}.children`, t));
  }

  listItem(given, drawn, path, t) {
    const label = typeof given.label === "string" ? given.label : "";
    const key = given.key ?? label;
    const isSelected = given.isSelected === true;
    const handler = handlerOf(given.onPress);
    const toggle = handlerOf(given.onToggle);
    const isTree = typeof given.depth === "number";
    const dot = given.tone === undefined ? null : given.tone === "off" ? div().flex_none().size(UI.dot).rounded(UI.dot / 2).border_1().border_color(t.dim) : div().flex_none().size(UI.dot).rounded(UI.dot / 2).bg(toneOf(given.tone, t));
    const opener = !isTree
      ? null
      : typeof given.isOpen === "boolean" && toggle !== undefined
        ? Button.new(`${drawn.key}:${key}:toggle`).role("disclosure_triangle").accessibility_label(given.isOpen ? `Close ${label}` : `Open ${label}`).flex_none().size(UI.height.inline).flex().items_center().justify_center().rounded(UI.radius.pill).cursor_pointer().text_color(t.dim).hover((el) => el.bg(t.hover).text_color(t.foreground))
          .on_click((_event, cx) => this.press(drawn, toggle, { key: `${key}:toggle` }, cx)).child(icon(given.isOpen ? "chevron-down" : "chevron-right"))
        : div().flex_none().w(UI.height.inline);
    const content = (el) => el.flex_1().min_w(0).h(UI.height.control).px(UI.space.sm).flex().items_center().gap(UI.space.sm).rounded(UI.radius.control).text_color(t.foreground)
      .when(isSelected, (e) => e.bg(t.selected).font_medium())
      .when(dot !== null, (e) => e.child(dot))
      .when(typeof given.leading === "string", (e) => e.child(div().flex_none().text_color(t.muted).child(given.leading ?? "")))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(typeof given.description === "string", (e) => e.child(div().flex_none().text_size(UI.text.caption).text_color(t.muted).child(given.description ?? "")))
      .when(given.trailing !== undefined, (e) => e.child(h_flex().flex_none().gap(UI.space.xs).items_center().children(this.nodes(given.trailing, drawn, `${path}.trailing`, t, false))));
    const row = handler === undefined
      ? content(div())
      : content(Button.new(`${drawn.key}:${key}`).selected(isSelected).accessibility_label(label).cursor_pointer().hover((el) => el.bg(isSelected ? t.selected : t.hover)))
        .on_click((_event, cx) => this.press(drawn, handler, { key }, cx));
    return h_flex().min_w(0).ml(-UI.space.sm).mr(-UI.space.sm).items_center().gap(2).role(isTree ? "tree_item" : "list_item").accessibility_label(label).aria_selected(isSelected)
      .when(isTree, (el) => el.aria_level((given.depth ?? 0) + 1).pl((given.depth ?? 0) * UI.indent))
      .when(opener !== null, (el) => el.child(opener))
      .child(row);
  }

  badge(given, drawn, path, t) {
    const isToned = TONES[given.tone] !== undefined;
    const color = toneOf(given.tone, t);
    const words = textOf(given.children);
    return div().flex_none().px(6).h(UI.height.inline).flex().items_center().rounded(UI.radius.pill).text_size(UI.text.caption).font_medium()
      .text_color(isToned ? color : t.muted).bg((isToned ? tint(color, "26") : undefined) ?? t.raised)
      .role("label").accessibility_label(words ?? "").children(words === undefined ? this.nodes(given.children, drawn, `${path}.children`, t, false) : [words]);
  }

  banner(given, drawn, path, t) {
    const color = toneOf(given.tone, t);
    const title = typeof given.title === "string" ? given.title : undefined;
    const words = textOf(given.children);
    return v_flex().min_w(0).gap(UI.space.sm).px(UI.space.md).py(UI.space.sm + 2).rounded(UI.radius.control).bg(tint(color, "1f") ?? t.raised).role("status").accessibility_label(title ?? words ?? "")
      .when(title !== undefined, (el) => el.child(div().font_semibold().text_color(color).child(title ?? "")))
      .when(given.children !== undefined, (el) => el.child(words === undefined ? v_flex().min_w(0).gap(UI.space.sm).children(this.nodes(given.children, drawn, `${path}.children`, t)) : div().text_color(t.foreground).child(words)))
      .when(given.actions !== undefined, (el) => el.child(h_flex().flex_wrap().gap(UI.space.sm).children(this.nodes(given.actions, drawn, `${path}.actions`, t, false))));
  }
}
