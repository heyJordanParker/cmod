export const SURFACE = "herdr";
export const DASHBOARD = "dashboard";
export const UI = "cmod/UI";
export const EVENTS = ["Change", "Redraw", "Open", "Close"];
export const KEPT_SESSIONS = 12;
export const QUIET_LOADING_MS = 400;
const RETRY_MS = [500, 1000, 2000, 5000, 10000];

export const keyOf = ({ mod, id }) => `${mod}/${id}`;

export function init({ show = "views", area = DASHBOARD, page = null, session = null, client, isWindow = false, now = 0 }) {
  return {
    show,
    area,
    page,
    client,
    isWindow,
    isHost: show === "views",
    connection: { status: "connecting", attempt: 0, error: null },
    target: show === "page" ? session : null,
    sessions: {},
    recent: [],
    tab: null,
    columns: 40,
    request: 0,
    told: { session: null, parts: [] },
    now,
  };
}

const wantedLists = (model) => (model.show === "views" ? ["views", "pages"] : model.show === "widgets" ? ["widgets"] : []);

const emptyEntry = (now) => ({ lists: null, pending: {}, refusal: null, parts: {}, since: now });

export const entryOf = (model, session) => (session === null ? undefined : model.sessions[session]);

export function shownView(model, entry = entryOf(model, model.target)) {
  const views = entry?.lists?.views ?? [];
  return views.find((view) => keyOf(view) === model.tab) ?? views[0];
}

export function shownParts(model, session = model.target) {
  if (session === null) return [];
  if (model.show === "page") return model.page === null ? [] : [model.page];
  const entry = entryOf(model, session);
  if (entry === undefined || entry.lists === null) return [];
  if (model.show === "widgets") return (entry.lists.widgets ?? []).filter((widget) => widget.areas.includes(model.area));
  return entry.lists.views ?? [];
}

export function screen(model) {
  const entry = entryOf(model, model.target);
  const isLive = model.connection.status === "open";
  const problem = isLive ? null : model.connection.error;
  if (model.target === null) return { kind: model.show === "page" ? "noPage" : "noSession", problem };
  if (entry === undefined || (entry.lists === null && model.show !== "page")) {
    if (entry?.refusal != null) return { kind: "refused", message: entry.refusal, problem };
    if (!isLive && model.connection.attempt > 0) return { kind: "unreached", message: model.connection.error, problem: null };
    return { kind: "loading", isQuiet: model.now - (entry?.since ?? model.now) < QUIET_LOADING_MS, problem };
  }
  const withDrawn = (part) => ({ ...part, key: keyOf(part), drawn: entry.parts[keyOf(part)] ?? null });
  const shown = model.show === "views" ? shownView(model, entry) : undefined;
  const all = shownParts(model).map(withDrawn);
  const parts = model.show === "views" ? all.filter((part) => shown !== undefined && part.key === keyOf(shown)) : all;
  return { kind: "ready", views: entry.lists?.views ?? [], pages: entry.lists?.pages ?? [], shown, parts, all, problem: problem ?? entry.refusal };
}

const withEntry = (model, session, change) => {
  const entry = model.sessions[session] ?? emptyEntry(model.now);
  return { ...model, sessions: { ...model.sessions, [session]: change(entry) } };
};

const nextRequest = (model) => [{ ...model, request: model.request + 1 }, model.request + 1];

const call = (method, params, ok, failed) => ({ type: "call", method, params, ok, failed });

function listing(model, session) {
  let next = model;
  const effects = [];
  for (const part of wantedLists(model)) {
    let request;
    [next, request] = nextRequest(next);
    next = withEntry(next, session, (entry) => ({ ...entry, pending: { ...entry.pending, [part]: request } }));
    effects.push(call(`${UI}.${part}`, [session], { type: "listed", session, part, request }, { type: "listFailed", session, part, request }));
  }
  return [next, effects];
}

function drawing(model, session, parts) {
  let next = model;
  const effects = [];
  for (const part of parts) {
    const key = keyOf(part);
    if (entryOf(next, session)?.parts[key]?.request != null) {
      next = withEntry(next, session, (entry) => ({ ...entry, parts: { ...entry.parts, [key]: { ...entry.parts[key], isStale: true } } }));
      continue;
    }
    let request;
    [next, request] = nextRequest(next);
    const area = part.areas === undefined ? {} : { area: model.area };
    next = withEntry(next, session, (entry) => ({ ...entry, parts: { ...entry.parts, [key]: { tree: null, error: null, ...entry.parts[key], part, request, isStale: false } } }));
    effects.push(call(`${UI}.draw`, [session, { mod: part.mod, id: part.id }, { columns: model.columns, surface: SURFACE, ...area }], { type: "drew", session, key, request }, { type: "drawFailed", session, key, request }));
  }
  return [next, effects];
}

function refreshed(model, session) {
  if (session === null || model.connection.status !== "open") return [model, []];
  if (model.show === "page") return drawing(model, session, shownParts(model, session));
  return listing(model, session);
}

function telling(model, isRenewal = false) {
  if (model.show === "widgets" || model.connection.status !== "open") return [model, []];
  const session = model.target;
  const parts = shownParts(model).map(keyOf);
  const host = model.isHost ? [{ isHost: true }] : [];
  const before = model.told;
  const isSame = before.session === session && before.parts.join(" ") === parts.join(" ");
  if (isSame && !(isRenewal && session !== null)) return [model, []];
  const effects = [];
  if (before.session !== null && before.session !== session) effects.push(call(`${UI}.show`, [before.session, model.client, []], null, null));
  if (session !== null) effects.push(call(`${UI}.show`, [session, model.client, parts.map((key) => ({ mod: key.slice(0, key.indexOf("/")), id: key.slice(key.indexOf("/") + 1) })), ...host], null, { type: "showFailed", session }));
  return [{ ...model, told: { session, parts } }, effects];
}

const remembered = (model, session) => {
  const recent = [session, ...model.recent.filter((each) => each !== session)];
  const kept = recent.slice(0, KEPT_SESSIONS);
  const sessions = Object.fromEntries(Object.entries(model.sessions).filter(([id]) => kept.includes(id) || id === model.target));
  return { ...model, recent: kept, sessions };
};

const then = (model, ...steps) => {
  let next = model;
  const effects = [];
  for (const step of steps) {
    const [stepped, more] = step(next);
    next = stepped;
    effects.push(...more);
  }
  return [next, effects];
};

const drawShown = (session) => (model) => drawing(model, session, shownParts(model, session));
const drawUndrawn = (session) => (model) =>
  drawing(
    model,
    session,
    shownParts(model, session).filter((part) => {
      const drawn = entryOf(model, session)?.parts[keyOf(part)];
      return drawn === undefined || drawn.isStale === true;
    }),
  );

export function update(model, message) {
  const at = { ...model, now: message.now ?? model.now };
  switch (message.type) {
    case "connect":
      return [{ ...at, connection: { ...at.connection, status: "connecting" } }, [{ type: "connect" }]];
    case "connected": {
      const open = { ...at, connection: { status: "open", attempt: 0, error: null }, told: { session: null, parts: [] } };
      const listen = EVENTS.map((event) => call("$/listen", { id: event, interface: UI, event, kind: "on" }, null, null));
      const [next, effects] = then(open, (each) => refreshed(each, each.target), telling);
      return [next, [...listen, ...effects]];
    }
    case "disconnected": {
      const attempt = at.connection.attempt + 1;
      return [{ ...at, connection: { status: "closed", attempt, error: message.error } }, [{ type: "connectAfter", ms: RETRY_MS[Math.min(attempt - 1, RETRY_MS.length - 1)] }]];
    }
    case "focused": {
      const session = message.session;
      if (session === null || session === at.target) return [at, []];
      const focused = remembered({ ...withEntry(at, session, (entry) => entry), target: session }, session);
      return then(focused, (each) => refreshed(each, session), telling);
    }
    case "listed": {
      const entry = entryOf(at, message.session);
      if (entry?.pending[message.part] !== message.request) return [at, []];
      const { [message.part]: _done, ...pending } = entry.pending;
      const lists = { views: [], pages: [], widgets: [], ...entry.lists, [message.part]: message.result ?? [] };
      const listed = withEntry(at, message.session, (each) => ({ ...each, lists, pending, refusal: null }));
      if (Object.keys(pending).length > 0) return [listed, []];
      const steps = [drawShown(message.session)];
      if (message.session === at.target) steps.push(telling);
      return then(listed, ...steps);
    }
    case "listFailed": {
      const entry = entryOf(at, message.session);
      if (entry?.pending[message.part] !== message.request) return [at, []];
      const { [message.part]: _done, ...pending } = entry.pending;
      return [withEntry(at, message.session, (each) => ({ ...each, pending, refusal: message.error })), []];
    }
    case "drew":
    case "drawFailed": {
      const drawn = entryOf(at, message.session)?.parts[message.key];
      if (drawn?.request !== message.request) return [at, []];
      const settled = message.type === "drew" ? { ...drawn, tree: message.result, error: null, request: null } : { ...drawn, error: message.error, request: null };
      const landed = withEntry(at, message.session, (entry) => ({ ...entry, parts: { ...entry.parts, [message.key]: settled } }));
      return drawn.isStale && drawn.part !== undefined ? drawing(landed, message.session, [drawn.part]) : [landed, []];
    }
    case "pressFailed":
      return [withEntry(at, message.session, (entry) => ({ ...entry, parts: { ...entry.parts, [message.key]: { tree: null, request: null, ...entry.parts[message.key], error: message.error } } })), []];
    case "showFailed":
      return message.session === at.target ? [withEntry(at, message.session, (entry) => ({ ...entry, refusal: entry.lists === null ? message.error : entry.refusal })), []] : [at, []];
    case "heard":
      return heard(at, message.event, message.payload ?? {});
    case "select": {
      if (message.key === at.tab) return [at, []];
      return then({ ...at, tab: message.key }, drawUndrawn(at.target), telling);
    }
    case "resized": {
      if (message.columns === at.columns) return [at, []];
      return [{ ...at, columns: message.columns }, []];
    }
    case "redrawShown":
      return at.target === null || at.connection.status !== "open" ? [at, []] : drawShown(at.target)(at);
    case "press":
      return [at, [call(`${UI}.press`, [message.session, message.handler, { surface: SURFACE, ...message.input }], null, { type: "pressFailed", session: message.session, key: message.key })]];
    case "renew":
      return telling(at, true);
    case "retry":
      if (at.target === null) return [at, []];
      return refreshed(withEntry(at, at.target, (entry) => ({ ...entry, refusal: null, since: at.now })), at.target);
    case "tick":
      return [at, []];
    default:
      throw new Error(`The cmod panel has no message ${message.type}.`);
  }
}

function heard(model, event, payload) {
  const session = payload.session;
  if (typeof session !== "string") return [model, []];
  const entry = entryOf(model, session);
  if (event === "Change") {
    if (entry === undefined && session !== model.target) return [model, []];
    if (!wantedLists(model).includes(payload.part)) return [model, []];
    return refreshed(model, session);
  }
  if (entry === undefined) return [model, []];
  const key = keyOf(payload);
  if (event === "Redraw") {
    const isShown = shownParts(model, session).some((part) => keyOf(part) === key);
    if (isShown) return drawing(model, session, shownParts(model, session).filter((part) => keyOf(part) === key));
    if (entry.parts[key] === undefined) return [model, []];
    return [withEntry(model, session, (each) => ({ ...each, parts: { ...each.parts, [key]: { ...each.parts[key], isStale: true } } })), []];
  }
  if (model.show !== "views" || session !== model.target) return [model, []];
  const page = entry.lists?.pages.find((each) => keyOf(each) === key);
  if (event === "Close") {
    if (shownView(model, entry) !== undefined && keyOf(shownView(model, entry)) === key) return then({ ...model, tab: null }, drawUndrawn(session), telling);
    return [model, [{ type: "closePage", key }]];
  }
  if (page !== undefined) return [model, [{ type: "openPage", session, page }]];
  if (!(entry.lists?.views ?? []).some((view) => keyOf(view) === key)) return [model, []];
  const reveal = payload.isAsked === true && model.isHost && !model.isWindow ? [{ type: "reveal" }] : [];
  const [next, effects] = then({ ...model, tab: key }, drawUndrawn(session), telling);
  return [next, [...reveal, ...effects]];
}
