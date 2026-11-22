import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Button, Tabs, Tab, TextView, InputState, Input, TextareaState, Textarea, EditorState, Editor } from "gpui-base";
import { exec, checking, terminals, focused, readTextFile, theme, run, props, appHome, settings, notify, panes, layout } from "herdr";
import { writeFile, readFile, mkdir, exists, readdir, unlink } from "fs/promises";
import { Buffer } from "buffer";
import { createHash } from "crypto";
import { deflateSync } from "zlib";

const CMOD = 'exec "${XDG_DATA_HOME:-$HOME/.local/share}/cmod/programs/cmod" "$@"';
const CLAUDE_HOME = 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
const SURFACE = "herdr";
const DASHBOARD = "dashboard";
const CALL_MS = 30_000;
const FOLLOW_MS = 20_000;
const RETRY_MS = 30_000;
const RESIZE_MS = 250;
const SHOW_MS = 5_000;
const CELL_PX = 8;
const ROW_PX = 20;
const SPACE_PX = 8;
const MIN_COLUMNS = 20;
const CODE_ROWS = 30;
const TYPE = { caption: 12, body: 13, heading: 14, title: 16 };
const RADIUS = { chip: 5, control: 7, card: 10 };
const HEADER_PX = 42;
const CONTROL_PX = 28;
const FIELD_PX = 32;
const CARD_INSET_PX = 12;
const BODY_INSET_PX = 12;
const TAB_MAX_PX = 168;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DRAWN = "mods/cmod/.drawn";
const SPACES = { xs: 0.25, sm: 0.5, md: 1, lg: 1.5, xl: 2 };
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const THEMED = {
  text: "foreground", inverseText: "background", inactive: "muted", subtle: "muted", secondaryText: "muted", userMessageBackground: "selected",
  claude: "accent", suggestion: "accent", remember: "ansi4", permission: "ansi4", ide: "ansi4", planMode: "ansi6", autoAccept: "ansi5",
  success: "ansi2", error: "ansi1", warning: "ansi3", merged: "ansi5", promptBorder: "border", bashBorder: "ansi5",
  diffAdded: "ansi2", diffRemoved: "ansi1", diffAddedDimmed: "ansi2", diffRemovedDimmed: "ansi1", diffAddedWord: "ansi10", diffRemovedWord: "ansi9",
};
const NEUTRAL_SURFACES = { userMessageBackground: "selected", inactive: "selected", subtle: "raised", secondaryText: "raised", promptBorder: "raised", gray: "raised", grey: "raised" };
const NEUTRAL_BORDERS = new Set(["subtle", "inactive", "secondaryText", "promptBorder", "userMessageBackground", "text", "gray", "grey"]);
const ACCENTS = new Set(["claude", "suggestion"]);
const CELL_ART = /[\u2500-\u259f\ue0a0-\ue0d4]| {2,}/;
const GLYPHS = { "\ue0b4": "\u25d7", "\ue0b6": "\u25d6", "\ue0b0": "\u25b6", "\ue0b2": "\u25c0" };
const drawable = (words) => words.replace(/[\ue0b4\ue0b6\ue0b0\ue0b2]/g, (glyph) => GLYPHS[glyph]);
const FIELDS = new Set(["Input", "Select"]);
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const messageOf = (error) => String(error?.message ?? error);
const keyOf = ({ mod, id }) => `${mod}/${id}`;

const cmodTabs = () => new Set(panes().filter((pane) => pane.mod === "cmod").map((pane) => pane.tab));

const pathTo = (node, isWanted) => {
  if (node === null || typeof node !== "object") return null;
  if (isWanted(node)) return [node];
  for (const child of node.children ?? []) {
    const path = pathTo(child, isWanted);
    if (path !== null) return [node, ...path];
  }
  return null;
};

const reveal = (path) => {
  path.forEach((node, index) => {
    const child = path[index + 1];
    if (node.type === "stack" && child !== undefined && node.active !== child.id) run("layout.select", { stack: node.id, child: child.id });
    if (node.hidden === true) run("layout.show", { id: node.id });
  });
};
const handlerOf = (value) => (typeof value?.$cmodHandler === "number" ? value.$cmodHandler : undefined);

const cmod = async (args, timeout = CALL_MS) => {
  const answer = await exec("sh", ["-c", CMOD, "cmod", ...args], { timeout });
  if (answer.code !== 0) throw new Error((answer.stderr || answer.stdout).trim() || `cmod ${args.slice(0, 2).join(" ")} exited with ${answer.code}`);
  return JSON.parse(answer.stdout);
};

const following = new Map();
const followed = (after) => {
  const key = after ?? "";
  if (!following.has(key)) following.set(key, cmod(["ui", "follow", ...(after === undefined ? [] : ["--after", after])], FOLLOW_MS).finally(() => following.delete(key)));
  return following.get(key);
};

const textOf = (children) => {
  const all = [children].flat(Infinity).filter((each) => each !== null && each !== undefined && typeof each !== "boolean");
  return all.every((each) => typeof each === "string" || typeof each === "number") ? all.join("") : undefined;
};

const across = (value) => (typeof value === "string" && value.endsWith("%") ? value : typeof value === "number" ? value * CELL_PX : undefined);
const down = (value) => (typeof value === "string" && value.endsWith("%") ? value : typeof value === "number" ? value * ROW_PX : undefined);
const spaceOf = (value) => (typeof value === "number" ? value : SPACES[value]);

const colorOf = (value, t, role = "text") => {
  if (typeof value !== "string") return undefined;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (role === "surface" && NEUTRAL_SURFACES[value] !== undefined) return t[NEUTRAL_SURFACES[value]];
  if (role === "border" && NEUTRAL_BORDERS.has(value)) return t.border;
  const bright = value.endsWith("Bright");
  const ansi = ANSI.indexOf(bright ? value.slice(0, -"Bright".length) : value);
  if (ansi >= 0) return t[`ansi${ansi + (bright ? 8 : 0)}`];
  if (value === "gray" || value === "grey") return t.muted;
  return t[THEMED[value] ?? value];
};

const inkOn = (surface, t) => (ACCENTS.has(surface) ? t.accent_foreground : NEUTRAL_SURFACES[surface] !== undefined ? t.foreground : t.background);

const wordsIn = (node) => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(wordsIn).join("");
  if (node === null || typeof node !== "object" || typeof node.$cmodElement !== "string") return "";
  return wordsIn(node.props?.children ?? (typeof node.props?.label === "string" ? node.props.label : ""));
};

const isLegend = (node) => node?.$cmodElement === "Box" && node.props?.position === "absolute" && (node.props.top ?? 0) === 0 && node.props.bottom === undefined;
const isCard = (node) => node?.$cmodElement === "Box" && typeof node.props?.borderStyle === "string";
const isLoneNote = (tree) => tree?.$cmodElement === "Text" && textOf(tree.props?.children) !== undefined;
const shownProblem = (problem) => problem.replace(/^cmod ui: /, "");

const walk = (node, path, visit) => {
  if (Array.isArray(node)) return node.forEach((each, index) => walk(each, `${path}.${index}`, visit));
  if (node === null || typeof node !== "object" || typeof node.$cmodElement !== "string") return;
  const props = node.props ?? {};
  visit(node.$cmodElement, props, path);
  walk(props.children, `${path}.c`, visit);
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

const imageFileOf = async (name, props, uses) => {
  if (name === "Svg") return typeof props.source === "string" ? drawnFile(new Uint8Array(Buffer.from(props.source, "utf8")), "svg", uses) : null;
  const source = props.source ?? {};
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

class Unit extends View {
  init(given) {
    this.owner = given.owner;
    this.key = given.key;
  }

  render(cx) {
    return this.owner.renderUnit(this.key, cx);
  }
}

export default class Cmod extends View {
  init(_props, cx) {
    const given = props() ?? {};
    this.show = given.show ?? "views";
    this.area = given.area ?? DASHBOARD;
    this.page = given.show === "page" ? { mod: given.mod, id: given.id, title: given.title ?? given.id } : null;
    this.session = given.show === "page" ? given.session ?? null : null;
    this.isHost = this.show === "views";
    this.isWindow = given.overlay !== undefined;
    this.retired = [];
    this.located = null;
    this.lists = { widgets: [], views: [], pages: [] };
    this.tab = null;
    this.pageTabs = new Map();
    this.openingTabs = [];
    this.units = new Map();
    this.columns = 40;
    this.error = null;
    this.followError = null;
    this.resizing = 0;
    this.client = `herdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.told = { session: null, parts: [], hosts: [] };
    this.sending = Promise.resolve(null);
    if (checking()) return;
    if (swept === null) {
      swept = deleteEveryDrawn();
      this.deleting(cx, swept);
    }
    this.claudeHome = exec("sh", ["-c", CLAUDE_HOME]).then((answer) => answer.stdout);
    if (this.show !== "widgets") cx.timer.every(SHOW_MS, (cx) => this.tellShown(cx, true));
    this.follow(cx);
    if (this.session !== null) this.refresh(cx);
  }

  target() {
    if (this.show === "page") return null;
    const address = props()?.terminal ?? focused()?.terminal ?? null;
    if (address === null) return null;
    const terminal = terminals().find((each) => each.address === address);
    return { address, pid: terminal?.foreground?.pid ?? terminal?.pid ?? null };
  }

  locate(cx) {
    const target = this.target();
    if (target === null) return;
    const located = `${target.address}:${target.pid}`;
    this.located = located;
    cx.spawn(async (cx) => {
      const session = await this.sessionOf(target);
      if (this.located !== located || session === this.session || (session === null && this.isHost)) return;
      this.session = session;
      this.tab = null;
      this.lists = { widgets: [], views: [], pages: [] };
      this.place(cx);
      cx.notify();
      if (session !== null) await this.refresh(cx);
    });
  }

  async sessionOf({ address, pid }) {
    if (pid === null || address.includes("/")) return null;
    const record = await readTextFile(`${await this.claudeHome}/sessions/${pid}.json`);
    return record === null ? null : JSON.parse(record).sessionId ?? null;
  }

  follow(cx) {
    cx.spawn(async (cx) => {
      let after;
      let retryMs = 1000;
      for (;;) {
        try {
          const { cursor, events, missed } = await followed(after);
          after = cursor;
          retryMs = 1000;
          if (this.followError !== null) {
            this.followError = null;
            cx.notify();
          }
          if (missed) await this.refresh(cx);
          else for (const event of events) await this.take(event, cx);
          this.locate(cx);
        } catch (error) {
          after = undefined;
          this.followError = messageOf(error);
          cx.notify();
          await cx.sleep(retryMs);
          retryMs = Math.min(retryMs * 2, RETRY_MS);
        }
      }
    });
  }

  async take(event, cx) {
    if (event.session !== this.session) return;
    if (event.event === "Redraw") {
      const unit = this.units.get(keyOf(event));
      if (unit) await this.draw(unit, cx);
      return;
    }
    if (event.event === "Open" || event.event === "Close") return this.opened(event, cx);
    await this.list(event.part);
    await this.settle(cx);
  }

  async opened(event, cx) {
    if (this.show !== "views") return;
    const key = keyOf(event);
    const shown = this.shownView();
    if (event.event === "Close" && shown !== undefined && keyOf(shown) === key) {
      this.tab = null;
      return this.settle(cx);
    }
    if (event.event === "Close") return this.closePage(key);
    const page = this.lists.pages.find((each) => keyOf(each) === key);
    if (page !== undefined) return this.openPage(page);
    if (!this.lists.views.some((view) => keyOf(view) === key)) return;
    this.tab = key;
    if (event.isAsked === true && this.isHost && !this.isWindow) this.revealSelf();
    await this.settle(cx);
  }

  revealSelf() {
    const own = JSON.stringify(props() ?? {});
    const isCmodViews = (node) => node.type === "block" && node.content?.mod === "cmod" && (node.content.props?.show ?? "views") === "views";
    const path = pathTo(layout(), (node) => isCmodViews(node) && JSON.stringify(node.content.props ?? {}) === own) ?? pathTo(layout(), isCmodViews);
    if (path !== null) reveal(path);
  }

  async settle(cx, isEveryUnit = false) {
    if (this.tab !== null && !this.lists.views.some((view) => keyOf(view) === this.tab)) this.tab = null;
    this.place(cx);
    cx.notify();
    await Promise.all([...this.units.values()].filter((unit) => isEveryUnit || unit.tree === null).map((unit) => this.draw(unit, cx)));
  }

  wantedLists() {
    if (this.show === "views") return ["views", "pages"];
    if (this.show === "widgets") return ["widgets"];
    return [];
  }

  async list(part) {
    const session = this.session;
    if (session === null || !this.wantedLists().includes(part)) return;
    const listed = await cmod(["ui", "list", part, session]);
    if (this.session === session) this.lists = { ...this.lists, [part]: listed };
  }

  async refresh(cx) {
    try {
      for (const part of this.wantedLists()) await this.list(part);
      this.error = null;
      await this.settle(cx, true);
    } catch (error) {
      this.error = messageOf(error);
      cx.notify();
    }
  }

  retry(cx) {
    this.error = null;
    cx.notify();
    cx.spawn((cx) => this.refresh(cx));
  }

  shownParts() {
    if (this.session === null) return [];
    if (this.show === "page") return this.page === null ? [] : [this.page];
    if (this.show === "widgets") return this.lists.widgets.filter((widget) => widget.areas.includes(this.area));
    const view = this.shownView();
    return view === undefined ? [] : [view];
  }

  shownView() {
    return this.lists.views.find((view) => keyOf(view) === this.tab) ?? this.lists.views[0];
  }

  place(cx) {
    const wanted = new Map(this.shownParts().map((part) => [keyOf(part), part]));
    for (const [key, unit] of this.units) {
      if (wanted.has(key)) continue;
      this.retired.push(unit.entity, ...[...unit.fields.values()].map((field) => field.state));
      this.units.delete(key);
      this.deleting(cx, this.deleteUnshown(unit.drawn));
    }
    for (const [key, part] of wanted) {
      if (this.units.has(key)) continue;
      const area = part.areas === undefined ? undefined : this.area;
      this.units.set(key, { mod: part.mod, id: part.id, area, key, tree: null, error: null, fields: new Map(), prepared: new Map(), drawn: new Set(), entity: cx.new(Unit, { owner: this, key }) });
    }
    this.tellShown(cx);
  }

  tellShown(cx, isRenewal = false) {
    if (this.show === "widgets") return;
    const told = this.told;
    const parts = this.shownParts().map(keyOf);
    const hosts = this.isHost ? ["--host"] : [];
    const toldHere = told.session === this.session ? [...told.parts, ...told.hosts] : [];
    this.told = { session: this.session, parts, hosts };
    const shown = [...parts, ...hosts];
    const sends = [
      ...(told.session !== null && told.session !== this.session && told.parts.length + told.hosts.length > 0 ? [[told.session, []]] : []),
      ...(this.session !== null && (shown.join(" ") !== toldHere.join(" ") || (isRenewal && shown.length > 0)) ? [[this.session, shown]] : []),
    ];
    if (sends.length === 0) return;
    const sent = this.sending.then(async () => {
      for (const [session, sent] of sends) await cmod(["ui", "show", session, this.client, ...sent]);
      return null;
    }).then((failure) => failure, (error) => messageOf(error));
    this.sending = sent;
    cx.spawn(async (cx) => {
      const failure = await sent;
      if (failure === null) return;
      this.error = failure;
      cx.notify();
    });
  }

  async close() {
    const { session, parts, hosts } = this.told;
    this.told = { session: null, parts: [], hosts: [] };
    await Promise.all([
      ...(session !== null && parts.length + hosts.length > 0 ? [cmod(["ui", "show", session, this.client])] : []),
      deleteDrawn([...this.units.values()].flatMap((unit) => [...unit.drawn])),
    ]);
  }

  deleteUnshown(names) {
    return deleteDrawn([...names].filter((name) => ![...this.units.values()].some((unit) => unit.drawn.has(name))));
  }

  deleting(cx, deleted) {
    cx.spawn(async (cx) => {
      try {
        await deleted;
      } catch (error) {
        this.error = messageOf(error);
        cx.notify();
      }
    });
  }

  async draw(unit, cx) {
    try {
      unit.tree = await cmod(["ui", "draw", this.session, unit.mod, unit.id, "--columns", String(this.columns), "--surface", SURFACE, ...(unit.area === undefined ? [] : ["--area", unit.area])]);
      unit.error = null;
      await this.prepare(unit);
    } catch (error) {
      unit.error = messageOf(error);
    }
    if (this.units.get(unit.key) === unit) cx.notify(unit.entity);
  }

  async prepare(unit) {
    const kept = new Set();
    const files = [];
    const uses = new Set();
    walk(unit.tree, unit.key, (name, given, path) => {
      if (name === "Input") kept.add(this.prepareField(unit, given));
      if (name === "Code") kept.add(this.prepareCode(unit, given, path));
      if (name === "Raster") unit.prepared.set(path, rasterRows(typeof given.cells === "string" ? given.cells : "", typeof given.columns === "number" ? given.columns : 1));
      if (name === "Image" || name === "Svg") files.push(imageFileOf(name, given, uses).then((file) => void unit.prepared.set(path, file)));
    });
    await Promise.all(files);
    const replaced = unit.drawn;
    unit.drawn = uses;
    await this.deleteUnshown(replaced);
    for (const [key, field] of unit.fields) {
      if (kept.has(key)) continue;
      this.retired.push(field.state);
      unit.fields.delete(key);
    }
  }

  prepareField(unit, given) {
    const key = `input:${given.key}`;
    const value = typeof given.value === "string" ? given.value : "";
    const known = unit.fields.get(key);
    if (known) {
      if (known.value !== value && known.state.value() !== value) known.state.set_value(value);
      Object.assign(known, { value, onInput: handlerOf(given.onInput), onSubmit: handlerOf(given.onSubmit) });
      return key;
    }
    const rows = typeof given.rows === "number" && given.rows > 1 ? Math.floor(given.rows) : 1;
    const options = { value, ...(typeof given.placeholder === "string" ? { placeholder: given.placeholder } : {}) };
    const state = rows > 1 ? TextareaState.new({ ...options, rows }) : InputState.new(options);
    const field = { state, rows, value, onInput: handlerOf(given.onInput), onSubmit: handlerOf(given.onSubmit) };
    state.on("change", (_event, cx) => this.press(unit, field.onInput, { key: given.key, kind: "change", value: state.value() }, cx));
    state.on("submit", (_event, cx) => this.press(unit, field.onSubmit, { key: given.key, kind: "submit", value: state.value() }, cx));
    unit.fields.set(key, field);
    return key;
  }

  prepareCode(unit, given, path) {
    const key = `code:${given.key ?? path}`;
    const source = typeof given.source === "string" ? given.source : "";
    const known = unit.fields.get(key);
    if (known) {
      if (known.value !== source) known.state.set_value(source);
      known.value = source;
      return key;
    }
    const t = theme();
    const language = given.language ?? (typeof given.path === "string" && given.path.includes(".") ? given.path.split(".").pop() : given.format === "diff" ? "diff" : "text");
    const state = EditorState.new({
      language, value: source, readonly: true, line_numbers: typeof given.startLine === "number", soft_wrap: given.wrap !== "truncate-end",
      font_family: settings().font_family, syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    unit.fields.set(key, { state, value: source });
    return key;
  }

  press(unit, handler, input, cx) {
    if (handler === undefined || this.session === null) return;
    const session = this.session;
    cx.spawn(async (cx) => {
      try {
        await cmod(["ui", "press", session, String(handler), JSON.stringify({ surface: SURFACE, ...input })]);
      } catch (error) {
        unit.error = messageOf(error);
        cx.notify(unit.entity);
      }
    });
  }

  openLink(href, cx) {
    if (/^https?:\/\//.test(href)) return cx.open_url(href);
    cx.write_to_clipboard(href);
    notify({ title: "Copied the link", body: "Paste it where you open it.", level: "info" });
  }

  openPage(page) {
    const key = keyOf(page);
    const tab = this.pageTabs.get(key);
    if (tab !== undefined && cmodTabs().has(tab)) return run("tab.select", { id: tab });
    this.openingTabs.push({ key, before: cmodTabs() });
    run("tab.new", { name: page.title, mod: "cmod", props: { show: "page", session: this.session, mod: page.mod, id: page.id, title: page.title } });
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
    const inset = this.show === "widgets" ? 0 : BODY_INSET_PX * 2;
    const columns = Math.max(MIN_COLUMNS, Math.floor((size.width / (Number(settings().zoom) || 1) - inset) / CELL_PX));
    if (columns === this.columns) return;
    this.columns = columns;
    const resizing = (this.resizing += 1);
    cx.timer.after(RESIZE_MS, (cx) => {
      if (this.resizing !== resizing) return;
      cx.spawn(async (cx) => {
        await Promise.all([...this.units.values()].map((unit) => this.draw(unit, cx)));
      });
    });
  }

  render(cx) {
    const target = this.target();
    if (!checking() && target !== null && `${target.address}:${target.pid}` !== this.located) this.locate(cx);
    this.notePageTabs();
    this.releaseRetired(cx);
    const t = theme();
    const units = [...this.units.values()];
    const problem = this.error ?? this.followError;
    if (this.show === "widgets") {
      return h_flex().id("cmod-root").size_full().min_w(0).gap(SPACE_PX * 1.5).items_center().text_size(TYPE.body).text_color(t.foreground)
        .on_size_change((size, cx) => this.resized(size, cx))
        .children(units.map((unit) => unit.entity))
        .when(problem !== null, (el) => el.child(div().text_size(TYPE.caption).text_color(t.blocked).truncate().role("alert").accessibility_label(shownProblem(problem ?? "")).child(shownProblem(problem ?? ""))));
    }
    const isCard = this.show === "views" && !this.isWindow;
    return v_flex().id("cmod-root").size_full().min_h(0).min_w(0).text_size(TYPE.body).text_color(t.foreground)
      .when(isCard, (el) => el.rounded(RADIUS.card).overflow_hidden().bg(t.background).border_1().border_color(t.border))
      .on_size_change((size, cx) => this.resized(size, cx))
      .when(this.show === "views" && this.lists.views.length + this.lists.pages.length > 0, (el) => el.child(this.header(t)))
      .child(this.body(units, problem, t))
      .when(problem !== null && units.length > 0, (el) => el.child(this.problemBar(problem ?? "", t)));
  }

  body(units, problem, t) {
    if (this.session === null) {
      return this.page === null
        ? this.emptyState("No session yet", "Focus a Claude Code session to see its Dashboard, History, Settings, and its mods' views.", t)
        : this.emptyState("This page has no session", "Open it again from its session's views.", t);
    }
    if (units.length === 0 && problem !== null) return this.emptyState("This session can't show its views here", shownProblem(problem), t, { label: "Try again", run: (cx) => this.retry(cx) });
    if (units.length === 0) return this.loadingState(t);
    if (units.length === 1 && isLoneNote(units[0].tree)) return v_flex().id("cmod-units").flex_1().min_h(0).items_center().justify_center().p(BODY_INSET_PX * 2).child(units[0].entity);
    return v_flex().id("cmod-units").flex_1().min_h(0).min_w(0).p(BODY_INSET_PX).gap(BODY_INSET_PX).overflow_y_scrollbar().children(units.map((unit) => unit.entity));
  }

  emptyState(title, text, t, action) {
    return v_flex().id("cmod-empty").flex_1().min_h(0).items_center().justify_center().gap(SPACE_PX * 0.75).p(BODY_INSET_PX * 2)
      .child(div().role("heading").accessibility_label(title).text_size(TYPE.heading).font_semibold().text_center().child(title))
      .child(div().role("label").accessibility_label(text).max_w(320).text_color(t.muted).text_center().child(text))
      .when(action !== undefined, (el) => el.child(div().pt(SPACE_PX).child(this.control(Button.new("cmod-empty-action"), "outline", t).accessibility_label(action?.label ?? "").on_click((_event, cx) => action?.run(cx)).child(action?.label ?? ""))));
  }

  loadingState(t) {
    return h_flex().id("cmod-loading").flex_1().min_h(0).items_center().justify_center().gap(SPACE_PX).text_color(t.muted).role("status").accessibility_label("Loading this session's views")
      .child(div().font_family(settings().font_family ?? "JetBrains Mono").frames(SPINNER, 80).child(SPINNER[0]))
      .child("Loading views");
  }

  problemBar(problem, t) {
    return h_flex().id("cmod-problem").flex_none().gap(SPACE_PX).items_center().px(BODY_INSET_PX).py(SPACE_PX).border_t(1).border_color(t.border).text_size(TYPE.caption)
      .child(div().flex_1().min_w(0).text_color(t.blocked).role("alert").accessibility_label(shownProblem(problem)).child(shownProblem(problem)))
      .child(Button.new("cmod-problem-retry").accessibility_label("Try again").flex_none().px(SPACE_PX).h(24).flex().items_center().rounded(RADIUS.chip).cursor_pointer().text_color(t.muted).hover((el) => el.bg(t.hover).text_color(t.foreground))
        .on_click((_event, cx) => this.retry(cx)).child("Try again"));
  }

  control(el, kind, t) {
    el = el.flex().flex_none().items_center().justify_center().gap(SPACE_PX * 0.75).rounded(RADIUS.control).border_1().cursor_pointer().max_w_full();
    el = kind === "ghost" ? el.py(2) : el.h(CONTROL_PX).px(SPACE_PX * 1.5);
    if (kind === "primary") return el.bg(t.solid).border_color(t.solid).text_color(t.solid_foreground).font_medium().hover((h) => h.opacity(0.9)).focus((f) => f.border_color(t.accent));
    if (kind === "outline") return el.bg(t.raised).border_color(t.border).font_medium().hover((h) => h.bg(t.hover)).focus((f) => f.border_color(t.accent));
    return el.border_color("#00000000").hover((h) => h.text_color(t.foreground)).focus((f) => f.border_color(t.accent));
  }

  releaseRetired(cx) {
    if (this.retired.length === 0) return;
    const released = this.retired;
    this.retired = [];
    cx.timer.after(0, () => {
      for (const each of released) each.release();
    });
  }

  header(t) {
    const views = this.lists.views;
    const pages = this.lists.pages;
    const shown = this.shownView();
    const tab = (el, isSelected) => el.flex_none().max_w(TAB_MAX_PX).h(CONTROL_PX).px(SPACE_PX * 1.25).flex().items_center().rounded(RADIUS.control).truncate().cursor_pointer()
      .text_color(isSelected ? t.foreground : t.muted).when(isSelected, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover).text_color(t.foreground));
    const viewTabs = views.map((view, index) => {
      const key = keyOf(view);
      const isSelected = shown !== undefined && key === keyOf(shown);
      return tab(Tab.new(`cmod-tab-${key}`).selected(isSelected).set_position(index + 1, views.length).tooltip(view.title), isSelected)
        .on_click((_event, cx) => {
          this.tab = key;
          cx.spawn((cx) => this.settle(cx));
        })
        .child(view.title);
    });
    const pageTabs = pages.map((page) =>
      tab(Button.new(`cmod-page-${keyOf(page)}`).role("link").accessibility_label(`${page.title}, opens in its own tab`).tooltip(`Open ${page.title} in its own tab`).gap(SPACE_PX / 2), false)
        .on_click(() => this.openPage(page))
        .child(div().truncate().child(page.title))
        .child(div().flex_none().text_color(t.dim).child("↗")),
    );
    return h_flex().id("cmod-header").flex_none().h(HEADER_PX).px(SPACE_PX).items_center().border_b(1).border_color(t.border).child(
      Tabs.new("cmod-tabs").accessibility_label("Views").h_flex().flex_1().min_w(0).h_full().items_center().gap(SPACE_PX / 4).overflow_x_scroll()
        .children(viewTabs)
        .when(pageTabs.length > 0, (el) => el.child(div().flex_none().w(1).h(16).mx(SPACE_PX / 2).bg(t.border)).children(pageTabs)),
    );
  }

  renderUnit(key) {
    const unit = this.units.get(key);
    const t = theme();
    if (!unit) return div();
    if (unit.error !== null && unit.tree === null) return div().text_color(t.blocked).text_size(TYPE.caption).role("alert").accessibility_label(unit.error).child(unit.error);
    if (isLoneNote(unit.tree)) return div().max_w(320).text_center().text_color(t.muted).role("label").accessibility_label(wordsIn(unit.tree)).child(wordsIn(unit.tree));
    return v_flex().id(`unit-${key}`).min_w(0).gap(SPACE_PX)
      .children(this.nodes(unit.tree, unit, unit.key, t))
      .when(unit.error !== null, (el) => el.child(div().text_color(t.blocked).text_size(TYPE.caption).role("alert").accessibility_label(unit.error ?? "").child(unit.error ?? "")));
  }

  nodes(value, unit, path, t, inColumn = true) {
    if (Array.isArray(value)) return value.flatMap((each, index) => this.nodes(each, unit, `${path}.${index}`, t, inColumn));
    if (value === null || value === undefined || typeof value === "boolean") return [];
    if (typeof value === "string" || typeof value === "number") return [div().child(String(value))];
    const draw = this.elements[value.$cmodElement];
    if (draw === undefined) return [div().text_color(t.muted).child(`Herdr draws no ${value.$cmodElement}.`)];
    const drawn = draw.call(this, value.props ?? {}, unit, path, t, inColumn);
    return drawn === null ? [] : [drawn];
  }

  get elements() {
    return { Box: this.box, Text: this.text, Button: this.button, Link: this.link, Code: this.code, Markdown: this.markdown, Input: this.input, Select: this.select, Image: this.picture, Svg: this.picture, Raster: this.raster };
  }

  box(given, unit, path, t) {
    if (given.display === "none" && given.hover?.display !== "flex") return null;
    const children = Array.isArray(given.children) ? given.children : [given.children];
    const legend = Array.isArray(given.children) && children.some(isCard) ? children.find(isLegend) : undefined;
    if (legend !== undefined) {
      const title = wordsIn(legend).trim();
      const rest = children.flatMap((child, index) => (child === legend ? [] : this.nodes(child, unit, `${path}.c.${index}`, t, true)));
      return this.boxed(given, unit, t).flex_col().gap(SPACE_PX * 0.75)
        .child(div().flex_none().px(2).text_size(TYPE.heading).font_semibold().truncate().role("heading").accessibility_label(title).child(title))
        .children(rest);
    }
    return this.boxed(given, unit, t)
      .when(children.some((child) => child?.props?.position === "absolute"), (el) => el.relative())
      .children(this.nodes(given.children, unit, `${path}.c`, t, given.flexDirection === "column" || given.flexDirection === "column-reverse"));
  }

  boxed(given, unit, t) {
    const isColumn = given.flexDirection === "column" || given.flexDirection === "column-reverse";
    const isCardBox = typeof given.borderStyle === "string";
    let el = div().flex().min_w(0);
    el = isColumn ? el.flex_col() : el.flex_row();
    if (given.flexWrap === "wrap") el = el.flex_wrap();
    const children = [given.children].flat(Infinity);
    const align = given.alignItems ?? (isColumn ? undefined : children.some((child) => FIELDS.has(child?.$cmodElement)) ? "flex-end" : "flex-start");
    el = { "flex-start": (e) => e.items_start(), center: (e) => e.items_center(), "flex-end": (e) => e.items_end(), stretch: (e) => e.items_stretch() }[align]?.(el) ?? el;
    el = { "flex-start": (e) => e.self_start(), center: (e) => e.self_center(), "flex-end": (e) => e.self_end() }[given.alignSelf]?.(el) ?? el;
    el = { "flex-start": (e) => e.justify_start(), center: (e) => e.justify_center(), "flex-end": (e) => e.justify_end(), "space-between": (e) => e.justify_between(), "space-around": (e) => e.justify_around(), "space-evenly": (e) => e.justify_evenly() }[given.justifyContent]?.(el) ?? el;
    if (typeof given.flexGrow === "number" && given.flexGrow > 0) el = el.flex_grow(given.flexGrow);
    if (given.flexShrink === 0) el = el.flex_shrink_0();
    const gapX = spaceOf(given.columnGap ?? given.gap);
    const gapY = spaceOf(given.rowGap ?? given.gap) ?? (given.flexWrap === "wrap" && !isColumn ? 1 : undefined);
    if (gapX !== undefined) el = el.gap_x(gapX * SPACE_PX);
    if (gapY !== undefined) el = el.gap_y(gapY * SPACE_PX);
    for (const [side, axis, method] of [["Top", "Y", "t"], ["Right", "X", "r"], ["Bottom", "Y", "b"], ["Left", "X", "l"]]) {
      const padding = spaceOf(given[`padding${side}`] ?? given[`padding${axis}`] ?? given.padding);
      const margin = spaceOf(given[`margin${side}`] ?? given[`margin${axis}`] ?? given.margin);
      const inset = (padding ?? 0) * SPACE_PX + (isCardBox ? CARD_INSET_PX : 0);
      if (inset > 0) el = el[`p${method}`](inset);
      if (margin !== undefined && margin !== 0) el = el[`m${method}`](margin * SPACE_PX);
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
    if (isCardBox) {
      el = el.border_1().border_color(colorOf(given.borderColor, t, "border") ?? t.border).rounded(given.borderStyle === "round" ? RADIUS.card : RADIUS.control);
      if (given.borderStyle === "dashed" || given.borderStyle === "classic") el = el.border_dashed();
    } else if (background !== undefined) {
      el = el.rounded(RADIUS.control);
      if (given.paddingY === undefined && given.padding === undefined && given.paddingTop === undefined && given.paddingBottom === undefined) el = el.py(2);
    }
    if (background !== undefined) el = el.bg(background);
    if (given.overflow === "hidden" || isCardBox) el = el.overflow_hidden();
    const hoverBackground = colorOf(given.hover?.backgroundColor, t, "surface");
    if (typeof given.key === "string") el = el.id(`${unit.key}:${given.key}`).when(hoverBackground !== undefined, (e) => e.hover((h) => h.bg(hoverBackground)));
    return el;
  }

  styled(el, given, t) {
    const background = colorOf(given.backgroundColor, t, "surface");
    const ink = given.color === "inverseText" && background !== undefined ? inkOn(given.backgroundColor, t) : colorOf(given.color, t);
    if (given.inverse === true) el = el.bg(colorOf(given.color ?? "text", t, "surface") ?? t.foreground).text_color(background ?? t.background);
    else {
      if (ink !== undefined && given.dimColor !== true) el = el.text_color(ink);
      else if (given.dimColor === true) el = el.text_color(t.muted);
      if (background !== undefined) el = el.bg(background);
    }
    if (given.bold === true || given.weight === "bold") el = el.font_semibold();
    else if (given.weight === "semibold") el = el.font_semibold();
    else if (given.weight === "medium") el = el.font_medium();
    if (given.italic === true) el = el.italic();
    if (given.underline === true) el = el.underline();
    if (given.strikethrough === true) el = el.line_through();
    const size = { caption: TYPE.caption, footnote: TYPE.caption, heading: TYPE.heading, title: TYPE.title }[given.size];
    if (size !== undefined) el = el.text_size(size);
    if (given.size === "heading" || given.size === "title") el = el.font_semibold();
    if (typeof given.wrap === "string" && given.wrap !== "wrap") el = el.truncate();
    return el;
  }

  text(given, unit, path, t) {
    const words = textOf(given.children);
    if (words === undefined) return this.styled(h_flex().flex_wrap().min_w(0), given, t).children(this.nodes(given.children, unit, `${path}.c`, t, false));
    const isCellArt = CELL_ART.test(words);
    const isChip = !isCellArt && (given.inverse === true || colorOf(given.backgroundColor, t, "surface") !== undefined);
    const shown = isChip ? words.trim() : drawable(words);
    let el = this.styled(div().role("label").accessibility_label(shown.trim()), given, t).child(shown);
    if (isChip) el = el.flex_none().px(SPACE_PX * 0.75).py(1).rounded(RADIUS.chip).text_size(TYPE.caption).font_medium();
    if (isCellArt) el = el.font_family(settings().font_family ?? "JetBrains Mono").whitespace_nowrap();
    return el;
  }

  button(given, unit, path, t, inColumn) {
    const handler = handlerOf(given.onPress);
    const label = typeof given.label === "string" ? given.label : undefined;
    const words = textOf(given.children);
    const key = typeof given.key === "string" ? given.key : label ?? words ?? path;
    const name = (label ?? words ?? key).trim();
    const hotkey = typeof given.hotkey === "string" ? given.hotkey : undefined;
    const kind = given.variant === "primary" ? "primary" : given.plain === true && given.variant === undefined && given.dimColor === true ? "ghost" : "outline";
    let el = this.control(Button.new(`${unit.key}:${key}`).accessibility_label(name), kind, t);
    if (inColumn) el = el.self_start();
    if (kind === "ghost") el = el.text_color(t.muted).justify_start();
    el = el.on_click((_event, cx) => (handler !== undefined ? this.press(unit, handler, { key }, cx) : typeof given.href === "string" ? this.openLink(given.href, cx) : undefined));
    if (label === undefined && words === undefined && given.children !== undefined && !(Array.isArray(given.children) && given.children.length === 0)) return el.child(h_flex().min_w(0).gap(SPACE_PX / 2).children(this.nodes(given.children, unit, `${path}.c`, t, false)));
    return el.child(div().min_w(0).truncate().child(name))
      .when(hotkey !== undefined && label !== undefined, (e) => e.child(div().flex_none().px(SPACE_PX / 2).rounded(RADIUS.chip).bg(t.raised).text_size(TYPE.caption).text_color(t.muted).child((hotkey ?? "").toUpperCase())));
  }

  link(given, unit, _path, t) {
    const href = typeof given.href === "string" ? given.href : "";
    const shown = textOf(given.children) || (typeof given.label === "string" ? given.label : href);
    return Button.new(`${unit.key}:link:${href}`).accessibility_label(shown).role("link").cursor_pointer().rounded(RADIUS.chip).text_color(t.accent).hover((h) => h.underline()).focus((f) => f.underline())
      .on_click((_event, cx) => this.openLink(href, cx)).child(shown);
  }

  code(given, unit, path, t) {
    const field = unit.fields.get(`code:${given.key ?? path}`);
    const source = typeof given.source === "string" ? given.source : "";
    const rows = Math.min(Math.max(source.split("\n").length, 1), CODE_ROWS);
    if (!field) return div().font_family(settings().font_family ?? "JetBrains Mono").text_size(TYPE.caption).text_color(t.muted).child(source);
    return div().id(`${unit.key}:code:${given.key ?? path}`).h(rows * ROW_PX + SPACE_PX * 2).rounded(RADIUS.control).border_1().border_color(t.border).bg(t.background).overflow_hidden().child(Editor.new(field.state).size_full());
  }

  markdown(given, unit, path, t) {
    const handler = handlerOf(given.onLinkPress);
    const pressable = Array.isArray(given.pressableLinks) ? given.pressableLinks : undefined;
    const key = typeof given.key === "string" ? given.key : path;
    let el = TextView.markdown(`${unit.key}:markdown:${key}`, typeof given.text === "string" ? given.text : "").selectable(true)
      .on_link_click((url, cx) => (handler !== undefined && (pressable === undefined || pressable.includes(url)) ? this.press(unit, handler, { key, link: { href: url } }, cx) : this.openLink(url, cx)));
    if (given.dimColor === true) el = el.text_color(t.muted);
    return el;
  }

  fieldLabel(label, t) {
    return div().text_size(TYPE.caption).font_medium().text_color(t.muted).child(label);
  }

  input(given, unit, _path, t) {
    const field = unit.fields.get(`input:${given.key}`);
    const label = typeof given.label === "string" ? given.label : undefined;
    const name = label ?? (typeof given.placeholder === "string" ? given.placeholder : given.key);
    const rows = field?.rows ?? 1;
    return v_flex().min_w(180).max_w_full().gap(SPACE_PX / 2)
      .when(label !== undefined, (el) => el.child(this.fieldLabel(label ?? "", t)))
      .child(field
        ? div().id(`${unit.key}:field:${given.key}`).min_h(rows > 1 ? rows * ROW_PX + SPACE_PX * 2 : FIELD_PX).px(SPACE_PX * 1.25).py(SPACE_PX / 2).flex().items_center().rounded(RADIUS.control).border_1().border_color(t.input).bg(t.background).cursor_text()
          .child((rows > 1 ? Textarea : Input).new(field.state).accessibility_label(name).size_full())
        : div().text_color(t.muted).child(typeof given.value === "string" ? given.value : ""));
  }

  select(given, unit, _path, t) {
    const handler = handlerOf(given.onSelect);
    const options = Array.isArray(given.options) ? given.options.filter((option) => typeof option?.value === "string") : [];
    const label = typeof given.label === "string" ? given.label : given.key;
    return v_flex().min_w(0).gap(SPACE_PX / 2)
      .when(typeof given.label === "string", (el) => el.child(this.fieldLabel(given.label, t)))
      .child(h_flex().id(`${unit.key}:select:${given.key}`).role("radio_group").accessibility_label(label).flex_wrap().gap(2).p(2).rounded(RADIUS.control + 2).bg(t.raised).border_1().border_color(t.border).children(
        options.map((option, index) => {
          const isSelected = option.value === given.value;
          const shown = typeof option.label === "string" ? option.label : option.value;
          return Button.new(`${unit.key}:${given.key}:${option.value}`).role("radio_button").selected(isSelected).set_position(index + 1, options.length).accessibility_label(shown)
            .h(CONTROL_PX - 6).px(SPACE_PX * 1.25).flex().items_center().rounded(RADIUS.control - 2).border_1().border_color(isSelected ? t.border : "#00000000").cursor_pointer()
            .text_color(isSelected ? t.foreground : t.muted).when(isSelected, (el) => el.bg(t.background).font_medium()).hover((el) => el.text_color(t.foreground)).focus((el) => el.border_color(t.accent))
            .on_click((_event, cx) => this.press(unit, handler, { key: given.key, value: option.value }, cx))
            .child(shown);
        }),
      ));
  }

  picture(given, unit, path, t) {
    const label = typeof given.label === "string" ? given.label : typeof given.alt === "string" ? given.alt : "";
    const file = unit.prepared.get(path);
    const frame = div().role("image").accessibility_label(label);
    if (!file) return frame.text_color(t.dim).child(label);
    const width = typeof given.columns === "number" ? given.columns * CELL_PX : given.width;
    const height = typeof given.rows === "number" ? given.rows * ROW_PX : given.height;
    let picture = image(file);
    if (typeof width === "number") picture = picture.w(width);
    if (typeof height === "number") picture = picture.h(height);
    return frame.child(picture);
  }

  raster(given, unit, path) {
    const rows = unit.prepared.get(path) ?? [];
    const label = typeof given.label === "string" ? given.label : "";
    return v_flex().role("image").accessibility_label(label).font_family(settings().font_family ?? "JetBrains Mono").line_height(ROW_PX).children(
      rows.map((row) => h_flex().children(row.map((run) => {
        let el = div().whitespace_nowrap().child(run.text);
        if (run.fg !== null) el = el.text_color(run.fg);
        if (run.bg !== null) el = el.bg(run.bg);
        return el;
      }))),
    );
  }
}
