import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Button, Tabs, Tab, TextView, InputState, Input, TextareaState, Textarea, EditorState, Editor } from "gpui-base";
import { exec, checking, terminals, focused, readTextFile, theme, run, props, appHome, settings, notify, panes } from "herdr";
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
const ROW_PX = 18;
const SPACE_PX = 6;
const MIN_COLUMNS = 20;
const CODE_ROWS = 30;
const DRAWN = "mods/cmod/.drawn";
const SPACES = { xs: 0.25, sm: 0.5, md: 1, lg: 1.5, xl: 2 };
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const THEMED = {
  text: "foreground", inverseText: "background", inactive: "dim", subtle: "dim", secondaryText: "muted",
  claude: "accent", suggestion: "accent", remember: "ansi4", permission: "ansi4", ide: "ansi4", planMode: "ansi6", autoAccept: "ansi5",
  success: "ansi2", error: "ansi1", warning: "ansi3", merged: "ansi5", promptBorder: "border", bashBorder: "ansi5",
  diffAdded: "ansi2", diffRemoved: "ansi1", diffAddedDimmed: "ansi2", diffRemovedDimmed: "ansi1", diffAddedWord: "ansi10", diffRemovedWord: "ansi9",
};
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const messageOf = (error) => String(error?.message ?? error);
const keyOf = ({ mod, id }) => `${mod}/${id}`;

const cmodTabs = () => new Set(panes().filter((pane) => pane.mod === "cmod").map((pane) => pane.tab));
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

const colorOf = (value, t) => {
  if (typeof value !== "string") return undefined;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  const bright = value.endsWith("Bright");
  const ansi = ANSI.indexOf(bright ? value.slice(0, -"Bright".length) : value);
  if (ansi >= 0) return t[`ansi${ansi + (bright ? 8 : 0)}`];
  if (value === "gray" || value === "grey") return t.ansi8;
  return t[THEMED[value] ?? value];
};

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
    this.located = null;
    this.lists = { widgets: [], views: [], pages: [] };
    this.tab = null;
    this.pageTabs = new Map();
    this.openingTabs = [];
    this.units = new Map();
    this.columns = 40;
    this.error = null;
    this.resizing = 0;
    this.client = `herdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.told = { session: null, parts: [] };
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
      if (this.located !== located || session === this.session) return;
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
          if (this.error !== null) {
            this.error = null;
            cx.notify();
          }
          if (missed) await this.refresh(cx);
          else for (const event of events) await this.take(event, cx);
          this.locate(cx);
        } catch (error) {
          after = undefined;
          this.error = messageOf(error);
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
    await this.settle(cx);
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
    if (this.session === null || !this.wantedLists().includes(part)) return;
    this.lists = { ...this.lists, [part]: await cmod(["ui", "list", part, this.session]) };
  }

  async refresh(cx) {
    try {
      for (const part of this.wantedLists()) await this.list(part);
      await this.settle(cx, true);
    } catch (error) {
      this.error = messageOf(error);
      cx.notify();
    }
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
      unit.entity.release();
      for (const field of unit.fields.values()) field.state.release();
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
    const toldHere = told.session === this.session ? told.parts : [];
    this.told = { session: this.session, parts };
    const sends = [
      ...(told.session !== null && told.session !== this.session && told.parts.length > 0 ? [[told.session, []]] : []),
      ...(this.session !== null && (parts.join(" ") !== toldHere.join(" ") || (isRenewal && parts.length > 0)) ? [[this.session, parts]] : []),
    ];
    if (sends.length === 0) return;
    const sent = this.sending.then(async () => {
      for (const [session, shown] of sends) await cmod(["ui", "show", session, this.client, ...shown]);
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
    const { session, parts } = this.told;
    this.told = { session: null, parts: [] };
    await Promise.all([
      ...(session !== null && parts.length > 0 ? [cmod(["ui", "show", session, this.client])] : []),
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
      field.state.release();
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
    const columns = Math.max(MIN_COLUMNS, Math.floor(size.width / (Number(settings().zoom) || 1) / CELL_PX));
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
    const t = theme();
    const units = [...this.units.values()];
    const body =
      this.session === null ? this.note(this.show === "page" ? "This page names no session." : "Focus a Claude Code session to see its views.", t)
      : units.length === 0 ? this.note(this.show === "views" && this.lists.views.length === 0 ? "This session shows no views." : "No mod draws here.", t)
      : v_flex().id("cmod-units").flex_1().min_h(0).gap(SPACE_PX * 2).overflow_y_scrollbar().children(units.map((unit) => unit.entity));
    const root = (this.show === "widgets" ? h_flex().gap(SPACE_PX * 2).items_center() : v_flex().gap(SPACE_PX).p(SPACE_PX * 2))
      .id("cmod-root").size_full().min_h(0).text_size(13).text_color(t.foreground)
      .on_size_change((size, cx) => this.resized(size, cx))
      .when(this.show === "views", (el) => el.child(this.tabBar(t)))
      .child(body)
      .when(this.show === "views" && this.lists.pages.length > 0, (el) => el.child(this.pageList(t)))
      .when(this.error !== null, (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.error ?? "")));
    return root;
  }

  note(text, t) {
    return div().id("cmod-note").p(SPACE_PX).text_color(t.dim).role("label").accessibility_label(text).child(text);
  }

  tabBar(t) {
    const tabs = this.lists.views.map((view) => ({ key: keyOf(view), title: view.title }));
    const shown = this.shownView();
    return Tabs.new("cmod-tabs").accessibility_label("Views").h_flex().gap(SPACE_PX).flex_wrap().children(
      tabs.map(({ key, title }, index) => {
        const isSelected = shown !== undefined && key === keyOf(shown);
        return Tab.new(`cmod-tab-${key}`).selected(isSelected).set_position(index + 1, tabs.length).px(SPACE_PX * 1.5).py(SPACE_PX / 2).rounded(6).cursor_pointer()
          .text_color(isSelected ? t.foreground : t.muted).when(isSelected, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
          .on_click((_event, cx) => {
            this.tab = key;
            cx.spawn((cx) => this.settle(cx));
          })
          .child(title);
      }),
    );
  }

  pageList(t) {
    return v_flex().id("cmod-pages").role("list").accessibility_label("Pages").gap(SPACE_PX / 2).pt(SPACE_PX).border_t(1).border_color(t.border).children(
      this.lists.pages.map((page) =>
        Button.new(`cmod-page-${keyOf(page)}`).accessibility_label(`Open ${page.title}`).px(SPACE_PX).py(SPACE_PX / 2).rounded(6).cursor_pointer().text_color(t.muted).hover((el) => el.bg(t.hover))
          .on_click(() => this.openPage(page))
          .child(`${page.title} ↗`),
      ),
    );
  }

  renderUnit(key) {
    const unit = this.units.get(key);
    const t = theme();
    if (!unit) return div();
    if (unit.error !== null && unit.tree === null) return div().text_color(t.blocked).text_size(12).child(unit.error);
    return v_flex().id(`unit-${key}`).min_w(0)
      .children(this.nodes(unit.tree, unit, unit.key, t))
      .when(unit.error !== null, (el) => el.child(div().text_color(t.blocked).text_size(11).child(unit.error ?? "")));
  }

  nodes(value, unit, path, t) {
    if (Array.isArray(value)) return value.flatMap((each, index) => this.nodes(each, unit, `${path}.${index}`, t));
    if (value === null || value === undefined || typeof value === "boolean") return [];
    if (typeof value === "string" || typeof value === "number") return [div().child(String(value))];
    const draw = this.elements[value.$cmodElement];
    if (draw === undefined) return [div().text_color(t.dim).child(`Herdr draws no ${value.$cmodElement}.`)];
    const drawn = draw.call(this, value.props ?? {}, unit, path, t);
    return drawn === null ? [] : [drawn];
  }

  get elements() {
    return { Box: this.box, Text: this.text, Button: this.button, Link: this.link, Code: this.code, Markdown: this.markdown, Input: this.input, Select: this.select, Image: this.picture, Svg: this.picture, Raster: this.raster };
  }

  box(given, unit, path, t) {
    if (given.display === "none") return null;
    const isColumn = given.flexDirection === "column" || given.flexDirection === "column-reverse";
    let el = div().flex().min_w(0);
    el = isColumn ? el.flex_col() : el.flex_row();
    if (given.flexWrap === "wrap") el = el.flex_wrap();
    el = { "flex-start": (e) => e.items_start(), center: (e) => e.items_center(), "flex-end": (e) => e.items_end(), stretch: (e) => e.items_stretch() }[given.alignItems]?.(el) ?? el;
    el = { "flex-start": (e) => e.self_start(), center: (e) => e.self_center(), "flex-end": (e) => e.self_end() }[given.alignSelf]?.(el) ?? el;
    el = { "flex-start": (e) => e.justify_start(), center: (e) => e.justify_center(), "flex-end": (e) => e.justify_end(), "space-between": (e) => e.justify_between(), "space-around": (e) => e.justify_around(), "space-evenly": (e) => e.justify_evenly() }[given.justifyContent]?.(el) ?? el;
    if (typeof given.flexGrow === "number" && given.flexGrow > 0) el = el.flex_grow();
    if (given.flexShrink === 0) el = el.flex_shrink_0();
    const gapX = spaceOf(given.columnGap ?? given.gap);
    const gapY = spaceOf(given.rowGap ?? given.gap);
    if (gapX !== undefined) el = el.gap_x(gapX * SPACE_PX);
    if (gapY !== undefined) el = el.gap_y(gapY * SPACE_PX);
    for (const [side, axis, method] of [["Top", "Y", "t"], ["Right", "X", "r"], ["Bottom", "Y", "b"], ["Left", "X", "l"]]) {
      const padding = spaceOf(given[`padding${side}`] ?? given[`padding${axis}`] ?? given.padding);
      const margin = spaceOf(given[`margin${side}`] ?? given[`margin${axis}`] ?? given.margin);
      if (padding !== undefined) el = el[`p${method}`](padding * SPACE_PX);
      if (margin !== undefined) el = el[`m${method}`](margin * SPACE_PX);
    }
    for (const [prop, method, size] of [["width", "w", across], ["height", "h", down], ["minWidth", "min_w", across], ["minHeight", "min_h", down]]) {
      const value = size(given[prop]);
      if (value !== undefined) el = el[method](value);
    }
    if (typeof given.borderStyle === "string") {
      el = el.border_1().border_color(colorOf(given.borderColor, t) ?? t.border).rounded(given.borderStyle === "round" ? 6 : 0);
      if (given.borderStyle === "dashed" || given.borderStyle === "classic") el = el.border_dashed();
      if (given.borderDimColor === true) el = el.opacity(0.6);
    }
    const background = colorOf(given.backgroundColor, t);
    if (background !== undefined) el = el.bg(background);
    if (given.overflow === "hidden") el = el.overflow_hidden();
    const hoverBackground = colorOf(given.hover?.backgroundColor, t);
    if (typeof given.key === "string") el = el.id(`${unit.key}:${given.key}`).when(hoverBackground !== undefined, (e) => e.hover((h) => h.bg(hoverBackground)));
    return el.children(this.nodes(given.children, unit, `${path}.c`, t));
  }

  styled(el, given, t) {
    const color = colorOf(given.color, t);
    const background = colorOf(given.backgroundColor, t);
    if (given.inverse === true) el = el.text_color(background ?? t.background).bg(color ?? t.foreground);
    else {
      if (color !== undefined) el = el.text_color(color);
      else if (given.dimColor === true) el = el.text_color(t.dim);
      if (background !== undefined) el = el.bg(background);
    }
    if (given.bold === true || given.weight === "bold") el = el.font_bold();
    else if (given.weight === "semibold") el = el.font_semibold();
    else if (given.weight === "medium") el = el.font_medium();
    if (given.italic === true) el = el.italic();
    if (given.underline === true) el = el.underline();
    if (given.strikethrough === true) el = el.line_through();
    const size = { caption: 11, footnote: 11, heading: 15, title: 18 }[given.size];
    if (size !== undefined) el = el.text_size(size);
    if (typeof given.wrap === "string" && given.wrap !== "wrap") el = el.truncate();
    return el;
  }

  text(given, unit, path, t) {
    const words = textOf(given.children);
    if (words !== undefined) return this.styled(div().role("label").accessibility_label(words), given, t).child(words);
    return this.styled(h_flex().flex_wrap(), given, t).children(this.nodes(given.children, unit, `${path}.c`, t));
  }

  button(given, unit, path, t) {
    const handler = handlerOf(given.onPress);
    const label = typeof given.label === "string" ? given.label : undefined;
    const words = textOf(given.children);
    const key = typeof given.key === "string" ? given.key : label ?? words ?? path;
    const name = label ?? words ?? key;
    const hotkey = typeof given.hotkey === "string" ? given.hotkey : undefined;
    let el = Button.new(`${unit.key}:${key}`).accessibility_label(name).cursor_pointer().rounded(6);
    el = given.plain === true ? el.text_color(t.accent).hover((h) => h.underline())
      : given.variant === "primary" ? el.px(SPACE_PX * 1.5).py(SPACE_PX / 2).bg(t.solid).text_color(t.solid_foreground)
      : el.px(SPACE_PX * 1.5).py(SPACE_PX / 2).bg(t.raised).border_1().border_color(t.border).hover((h) => h.bg(t.hover));
    if (given.dimColor === true) el = el.opacity(0.6);
    el = el.on_click((_event, cx) => (handler !== undefined ? this.press(unit, handler, { key }, cx) : typeof given.href === "string" ? this.openLink(given.href, cx) : undefined));
    if (words === undefined && given.children !== undefined && !(Array.isArray(given.children) && given.children.length === 0)) return el.child(h_flex().gap(SPACE_PX).children(this.nodes(given.children, unit, `${path}.c`, t)));
    const shown = words ?? label ?? "";
    return el.child(hotkey !== undefined && given.plain === true ? `${hotkey}: ${shown}` : shown);
  }

  link(given, unit, _path, t) {
    const href = typeof given.href === "string" ? given.href : "";
    const shown = textOf(given.children) || (typeof given.label === "string" ? given.label : href);
    return Button.new(`${unit.key}:link:${href}`).accessibility_label(shown).role("link").cursor_pointer().text_color(t.accent).hover((h) => h.underline())
      .on_click((_event, cx) => this.openLink(href, cx)).child(shown);
  }

  code(given, unit, path, t) {
    const field = unit.fields.get(`code:${given.key ?? path}`);
    const source = typeof given.source === "string" ? given.source : "";
    const rows = Math.min(Math.max(source.split("\n").length, 1), CODE_ROWS);
    if (!field) return div().font_family(settings().font_family ?? "JetBrains Mono").text_color(t.muted).child(source);
    return div().id(`${unit.key}:code:${given.key ?? path}`).h(rows * ROW_PX + SPACE_PX * 2).rounded(6).border_1().border_color(t.border).overflow_hidden().child(Editor.new(field.state).size_full());
  }

  markdown(given, unit, path) {
    const handler = handlerOf(given.onLinkPress);
    const pressable = Array.isArray(given.pressableLinks) ? given.pressableLinks : undefined;
    const key = typeof given.key === "string" ? given.key : path;
    let el = TextView.markdown(`${unit.key}:markdown:${key}`, typeof given.text === "string" ? given.text : "").selectable(true)
      .on_link_click((url, cx) => (handler !== undefined && (pressable === undefined || pressable.includes(url)) ? this.press(unit, handler, { key, link: { href: url } }, cx) : this.openLink(url, cx)));
    if (given.dimColor === true) el = el.opacity(0.6);
    return el;
  }

  input(given, unit, _path, t) {
    const field = unit.fields.get(`input:${given.key}`);
    const label = typeof given.label === "string" ? given.label : undefined;
    const name = label ?? (typeof given.placeholder === "string" ? given.placeholder : given.key);
    return v_flex().gap(SPACE_PX / 2)
      .when(label !== undefined, (el) => el.child(div().text_size(11).text_color(t.muted).child(label ?? "")))
      .child(field ? (field.rows > 1 ? Textarea : Input).new(field.state).accessibility_label(name).px(SPACE_PX).py(SPACE_PX / 2).rounded(6).border_1().border_color(t.input) : div().text_color(t.dim).child(typeof given.value === "string" ? given.value : ""));
  }

  select(given, unit, _path, t) {
    const handler = handlerOf(given.onSelect);
    const options = Array.isArray(given.options) ? given.options.filter((option) => typeof option?.value === "string") : [];
    const label = typeof given.label === "string" ? given.label : given.key;
    return v_flex().gap(SPACE_PX / 2)
      .when(typeof given.label === "string", (el) => el.child(div().text_size(11).text_color(t.muted).child(given.label)))
      .child(h_flex().id(`${unit.key}:select:${given.key}`).role("radio_group").accessibility_label(label).flex_wrap().gap(SPACE_PX).children(
        options.map((option, index) => {
          const isSelected = option.value === given.value;
          const shown = typeof option.label === "string" ? option.label : option.value;
          return Button.new(`${unit.key}:${given.key}:${option.value}`).role("radio_button").selected(isSelected).set_position(index + 1, options.length).accessibility_label(shown)
            .px(SPACE_PX).py(SPACE_PX / 2).rounded(6).border_1().cursor_pointer().border_color(isSelected ? t.accent : t.border).when(isSelected, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
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
