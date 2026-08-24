/* Brain visualiser.
 *
 * Reads data.json (produced by scripts/build_site.py from the wiki's own
 * markdown) and renders it. There is no server, no framework and no state
 * that outlives a reload — everything on screen comes from the repo.
 */

(() => {
  "use strict";

  const REFRESH_MS = 60000;
  const state = {
    graph: { hidden: new Set(), pan: { x: 0, y: 0 }, zoom: 1, alpha: 1, running: false,
             raf: null, data: null, hover: null, focus: null, dragging: null },
    data: null,
    byId: new Map(),      // "type:id" -> entity
    records: [],          // updates + decisions + learnings, newest first
    updatesByTeam: new Map(),
    filters: { ideaArea: null, ideaStatus: null, teamStatus: null, activityKind: null },
  };

  /* ---------------- small helpers ---------------- */

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const $ = (sel) => document.querySelector(sel);
  const titleCase = (s) => String(s ?? "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const key = (type, id) => `${type}:${id}`;
  const get = (type, id) => state.byId.get(key(type, id));
  const isRetired = (type, id) => Boolean(get(type, id)?.fm?.deprecated);

  const listOf = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0]).join("").toUpperCase();
  }

  function entityName(type, id) {
    const e = get(type, id);
    return e ? e.title : titleCase(String(id).split("/").pop());
  }

  function fmtDate(value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d)) return String(value);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function relTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d)) return String(value);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    // Entity dates are days, not timestamps: a same-day or dated-ahead record
    // should read as its date rather than as "just now".
    if (mins < 1) return mins < -1 ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function link(type, id, text, cls) {
    return `<a href="#/${type}/${encodeURI(id)}"${cls ? ` class="${cls}"` : ""}>${esc(text ?? entityName(type, id))}</a>`;
  }

  /* A value's colour comes from where it sits in its own vocabulary, so a
     brain with vocabularies this page has never seen still gets stable,
     distinguishable pills. No value names appear here. */
  const TONES = ["accent", "good", "warm", "alt", "bad", "quiet"];

  function toneFor(value) {
    if (!value) return "";
    for (const values of Object.values(state.data.vocabularies || {})) {
      const at = (values || []).indexOf(value);
      if (at !== -1) return TONES[at % TONES.length];
    }
    return "";
  }
  const pill = (value, tone, field) =>
    value
      ? `<span class="pill ${tone || toneFor(value)}"${
          field ? ` title="${esc(titleCase(field))}"` : ""
        }>${esc(titleCase(value))}</span>`
      : "";

  /* ---------------- indexing ---------------- */

  const meta = (type) => (state.data.entity_meta || {})[type] || {};
  const fieldsOf = (type) => meta(type).fields || {};
  const spec = (type, field) => fieldsOf(type)[field] || {};
  /* Entity types you browse, and the ones that are records in a log. Both come
     from `layout` in SCHEMA.yml, so a new entity type gets a tab by itself. */
  const listTypes = () => {
    const flat = (state.data.entity_order || []).filter((t) => meta(t).list_view);
    /* The type records are filed against leads: it is what the event is
       organised around, and it read oddly buried behind the others. Derived
       from the record types' parent, never named. */
    const parent = (state.data.entity_order || [])
      .filter((t) => !meta(t).list_view)
      .map((t) => meta(t).parent_type)
      .find((t) => t && flat.includes(t));
    return parent ? [parent, ...flat.filter((t) => t !== parent)] : flat;
  };
  const recordTypes = () => (state.data.entity_order || []).filter((t) => !meta(t).list_view);
  const folderOf = (type) => (state.data.entity_folders || {})[type] || type;
  const typeOfFolder = (folder) =>
    Object.keys(state.data.entity_folders || {}).find((t) => folderOf(t) === folder);
  const dateFieldOf = (type) => meta(type).date_field;
  const actorFieldOf = (type) => meta(type).actor_field;
  const recordDate = (e) =>
    e.fm[dateFieldOf(e.type)] || e.fm.date || e.fm.last_updated || "";
  const edges = (type, id, dir) =>
    ((state.data.graph || {})[`${type}:${id}`] || {})[dir] || [];
  /* A renamed entity leaves a tombstone so old links still resolve. It is not
     a thing to list or count — it is a redirect. Reachable by URL, absent from
     every list. */
  const all = (type) =>
    ((state.data.entities || {})[type] || []).filter((e) => !e.fm.deprecated);
  const allIncludingRetired = (type) => (state.data.entities || {})[type] || [];

  function index(data) {
    state.byId.clear();
    state.updatesByTeam.clear();
    for (const [type, list] of Object.entries(data.entities || {})) {
      for (const e of list) state.byId.set(key(type, e.id), e);
    }
    const records = [];
    for (const type of recordTypes()) {
      for (const e of data.entities[type] || []) {
        const date = e.fm[data.entity_meta[type].date_field] || e.fm.date || e.fm.last_updated || "";
        records.push({ ...e, date });
        const team = e.fm[data.entity_meta[type].parent_field];
        if (team) {
          if (!state.updatesByTeam.has(team)) state.updatesByTeam.set(team, []);
          state.updatesByTeam.get(team).push({ ...e, date });
        }
      }
    }
    records.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    for (const list of state.updatesByTeam.values()) {
      list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    }
    state.records = records;
  }

  const is_blank_value = (v) =>
    v == null || v === "" || (Array.isArray(v) && !v.length);

  /* One colour per vocabulary value, taken from its position in the vocabulary
     so an unfamiliar brain still gets a stable, distinguishable palette. */
  const SEGMENT_VARS = ["--accent", "--good", "--warm", "--accent-2", "--bad", "--line"];
  const colorFor = (vocab, value) => {
    const at = (state.data.vocabularies[vocab] || []).indexOf(value);
    return at === -1 ? "var(--line)" : `var(${SEGMENT_VARS[at % SEGMENT_VARS.length]})`;
  };

  function stackedHtml(dist) {
    const total = Math.max(1, [...dist.counts.values()].reduce((a, b) => a + b, 0) + dist.blank);
    const present = dist.order.filter((v) => dist.counts.get(v));
    const segments = present
      .map(
        (v) =>
          `<span style="width:${((dist.counts.get(v) || 0) / total) * 100}%;background:${colorFor(
            dist.vocab,
            v
          )}" title="${esc(titleCase(v))}: ${dist.counts.get(v)}"></span>`
      )
      .join("");
    const legend = present
      .map(
        (v) =>
          `<span><i style="background:${colorFor(dist.vocab, v)}"></i>${esc(titleCase(v))} · ${dist.counts.get(
            v
          )}</span>`
      )
      .join("");
    const blankBit = dist.blank
      ? `<span><i style="background:var(--line)"></i>Not said · ${dist.blank}</span>`
      : "";
    return `<div class="card-sub" style="margin-bottom:10px">${esc(
      `${titleCase(dist.type)} ${titleCase(dist.field).toLowerCase()}`
    )}</div>
      <div class="stack">${segments}${
      dist.blank ? `<span style="width:${(dist.blank / total) * 100}%;background:var(--line)"></span>` : ""
    }</div>
      <div class="legend">${legend}${blankBit}</div>`;
  }

  const countBy = (items, fn) => {
    const map = new Map();
    for (const item of items) {
      for (const value of listOf(fn(item))) {
        if (value == null || value === "") continue;
        map.set(value, (map.get(value) || 0) + 1);
      }
    }
    return map;
  };

  /* ---------------- shared fragments ---------------- */

  function barsHtml(counts, order, cls) {
    const entries = order
      ? order.map((k) => [k, counts.get(k) || 0]).filter(([, n]) => n > 0)
      : [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!entries.length) return `<div class="empty-note">Nothing recorded yet.</div>`;
    const max = Math.max(...entries.map(([, n]) => n));
    return `<div class="bars">${entries
      .map(
        ([k, n]) => `<div class="bar-row">
          <span class="label" title="${esc(titleCase(k))}">${esc(titleCase(k))}</span>
          <span class="bar-track"><span class="bar-fill ${cls || ""}" style="width:${(n / max) * 100}%"></span></span>
          <span class="n">${n}</span>
        </div>`
      )
      .join("")}</div>`;
  }

  /* ---------------- view: pulse ---------------- */

  function viewPulse() {
    /* Which flat type records are filed against — the thing the event is
       organised around. Derived from the record types' parent, not assumed. */
    const parentType = recordTypes().map((rt) => meta(rt).parent_type).find(Boolean) || listTypes()[0];

    /* Every vocabulary field on a browsable type is a distribution worth
       charting, and the vocabulary's own order is the order to chart it in.
       This replaced three hand-written charts, each of which named a field. */
    function distributions(type, limit) {
      return Object.entries(fieldsOf(type))
        .filter(([, fs]) => fs.vocab && (state.data.vocabularies[fs.vocab] || []).length)
        .map(([field, fs]) => ({
          type,
          field,
          vocab: fs.vocab,
          multi: Boolean(fs.list),
          order: state.data.vocabularies[fs.vocab],
          counts: countBy(all(type), (x) => x.fm[field]),
          blank: all(type).filter((x) => is_blank_value(x.fm[field])).length,
        }))
        .filter((d) => [...d.counts.values()].some(Boolean))
        .slice(0, limit);
    }

    /* A long ordered vocabulary is a progression, so it reads better as a rail
       than as bars. Length is the only signal used — no value is recognised. */
    const RAIL_MIN = 8;
    const parentDists = distributions(parentType, 6);
    const rail = parentDists.find((d) => d.order.length >= RAIL_MIN);
    /* A field holding exactly one value per entity partitions the collection,
       so it reads as one stacked bar with a legend — including the entities
       nobody has recorded a value for. A multi-valued field does not partition
       anything, so it reads as bars. Structural, not semantic. */
    const stacked = parentDists.find((d) => d !== rail && !d.multi);
    /* Never chart one vocabulary twice. `stages_completed` draws from the same
       vocabulary as the stage rail, so charting both said the same thing twice
       and crowded out the distribution from another type. */
    const charted = new Set([rail, stacked].filter(Boolean).map((d) => d.vocab));
    const barDists = listTypes()
      .filter((x) => x !== parentType)
      .flatMap((x) => distributions(x, 2))
      .concat(parentDists.filter((d) => d !== rail && d !== stacked))
      .filter((d) => !charted.has(d.vocab) && (charted.add(d.vocab), true))
      .slice(0, stacked ? 1 : 2);

    const silent = all(parentType).filter((x) => !inboundRecords(x).length);

    return `
      <div class="stats">
        ${[...listTypes(), ...recordTypes()]
          .map((type, at) => {
            const items = all(type);
            if (!items.length) return "";
            /* Sub-line, without naming a single field: for a browsable type,
               how many have records pointing at them; for a record type, how
               many distinct things it covers. */
            /* Records attach to one type; every other browsable type connects
               through it. So the honest sub-line differs by role: for that type,
               how many have been reported on; for the rest, how many reach it.
               Saying "0 with records" about people read as a gap when it is
               simply not how people connect. */
            const anchor = recordTypes().map((rt) => meta(rt).parent_type).find(Boolean);
            let sub;
            if (!meta(type).list_view) {
              sub = `across ${
                new Set(items.map((e) => e.fm[meta(type).parent_field]).filter(Boolean)).size
              } ${folderOf(meta(type).parent_type || "")}`;
            } else if (type === anchor) {
              sub = `${items.filter((e) => inboundRecords(e).length).length} with records logged`;
            } else {
              /* Whichever browsable type most of these actually connect to —
                 people reach the work through teams, ideas through projects.
                 Naming one type for all of them said "0 linked to a project"
                 about 55 people, which is not a gap but the wrong question. */
              const tally = new Map();
              for (const e of items)
                for (const x of edges(e.type, e.id, "in"))
                  if (meta(x.type).list_view && x.type !== type)
                    tally.set(x.type, (tally.get(x.type) || 0) + 1);
              /* Prefer the type the work itself hangs off: 20 ideas have a
                 proposer and 10 have a project, and the interesting number is
                 how many are being built. */
              const via = tally.has(anchor)
                ? anchor
                : [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
              const n = via
                ? items.filter((e) => edges(e.type, e.id, "in").some((x) => x.type === via)).length
                : 0;
              sub = via ? `${n} linked to a ${via}` : `${items.length} recorded`;
            }
            return stat(items.length, titleCase(folderOf(type)), sub, TONES[at % TONES.length], routeForType(type));
          })
          .join("")}
      </div>

      ${stacked || barDists.length ? `
      <div class="section-head"><h2>Where the ${esc(folderOf(parentType))} are</h2>
        ${stacked ? `<span class="note">${all(parentType).length - stacked.blank} of ${all(parentType).length} have said</span>` : ""}</div>
      <div class="grid cols-2 top">
        ${stacked ? `<div class="card">${stackedHtml(stacked)}</div>` : ""}
        ${barDists
          .map(
            (d) => `<div class="card">
              <div class="card-sub" style="margin-bottom:10px">${esc(titleCase(folderOf(d.type)))} by ${esc(
              titleCase(d.field).toLowerCase()
            )}</div>
              ${barsHtml(d.counts, d.order.filter((v) => d.counts.get(v)), "alt")}
            </div>`
          )
          .join("")}
      </div>` : ""}

      ${rail ? `
      <div class="section-head"><h2>${esc(titleCase(rail.field))} reached</h2>
        <span class="note">${esc(folderOf(rail.type))} at each value — blanks are expected</span></div>
      <div class="card">
        <div class="rail">${rail.order
          .map((v) => {
            const n = rail.counts.get(v) || 0;
            const max = Math.max(1, ...rail.counts.values());
            return `<div class="rail-step ${n ? "on" : "dim"}" title="${esc(titleCase(v))}: ${n}">
              <div class="rail-bar"><span style="height:${n ? Math.max(12, (n / max) * 100) : 3}%"></span></div>
              <div class="rail-label">${esc(titleCase(v))}</div>
            </div>`;
          })
          .join("")}</div>
      </div>` : ""}

      <div class="grid cols-2 top" style="margin-top:14px">
        <div>
          <div class="section-head"><h2>Latest activity</h2>
            <a class="note" href="#/activity">all activity →</a></div>
          <div class="card">${feedHtml(state.records.slice(0, 8))}</div>
        </div>
        <div>
          <div class="section-head"><h2>Pushes to the brain</h2>
            <span class="note">${state.data.commits.length} commits</span></div>
          <div class="card">
            ${sparkHtml(state.data.commits)}
            <div style="margin-top:14px">${state.data.commits
              .slice(0, 6)
              .map(
                (c) => `<div class="commit-line">
                  <span class="sha">${esc(c.sha)}</span>
                  <span>${esc(c.subject)}</span>
                  <span class="who">${esc(c.author)} · ${esc(relTime(c.date))}</span>
                </div>`
              )
              .join("")}</div>
          </div>
        </div>
      </div>

      ${silent.length ? `
      <div class="section-head"><h2>Nothing logged yet</h2>
        <span class="note">no activity recorded against these yet</span></div>
      <div class="grid cols-4">${silent.map(entityCard).join("")}</div>` : ""}
    `;
  }

  /* A count is an aggregate over a collection, so it should take you to that
     collection. These were plain divs, which is why nothing on the pulse page
     led anywhere: the card knew the number but had thrown away what it counted. */
  const stat = (n, k, sub, tone, href) => {
    const inner = `<div class="n">${n}</div><div class="k">${esc(k)}</div>${
      sub ? `<div class="sub">${esc(sub)}</div>` : ""
    }`;
    return href
      ? `<a class="stat linked ${tone || ""}" href="${esc(href)}">${inner}</a>`
      : `<div class="stat ${tone || ""}">${inner}</div>`;
  };

  /* Where a type's collection lives: its own tab if it has one, the activity
     feed filtered to it otherwise. Both routes are derived from the schema. */
  const routeForType = (type) =>
    meta(type).list_view ? `#/${folderOf(type)}` : `#/activity/${type}`;

  function sparkHtml(commits) {
    if (!commits.length) return "";
    const buckets = new Map();
    const now = new Date();
    const hours = 24;
    for (let h = hours - 1; h >= 0; h--) {
      const d = new Date(now.getTime() - h * 3600000);
      buckets.set(`${d.toISOString().slice(0, 13)}`, 0);
    }
    for (const c of commits) {
      const k = new Date(c.date).toISOString().slice(0, 13);
      if (buckets.has(k)) buckets.set(k, buckets.get(k) + 1);
    }
    const values = [...buckets.values()];
    const max = Math.max(1, ...values);
    return `<div class="spark">${values
      .map((v) => `<span style="height:${(v / max) * 100}%" title="${v} commit${v === 1 ? "" : "s"}"></span>`)
      .join("")}</div>
      <div class="spark-axis"><span>24h ago</span><span>now</span></div>`;
  }

  /* ---------------- generic entity cards and lists ----------------

     One renderer for every entity type, driven by the field specs the builder
     took from SCHEMA.yml. It shows: the title, whatever vocabulary values the
     entity carries, every reference it declares as a link, a blurb from its
     longest prose field, and how many records point at it.

     This replaced one hand-written view per entity type. Those views were the
     reason relationships went missing from the page: an edge nobody had thought
     to write code for was invisible even though the data held it, and adding an
     entity type to the schema produced a page that ignored it. -------------- */

  const REF_TEXT_SKIP = new Set(["slug", "title", "name", "current_summary"]);

  const hasIcon = (type) => meta(type).display?.icon === "initials";

  function icon(entity) {
    return hasIcon(entity.type)
      ? `<span class="avatar lg">${esc(initials(entity.title))}</span>`
      : "";
  }

  /* Neighbours of a type that represents itself as an avatar render as a stack
     rather than as text. Driven by the `display` hint on that type, so it is a
     property of the model: a brain that puts the hint on a different entity
     type gets stacks there instead. */
  function avatarStack(groups, max = 7) {
    const people = groups.filter((g) => hasIcon(g.items[0]?.type)).flatMap((g) => g.items);
    if (!people.length) return "";
    const shown = people.slice(0, max);
    const rest = people.length - shown.length;
    return `<span class="avatars">${shown
      .map((e) => `<span class="avatar" title="${esc(entityName(e.type, e.id))}">${esc(
        initials(entityName(e.type, e.id))
      )}</span>`)
      .join("")}${rest > 0 ? `<span class="avatar more">+${rest}</span>` : ""}</span>`;
  }

  /* Vocabulary-valued fields. Fields the schema computes come first: a derived
     value is the entity's current state, which is what a card should lead with.
     Everything else follows in schema order. */
  function vocabFields(type) {
    const entries = Object.entries(fieldsOf(type)).filter(([, fs]) => fs.vocab);
    const rank = ([, fs]) =>
      /* Derived single values first — a computed state is the headline. Then
         other single values. Multi-valued fields are tag sets, not states, so
         they follow. Bookkeeping ("how this entry came to exist") comes last:
         it outranked real status on every team that had not reported one. */
      (fs.bookkeeping ? 4 : 0) + (fs.list ? 2 : 0) + (fs.generated ? 0 : 1);
    return entries.sort((a, b) => rank(a) - rank(b));
  }

  /* Returns a LIST. It used to return joined HTML, and the card then sliced
     that string by the length of another one to get "the rest" — which cut
     through a tag and shattered the card's DOM. */
  function vocabPillList(entity, max = 3, { bookkeeping = false } = {}) {
    const out = [];
    for (const [field, fs] of vocabFields(entity.type)) {
      if (out.length >= max) break;
      /* How an entry came to exist is not its state. It stays in the facts
         panel, where provenance belongs, rather than headlining a card. */
      if (fs.bookkeeping && !bookkeeping) continue;
      for (const value of listOf(entity.fm[field])) {
        /* The field name as a tooltip: a bare "Yes" pill from `reversible` says
           nothing on its own. */
        if (value) out.push(pill(value, null, field));
        if (out.length >= max) break;
      }
    }
    return out;
  }

  const vocabPills = (entity, max = 3) => vocabPillList(entity, max).join("");

  /* Every reference the entity declares, as links. `skip` holds the fields the
     subtitle already spelled out, so a card does not say the same thing twice. */
  function refChips(entity, max = 6, skip = new Set()) {
    const chips = [];
    for (const group of neighbourGroups(entity)) {
      if (skip.has(group.label) || hasIcon(group.items[0]?.type)) continue;
      for (const e of group.items) {
        if (chips.length >= max) break;
        chips.push(link(e.type, e.id, entityName(e.type, e.id), "chip-link"));
      }
    }
    return chips.join("");
  }

  function blurb(entity, limit = 150) {
    let best = "";
    for (const [field, fs] of Object.entries(fieldsOf(entity.type))) {
      if (fs.ref_type || fs.vocab || fs.type === "date") continue;
      if (field === entity.title_field) continue;   // already the heading
      const value = entity.fm[field];
      if (typeof value !== "string" || REF_TEXT_SKIP.has(field)) continue;
      /* A card body is prose. An address, a URL or an identifier has no
         whitespace in it, and reading somebody's email as their summary was
         both ugly and the wrong kind of thing to put on a card. */
      if (!/\s/.test(value.trim())) continue;
      if (value.length > best.length) best = value;
    }
    return best ? esc(best.slice(0, limit)) + (best.length > limit ? "…" : "") : "";
  }

  const inboundRecords = (entity) =>
    edges(entity.type, entity.id, "in").filter((e) => !meta(e.type).list_view);

  function entityCard(entity) {
    const records = inboundRecords(entity).length;
    const ico = icon(entity);
    const sub = subtitleParts(entity);
    const groups = neighbourGroups(entity);
    const stack = avatarStack(groups);
    return `<div class="card card-link" data-href="#/${entity.type}/${encodeURI(entity.id)}" role="link" tabindex="0">
      <div class="card-head">
        <div class="card-ident">
          ${ico}
          <div style="min-width:0">
            <h3 class="card-title">${esc(entity.title)}</h3>
            ${sub.text ? `<div class="card-sub">${sub.text}</div>` : ""}
          </div>
        </div>
        ${vocabPills(entity, 1)}
      </div>
      ${blurb(entity) ? `<div class="card-body">${blurb(entity)}</div>` : ""}
      <div class="card-foot">
        ${stack}
        ${vocabPillList(entity, 3).slice(1).join("")}
        ${refChips(entity, 3, sub.used)}
        ${records ? `<span class="pill quiet">${records} record${records === 1 ? "" : "s"}</span>` : ""}
      </div>
    </div>`;
  }

  /* A one-line "who or what this belongs to": its first two reference fields,
     and the set of fields it used, so the footer can skip them. */
  /* Both directions, grouped: outbound by the field that declares it, inbound
     by the type it comes from. Reading only outbound fields is what left a
     person's team off their card. */
  function neighbourGroups(entity) {
    const groups = [];
    const seen = new Set();
    const push = (label, field, e) => {
      if (seen.has(`${e.type}:${e.id}`) || !meta(e.type).list_view) return;
      if (isRetired(e.type, e.id)) return;
      seen.add(`${e.type}:${e.id}`);
      let group = groups.find((g) => g.label === label);
      if (!group) groups.push((group = { label, field, items: [] }));
      group.items.push(e);
    };
    for (const e of edges(entity.type, entity.id, "out")) push(titleCase(e.field), e.field, e);
    for (const e of edges(entity.type, entity.id, "in")) push(titleCase(folderOf(e.type)), null, e);
    return groups;
  }

  function subtitleParts(entity) {
    const parts = [];
    const used = new Set();
    /* Groups shown as avatars are not repeated as text. */
    const textual = neighbourGroups(entity).filter((g) => !hasIcon(g.items[0]?.type));
    for (const group of textual.slice(0, 2)) {
      const names = group.items.slice(0, 2).map((e) => entityName(e.type, e.id));
      const more = group.items.length - names.length;
      parts.push(`${group.label}: ${esc(names.join(", "))}${more > 0 ? ` +${more}` : ""}`);
      used.add(group.label);
    }
    return { text: parts.join(" · "), used };
  }
  const subtitle = (entity) => subtitleParts(entity).text;

  /* Filters come from the entity's own fields: vocabulary values, and now
     references too. Filtering records by the project or the idea they belong to
     was impossible while only vocabularies produced chips. */
  function filterableFields(type) {
    const vocabs = Object.entries(fieldsOf(type))
      .filter(([, fs]) => fs.vocab && !fs.bookkeeping && (state.data.vocabularies[fs.vocab] || []).length)
      .map(([field, fs]) => ({ field, kind: "vocab", vocab: fs.vocab }));
    const refs = Object.entries(fieldsOf(type))
      .filter(([, fs]) => fs.ref_type && !fs.generated && meta(fs.ref_type).list_view)
      .map(([field, fs]) => ({ field, kind: "ref", refType: fs.ref_type }));
    return [...refs, ...vocabs].slice(0, 3);
  }

  /* The values a field actually takes across a set, with a label for each. */
  function filterValues(items, f) {
    const seen = new Map();
    for (const item of items) {
      for (const value of listOf(item.fm[f.field])) {
        if (!value || typeof value !== "string") continue;
        if (!seen.has(value))
          seen.set(value, f.kind === "ref" ? entityName(f.refType, value) : titleCase(value));
      }
    }
    if (f.kind === "vocab") {
      const order = state.data.vocabularies[f.vocab] || [];
      return [...seen].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }

  function chipRow(items, f, key) {
    const active = state.filters[key] || "";
    const values = filterValues(items, f);
    if (values.length < 2) return "";
    return `<div class="chips">
      <button class="chip ${!active ? "on" : ""}" data-filter="${esc(key)}" data-value="">All ${esc(
      titleCase(f.field).toLowerCase()
    )}</button>
      ${values
        .map(
          ([value, label]) =>
            `<button class="chip ${active === value ? "on" : ""}" data-filter="${esc(
              key
            )}" data-value="${esc(value)}">${esc(label)}</button>`
        )
        .join("")}</div>`;
  }

  function viewList(type) {
    let shown = [...all(type)].sort((a, b) => a.title.localeCompare(b.title));
    const chipRows = filterableFields(type).map((f) => {
      const key = `${type}.${f.field}`;
      const row = chipRow(all(type), f, key);
      const active = state.filters[key];
      if (active) shown = shown.filter((x) => listOf(x.fm[f.field]).includes(active));
      return row;
    });
    /* Column width follows the content, not the count: a type whose entities
       carry prose needs room to read it, one that is just a name and some
       references does not. */
    const hasProse = all(type).some((e) => blurb(e, 80));
    const cols = hasProse ? "cols-3" : "cols-4";
    return `${chipRows.join("")}
      <div class="section-head"><h2>${shown.length} ${esc(
      shown.length === 1 ? type : folderOf(type)
    )}</h2></div>
      <div class="grid ${cols}">${shown.map(entityCard).join("")}</div>`;
  }

  /* ---------------- view: activity ---------------- */

  function feedHtml(records) {
    if (!records.length) return `<div class="empty-note">Nothing logged yet.</div>`;
    return `<div class="feed">${records
      .map((r) => {
        const actorField = actorFieldOf(r.type);
        const actor = r.fm[actorField];
        const actorType = spec(r.type, actorField).ref_type;
        /* The longest prose field that is not the title: whatever this record
           type calls its summary. No field names, so a new record type reads
           correctly the day it is added to the schema. */
        const summary = blurb({ ...r, fm: r.fm }, 220);
        const parentField = meta(r.type).parent_field;
        const parentType = spec(r.type, parentField || "").ref_type;
        return `<div class="feed-item">
          <div class="feed-when">${esc(fmtDate(r.date))}</div>
          <div class="feed-main">
            ${link(r.type, r.id, r.title, "feed-title")}
            <div class="feed-meta">
              <span class="pill ${toneFor(r.type) || "accent"}">${esc(r.type)}</span>
              ${parentType && r.fm[parentField] ? link(parentType, r.fm[parentField], entityName(parentType, r.fm[parentField])) : ""}
              ${vocabPills(r, 3)}
              ${actor ? `<span class="pill quiet">${esc(actorType ? entityName(actorType, actor) : titleCase(actor))}</span>` : ""}
            </div>
            ${summary && summary !== r.title ? `<div class="feed-text">${summary}</div>` : ""}
          </div>
        </div>`;
      })
      .join("")}</div>`;
  }

  function viewActivity(routeKind) {
    const kinds = recordTypes();
    if (routeKind && kinds.includes(routeKind)) state.filters.activityKind = routeKind;
    const active = state.filters.activityKind;
    let shown = active ? state.records.filter((r) => r.type === active) : state.records;

    /* One filter per referenced entity type, not per field. Three record types
       name their author in three different fields (reported_by, decided_by,
       learned_by) and all three mean "a person", so grouping by target gives one
       "by person" row instead of three. Fields pointing at record types are left
       out: an update's `decisions` list would otherwise become a chip per
       decision.

       This is what makes "all of this team's work on this idea" answerable —
       pick the project. */
    const byTarget = new Map();
    for (const type of kinds) {
      for (const [field, fs] of Object.entries(fieldsOf(type))) {
        if (!fs.ref_type || fs.generated || !meta(fs.ref_type).list_view) continue;
        if (!byTarget.has(fs.ref_type)) byTarget.set(fs.ref_type, new Set());
        byTarget.get(fs.ref_type).add(field);
      }
    }
    const refRows = [...byTarget].map(([refType, fields]) => {
      const key = `activity.${refType}`;
      const active = state.filters[key];
      const labels = new Map();
      for (const r of state.records)
        for (const field of fields)
          for (const v of listOf(r.fm[field]))
            if (typeof v === "string" && v) labels.set(v, entityName(refType, v));
      if (labels.size < 2) return "";
      if (active)
        shown = shown.filter((r) =>
          [...fields].some((field) => listOf(r.fm[field]).includes(active))
        );
      return `<div class="chips">
        <button class="chip ${!active ? "on" : ""}" data-filter="${esc(key)}" data-value="">All ${esc(
        folderOf(refType)
      )}</button>
        ${[...labels]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(
            ([value, label]) =>
              `<button class="chip ${active === value ? "on" : ""}" data-filter="${esc(
                key
              )}" data-value="${esc(value)}">${esc(label)}</button>`
          )
          .join("")}</div>`;
    });

    return `
      ${refRows.join("")}
      <div class="chips">
        <button class="chip ${!active ? "on" : ""}" data-filter="activityKind" data-value="">Everything ${state.records.length}</button>
        ${kinds
          .map((k) => {
            const n = state.records.filter((r) => r.type === k).length;
            return `<button class="chip ${active === k ? "on" : ""}" data-filter="activityKind" data-value="${k}">${titleCase(
              k
            )}s ${n}</button>`;
          })
          .join("")}
      </div>
      <div class="grid cols-2 top">
        <div class="card">${feedHtml(shown)}</div>
        <div>
          <div class="card">
            <div class="card-sub" style="margin-bottom:10px">Commits to this repo</div>
            ${sparkHtml(state.data.commits)}
            <div style="margin-top:14px">${state.data.commits
              .slice(0, 40)
              .map(
                (c) => `<div class="commit-line">
                  <span class="sha">${esc(c.sha)}</span>
                  <span>${esc(c.subject)}</span>
                  <span class="who">${esc(c.author)} · ${esc(relTime(c.date))}</span>
                </div>`
              )
              .join("")}</div>
          </div>
        </div>
      </div>`;
  }

  /* Everything the graph says touches this entity, in both directions, plus one
     further hop through each neighbour.

     The second hop is what was missing: a person declares their teams, and a
     team declares its idea, so "what is this person working on" is two edges
     away and no view had walked it. Nothing here names a field or a type — the
     builder derived the edges from the schema, and this walks them. */

  const REL_HOP_LIMIT = 8;

  function relatedHtml(entity) {
    const blocks = [];
    const seen = new Set([`${entity.type}:${entity.id}`]);

    /* Records filed against this entity read better as a feed than as links. */
    const ownRecords = state.records.filter((r) =>
      edges(entity.type, entity.id, "in").some((e) => e.type === r.type && e.id === r.id)
    );
    for (const e of edges(entity.type, entity.id, "in")) seen.add(`${e.type}:${e.id}`);
    if (ownRecords.length) blocks.push(["Logged against this", feedHtml(ownRecords)]);

    /* Inbound edges only. An entity's own references are already in the facts
       panel, labelled and linked, so repeating them here said everything twice.
       What the facts panel cannot show is what points *at* this entity. */
    const groups = new Map();
    /* Anything this entity already points at is in the facts panel. Its mirror
       arriving as an inbound edge — picked_by in facts, team.idea inbound — is
       the same relationship twice. */
    const shown = new Set(
      edges(entity.type, entity.id, "out").map((e) => `${e.type}:${e.id}`)
    );
    for (const dir of ["in"]) {
      for (const e of edges(entity.type, entity.id, dir)) {
        if (!meta(e.type).list_view) continue;      // records are in the feed above
        const target = get(e.type, e.id);
        if (!target || target.fm.deprecated) continue;
        /* picked_by is generated from team.idea: the same relationship seen from
           both ends. Show whichever we reach first and skip its mirror. */
        if (shown.has(`${e.type}:${e.id}`)) continue;
        shown.add(`${e.type}:${e.id}`);
        const label = `${titleCase(folderOf(e.type))} by ${e.field.replace(/_/g, " ")}`;
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(`<div>${link(e.type, e.id, target.title)}</div>`);
        seen.add(`${e.type}:${e.id}`);
      }
    }
    for (const [label, items] of groups) blocks.push([label, `<div class="rel-list">${items.join("")}</div>`]);

    /* Records filed against a neighbour. An idea reaches its records through
       the projects that implement it, so without this hop an idea page shows
       which teams picked it up and nothing they actually did.

       Only through the type records actually attach to, though: hopping through
       a team as well would pull in every other project that team runs, which on
       an idea page is somebody else's work. And deduped, because a generated
       field means the same neighbour arrives from both directions. */
    const anchorType = recordTypes().map((t) => meta(t).parent_type).find(Boolean);
    const hopped = new Set();
    for (const near of edges(entity.type, entity.id, "out").concat(
      edges(entity.type, entity.id, "in")
    )) {
      if (near.type !== anchorType || hopped.has(near.id)) continue;
      hopped.add(near.id);
      const via = get(near.type, near.id);
      if (!via) continue;
      const viaRecords = state.records.filter((r) =>
        edges(near.type, near.id, "in").some((e) => e.type === r.type && e.id === r.id)
      );
      if (viaRecords.length) blocks.push([`Logged against ${via.title}`, feedHtml(viaRecords)]);
    }

    /* Two hops, attributed to the neighbour they came through. */
    const indirect = new Map();
    for (const dir of ["out", "in"]) {
      for (const near of edges(entity.type, entity.id, dir)) {
        if (!meta(near.type).list_view) continue;
        const via = get(near.type, near.id);
        if (!via) continue;
        for (const far of edges(near.type, near.id, "out")) {
          const key2 = `${far.type}:${far.id}`;
          if (seen.has(key2) || !meta(far.type).list_view) continue;
          const target = get(far.type, far.id);
          if (!target) continue;
          const label = `${titleCase(folderOf(far.type))} via ${via.title}`;
          if (!indirect.has(label)) indirect.set(label, []);
          if (indirect.get(label).length < REL_HOP_LIMIT)
            indirect.get(label).push(`<div>${link(far.type, far.id, target.title)}</div>`);
          seen.add(key2);
        }
      }
    }
    for (const [label, items] of indirect)
      blocks.push([label, `<div class="rel-list">${items.join("")}</div>`]);

    if (!blocks.length) return "";
    return blocks
      .map(
        ([label, body]) => `<div class="card" style="margin-top:14px">
          <div class="card-sub" style="margin-bottom:9px">${esc(label)}</div>${body}</div>`
      )
      .join("");
  }

  /* ---------------- view: graph ----------------

     Every entity as a node, every declared reference as an edge, laid out by a
     small force simulation on a canvas. No library: the page has no build step
     and no runtime dependencies, and a force sim over a couple of hundred nodes
     is a few lines of arithmetic.

     Nothing here knows what a team or an idea is. Nodes come from the entity
     list, edges from the graph the builder derived, colours from each type's
     position in that list. A brain with different entities gets its own graph
     for free. ------------------------------------------------------------- */

  const GRAPH_TONE_VARS = [
    "--accent", "--good", "--warm", "--accent-2", "--bad", "--graph-6", "--graph-7",
  ];

  function typeColor(type) {
    const at = (state.data.entity_order || []).indexOf(type);
    const name = GRAPH_TONE_VARS[(at < 0 ? 0 : at) % GRAPH_TONE_VARS.length];
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
  }

  function buildGraph() {
    const nodes = [];
    const byKey = new Map();
    for (const type of state.data.entity_order || []) {
      if (state.graph.hidden.has(type)) continue;
      for (const e of all(type)) {
        const node = {
          key: key(type, e.id), type, id: e.id, title: e.title, degree: 0,
          x: 0, y: 0, vx: 0, vy: 0,
        };
        byKey.set(node.key, node);
        nodes.push(node);
      }
    }
    /* One line per relationship: a generated field is the mirror of a field
       somebody wrote, so drawing both would double every edge. */
    const links = [];
    const seen = new Set();
    for (const [from, slots] of Object.entries(state.data.graph || {})) {
      const source = byKey.get(from);
      if (!source) continue;
      for (const e of slots.out || []) {
        if (spec(source.type, e.field).generated) continue;
        const target = byKey.get(key(e.type, e.id));
        if (!target) continue;
        const pair = `${from}|${target.key}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        links.push({ source, target, field: e.field });
        source.degree++;
        target.degree++;
      }
    }
    /* Seed on a circle: a random start makes the first second look like an
       explosion, and the same layout twice is easier to talk about. */
    const R = Math.min(320, 60 + nodes.length * 1.6);
    nodes.forEach((n, i) => {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      n.x = Math.cos(a) * R * (0.6 + ((i % 7) / 10));
      n.y = Math.sin(a) * R * (0.6 + ((i % 5) / 10));
    });
    return { nodes, links, byKey };
  }

  function radiusOf(node) {
    return 3.2 + Math.min(9, Math.sqrt(node.degree) * 2.1);
  }

  function stepGraph(g, alpha) {
    const REPEL = 1150, SPRING = 0.0021, LINK_LEN = 62, CENTRE = 0.0026, DAMP = 0.86;
    const { nodes, links } = g;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i % 3) - 1 || 0.7; dy = (j % 3) - 1 || 0.7; d2 = 1; }
        if (d2 > 360000) continue;               // far enough to ignore
        const f = (REPEL / d2) * alpha;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    for (const l of links) {
      const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - LINK_LEN) * SPRING * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      l.source.vx += fx; l.source.vy += fy;
      l.target.vx -= fx; l.target.vy -= fy;
    }
    for (const n of nodes) {
      if (n === state.graph.dragging) { n.vx = n.vy = 0; continue; }
      n.vx -= n.x * CENTRE * alpha;
      n.vy -= n.y * CENTRE * alpha;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
    }
  }

  function drawGraph() {
    const g = state.graph;
    const canvas = $("#graph-canvas");
    if (!canvas || !g.data) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + g.pan.x, h / 2 + g.pan.y);
    ctx.scale(g.zoom, g.zoom);

    const focus = g.hover || g.focus;
    const near = new Set();
    if (focus) {
      near.add(focus.key);
      for (const l of g.data.links) {
        if (l.source === focus) near.add(l.target.key);
        if (l.target === focus) near.add(l.source.key);
      }
    }

    const line = getComputedStyle(document.documentElement).getPropertyValue("--line").trim();
    for (const l of g.data.links) {
      const lit = focus && (near.has(l.source.key) && near.has(l.target.key));
      ctx.strokeStyle = lit ? typeColor(l.target.type) : line;
      ctx.globalAlpha = focus ? (lit ? 0.85 : 0.12) : 0.5;
      ctx.lineWidth = lit ? 1.4 / g.zoom : 0.8 / g.zoom;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    const labelAt = g.zoom > 1.5 ? 0 : g.zoom > 0.9 ? 6 : 12;
    for (const n of g.data.nodes) {
      const dim = focus && !near.has(n.key);
      ctx.globalAlpha = dim ? 0.22 : 1;
      ctx.fillStyle = typeColor(n.type);
      ctx.beginPath();
      ctx.arc(n.x, n.y, radiusOf(n), 0, Math.PI * 2);
      ctx.fill();
      if (n === focus) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 6 / g.zoom;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    /* Labels in a second pass, so a node drawn later cannot sit on top of one,
       with a halo in the panel colour to keep them readable over the edges. */
    const panel = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    for (const n of g.data.nodes) {
      const dim = focus && !near.has(n.key);
      if (dim || (n.degree < labelAt && n !== focus)) continue;
      const size = (n === focus ? 12 : 10.5) / g.zoom;
      ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
      const label = n.title.length > 34 ? n.title.slice(0, 33) + "…" : n.title;
      const y = n.y - radiusOf(n) - 4 / g.zoom;
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = panel;
      ctx.lineWidth = 3 / g.zoom;
      ctx.strokeText(label, n.x, y);
      ctx.globalAlpha = 1;
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue(n === focus ? "--text" : "--text-dim").trim();
      ctx.fillText(label, n.x, y);
    }
    ctx.restore();
  }

  /* Settle the layout synchronously instead of over animation frames.
     requestAnimationFrame does not tick while the page is hidden — a background
     tab, a collapsed pane — so a frame-driven layout arrives unsettled and stays
     that way until somebody looks at it. The physics is cheap enough to just
     run: a couple of hundred steps over a couple of hundred nodes. */
  function settleGraph(steps = 300) {
    const g = state.graph;
    let alpha = 1;
    for (let i = 0; i < steps; i++) {
      stepGraph(g.data, alpha);
      alpha *= 0.985;
    }
    g.alpha = 0;
  }

  /* Fit the whole graph in view. A force sim has no idea how big it will end
     up, so any fixed zoom is wrong for some brain. */
  function fitGraph() {
    const g = state.graph;
    const canvas = $("#graph-canvas");
    if (!canvas || !g.data || !g.data.nodes.length) return;
    if (!canvas.clientWidth || !canvas.clientHeight) return;   // not laid out yet
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of g.data.nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = 48;
    const w = canvas.clientWidth - pad * 2, h = canvas.clientHeight - pad * 2;
    const zoom = Math.min(2, Math.max(0.2, Math.min(w / (maxX - minX || 1), h / (maxY - minY || 1))));
    g.zoom = zoom;
    g.pan = { x: -((minX + maxX) / 2) * zoom, y: -((minY + maxY) / 2) * zoom };
  }

  function graphTick() {
    const g = state.graph;
    if (!g.running) return;
    if (g.alpha > 0.02) {
      stepGraph(g.data, g.alpha);   // only while a drag is warming it
      g.alpha *= 0.94;
    }
    drawGraph();
    g.raf = requestAnimationFrame(graphTick);
  }

  function graphNodeAt(clientX, clientY) {
    const g = state.graph;
    const canvas = $("#graph-canvas");
    const box = canvas.getBoundingClientRect();
    const x = (clientX - box.left - box.width / 2 - g.pan.x) / g.zoom;
    const y = (clientY - box.top - box.height / 2 - g.pan.y) / g.zoom;
    let best = null, bestD = Infinity;
    for (const n of g.data.nodes) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      const r = (radiusOf(n) + 6) ** 2;
      if (d < r && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  function stopGraph() {
    if (state.graph.raf) cancelAnimationFrame(state.graph.raf);
    if (state.graph.observer) state.graph.observer.disconnect();
    state.graph.observer = null;
    state.graph.running = false;
    state.graph.raf = null;
  }

  function mountGraph(focusKey) {
    const g = state.graph;
    window.__graph = g;          // inspectable while debugging the layout
    g.data = buildGraph();
    g.alpha = 0;
    g.running = true;
    g.hover = null;
    g.moved = false;
    g.focus = focusKey ? g.data.byKey.get(focusKey) || null : null;
    const canvas = $("#graph-canvas");
    if (!canvas) return;

    settleGraph();
    fitGraph();
    drawGraph();

    /* The canvas may have no size yet — a hidden pane, a fold-out panel. Fit
       again when it gets one, and on resize, unless the reader has taken over. */
    if (window.ResizeObserver) {
      g.observer = new ResizeObserver(() => {
        if (!g.moved) fitGraph();
        drawGraph();
      });
      g.observer.observe(canvas);
    }

    let down = null, movedFar = false;
    canvas.addEventListener("pointerdown", (e) => {
      /* Capture keeps a drag alive outside the canvas, but it throws for a
         pointer id the browser is not tracking — and an exception here would
         abandon the whole gesture, including the click. */
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable; dragging still works within the canvas */
      }
      const node = graphNodeAt(e.clientX, e.clientY);
      down = { x: e.clientX, y: e.clientY, node, pan: { ...g.pan } };
      movedFar = false;
      if (node) { g.dragging = node; g.focus = node; }
      g.alpha = Math.max(g.alpha, 0.35);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!down) {
        const hit = graphNodeAt(e.clientX, e.clientY);
        canvas.style.cursor = hit ? "pointer" : "grab";
        if (hit !== g.hover) { g.hover = hit; drawGraph(); }
        return;
      }
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) movedFar = true;
      if (down.node) {
        down.node.x += dx / g.zoom - (down.lastX || 0);
        down.node.y += dy / g.zoom - (down.lastY || 0);
        down.lastX = dx / g.zoom; down.lastY = dy / g.zoom;
        g.alpha = Math.max(g.alpha, 0.3);
      } else {
        g.pan = { x: down.pan.x + dx, y: down.pan.y + dy };
        g.moved = true;
        drawGraph();
      }
    });
    canvas.addEventListener("pointerup", (e) => {
      const node = down && down.node;
      g.dragging = null;
      const wasClick = node && !movedFar;
      down = null;
      if (wasClick) location.hash = `#/${node.type}/${encodeURI(node.id)}`;
      else if (!movedFar) { g.focus = null; drawGraph(); }
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const box = canvas.getBoundingClientRect();
      const cx = e.clientX - box.left - box.width / 2;
      const cy = e.clientY - box.top - box.height / 2;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(4, Math.max(0.25, g.zoom * factor));
      g.pan.x = cx - ((cx - g.pan.x) * next) / g.zoom;
      g.pan.y = cy - ((cy - g.pan.y) * next) / g.zoom;
      g.zoom = next;
      g.moved = true;
      drawGraph();
    }, { passive: false });

    graphTick();
  }

  function viewGraph() {
    const counts = (state.data.entity_order || []).map((type) => ({
      type,
      n: all(type).length,
      hidden: state.graph.hidden.has(type),
    }));
    return `
      <div class="section-head"><h2>Knowledge graph</h2>
        <span class="note">drag a node · scroll to zoom · click to open · hover to isolate</span></div>
      <div class="chips">
        ${counts
          .map(
            (c) =>
              `<button class="chip ${c.hidden ? "" : "on"}" data-graph-type="${esc(c.type)}">
                 <i class="dot" style="background:${typeColor(c.type)}"></i>${esc(
                titleCase(folderOf(c.type))
              )} ${c.n}</button>`
          )
          .join("")}
      </div>
      <div class="graph-wrap"><canvas id="graph-canvas"></canvas></div>`;
  }

  /* ---------------- view: detail ---------------- */

  /* Structural bookkeeping, plus whatever the card already used as the title.
     Reference fields are NOT hidden here any more — they are the interesting
     part, and they now render as links. */
  const HIDE_FACTS = new Set(["schema_version", "type", "slug", "sources"]);

  /* A reference renders as a link because the schema says it is a reference —
     not because the page recognises the field's name. The old version listed
     field names, so any reference field it had not been told about rendered as
     dead text. */
  function factValue(k, v, type) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return "";
    const refType = type ? spec(type, k).ref_type : null;
    if (refType) {
      const ids = listOf(v).filter(Boolean);
      return ids
        .map((id) => (get(refType, id) ? link(refType, id, entityName(refType, id)) : esc(String(id))))
        .join(", ");
    }
    if (Array.isArray(v)) {
      return v
        .map((item) =>
          typeof item === "object" && item !== null
            ? `<span class="pill quiet">${esc(Object.values(item).join(" · "))}</span>`
            : /^https?:/.test(item)
            ? `<a href="${esc(item)}" target="_blank" rel="noopener noreferrer">${esc(String(item).slice(0, 46))}…</a>`
            : isVocabValue(k, type, item)
            ? `<span class="pill">${esc(titleCase(item))}</span>`
            : `<span class="pill quiet">${esc(item)}</span>`
        )
        .join(" ");
    }
    if (typeof v === "object") return `<span class="pill quiet">${esc(JSON.stringify(v))}</span>`;
    if (/^https?:/.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`;
    if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return esc(String(v));
    if (isVocabValue(k, type, v)) return pill(v) || esc(v);
    return esc(String(v));
  }

  /* Title-casing and pill styling belong to controlled vocabulary. Applying
     them to free text capitalised every part of an address as though it were a
     label. (Written without an example: the publish workflow refuses anything
     address-shaped, and it cannot tell an illustration from a leak — correctly.) */
  function isVocabValue(field, type, value) {
    if (!type) return false;
    const vocab = spec(type, field).vocab;
    if (!vocab) return false;
    return (state.data.vocabularies[vocab] || []).includes(value);
  }

  /* Where a field goes is decided by the shape of its value, not its name: a
     list of objects or a paragraph is content and belongs in the wide column; a
     word or a date is a fact and belongs in the margin. options_considered —
     the whole point of a decision — was being squeezed into the sidebar as
     unreadable monospace. */
  const isHeavy = (v) =>
    (typeof v === "string" && v.length > 160) ||
    (Array.isArray(v) && v.some((i) => i && typeof i === "object")) ||
    (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 2);

  function detailFields(entity, heavy) {
    return Object.entries(entity.fm).filter(
      ([k, v]) =>
        !HIDE_FACTS.has(k) &&
        k !== entity.title_field &&
        v != null &&
        v !== "" &&
        !(Array.isArray(v) && !v.length) &&
        isHeavy(v) === heavy
    );
  }

  function structuredValue(v, type) {
    if (Array.isArray(v)) {
      return v
        .map((item) =>
          item && typeof item === "object"
            ? `<div class="struct">${Object.entries(item)
                .map(
                  ([k, val]) =>
                    `<div class="struct-row"><span class="struct-k">${esc(titleCase(k))}</span>` +
                    `<span class="struct-v">${esc(String(val))}</span></div>`
                )
                .join("")}</div>`
            : `<div class="struct-plain">${esc(String(item))}</div>`
        )
        .join("");
    }
    if (v && typeof v === "object") {
      return `<div class="struct">${Object.entries(v)
        .map(
          ([k, val]) =>
            `<div class="struct-row"><span class="struct-k">${esc(titleCase(k))}</span>` +
            `<span class="struct-v">${esc(String(val))}</span></div>`
        )
        .join("")}</div>`;
    }
    return `<p>${esc(String(v))}</p>`;
  }

  function heavyFieldsHtml(entity) {
    const rows = detailFields(entity, true);
    if (!rows.length) return "";
    return rows
      .map(
        ([k, v]) => `<div class="card" style="margin-top:14px">
          <div class="card-sub" style="margin-bottom:9px">${esc(titleCase(k))}</div>
          ${structuredValue(v, entity.type)}</div>`
      )
      .join("");
  }

  function factsHtml(entity) {
    const { fm, type } = entity;
    const rows = detailFields(entity, false)
      .map(([k, v]) => `<div class="fact"><span class="k">${esc(titleCase(k))}</span><span class="v">${factValue(k, v, type)}</span></div>`);
    return rows.length ? `<div class="facts">${rows.join("")}</div>` : "";
  }

  function sourcesHtml(fm) {
    const src = listOf(fm.sources);
    if (!src.length) return "";
    return `<div class="card" style="margin-top:14px">
      <div class="card-sub" style="margin-bottom:8px">Where this came from</div>
      <div class="facts">${src
        .map(
          (s) =>
            `<div class="fact"><span class="k">${esc(titleCase(s.system || "?"))}</span><span class="v">${esc(
              titleCase(s.method || "")
            )}${s.date ? ` · ${esc(s.date)}` : ""}</span></div>`
        )
        .join("")}</div>
    </div>`;
  }

  function viewDetail(type, id) {
    const entity = get(type, id);
    if (!entity) return `<div class="empty-note">Nothing here with the id <code>${esc(id)}</code>.</div>`;
    const repo = state.data.repo;
    const ghUrl = repo ? `https://github.com/${repo}/blob/main/${entity.path}` : null;
    return `
      <div class="detail">
        <div class="detail-top">
          <a class="back" href="${esc(routeForType(type))}">← back</a>
          <span class="kicker">${esc(type)}</span>
          ${vocabPills(entity, 2)}
        </div>
        <h1>${esc(entity.title)}</h1>
        <div class="card-sub" style="margin-bottom:18px">
          ${ghUrl ? `<a href="${esc(ghUrl)}" target="_blank" rel="noopener noreferrer">${esc(entity.path)}</a>` : esc(entity.path)}
        </div>
        <div class="detail-grid">
          <div>
            <div class="card prose">${entity.body || "<p><em>No prose in this file yet.</em></p>"}</div>
            ${heavyFieldsHtml(entity)}
            ${relatedHtml(entity)}
          </div>
          <div>
            <div class="card">
              <div class="card-sub" style="margin-bottom:8px">Recorded facts</div>
              ${factsHtml(entity) || '<div class="empty-note">Nothing recorded.</div>'}
            </div>
            ${sourcesHtml(entity.fm)}
          </div>
        </div>
      </div>`;
  }

  /* ---------------- search ---------------- */

  function searchAll(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const hits = [];
    for (const entity of state.byId.values()) {
      const haystack = `${entity.title} ${entity.id} ${JSON.stringify(entity.fm)}`.toLowerCase();
      const at = haystack.indexOf(q);
      if (at === -1) continue;
      const titleHit = entity.title.toLowerCase().includes(q);
      hits.push({ entity, score: (titleHit ? 0 : 500) + at });
    }
    hits.sort((a, b) => a.score - b.score);
    return hits.slice(0, 12).map((h) => h.entity);
  }

  function renderSearch(query) {
    const box = $("#search-results");
    const results = searchAll(query);
    if (!query.trim()) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML = results.length
      ? results
          .map(
            (e) =>
              `<a href="#/${e.type}/${encodeURI(e.id)}"><span class="kind">${esc(e.type)}</span><span>${esc(
                e.title
              )}</span></a>`
          )
          .join("")
      : `<div class="empty">No match.</div>`;
  }

  /* ---------------- routing ---------------- */

  function route() {
    const hash = location.hash.replace(/^#\/?/, "") || "pulse";
    const [head, ...rest] = hash.split("/");
    const app = $("#app");
    const detailTypes = state.data.entity_order || [];
    const listFolder = typeOfFolder(head);   // "#/teams" -> the team type

    stopGraph();

    let html;
    if (head === "graph") {
      html = viewGraph();
    } else if (detailTypes.includes(head) && rest.length) {
      html = viewDetail(head, decodeURI(rest.join("/")));
    } else if (listFolder && meta(listFolder).list_view) {
      html = viewList(listFolder);
    } else if (head === "activity") {
      html = viewActivity(rest[0] || "");
    } else {
      html = viewPulse();
    }
    app.innerHTML = html;
    window.scrollTo({ top: 0 });
    if (head === "graph") mountGraph(rest.length ? rest.join("/") : null);

    const tab =
      detailTypes.includes(head) && rest.length
        ? meta(head).list_view
          ? folderOf(head)
          : "activity"
        : listFolder
        ? head
        : head === "activity"
        ? "activity"
        : head === "graph"
        ? "graph"
        : "pulse";
    document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === tab));
  }

  /* ---------------- data loading ---------------- */

  function renderTabs() {
    const tabs = [["pulse", "Pulse"]]
      .concat(listTypes().map((t) => [folderOf(t), titleCase(folderOf(t))]))
      .concat([["activity", "Activity"], ["graph", "Graph"]]);
    $("#tabs").innerHTML = tabs
      .map(([slug, label]) => `<a href="#/${esc(slug)}" data-view="${esc(slug)}">${esc(label)}</a>`)
      .join("");
  }

  async function load(initial) {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`data.json: ${res.status}`);
    const data = await res.json();
    if (!initial && state.data && data.commit !== state.data.commit) {
      $("#toast").hidden = false;
    }
    state.data = data;
    index(data);
    applyBrand(data);
    renderTabs();
    $("#freshness-text").textContent = `built ${relTime(data.built_at)} · ${data.commit || ""}`;
    $("#freshness").title = `Built ${new Date(data.built_at).toLocaleString()} from commit ${data.commit}`;
    if (data.repo) {
      $("#footer-repo").innerHTML = `Generated from <a href="https://github.com/${esc(data.repo)}" target="_blank" rel="noopener noreferrer">${esc(
        data.repo
      )}</a> · schema v${esc(data.schema_version)}`;
    }
  }

  /* The page carries no brain's name. build_site.py reads it from the brain
     (SCHEMA.yml `site:`, else the README heading, else the repo name), because
     a page that hardcodes one brain's title announces every other brain as
     that one. */
  function applyBrand(data) {
    const brand = data.brand || {};
    const title = brand.title || (data.repo || "").split("/").pop() || "Brain";
    document.title = title;
    const heading = $("#brand-title");
    if (heading) heading.textContent = title;
    const sub = $("#brand-sub");
    if (sub) {
      sub.textContent = brand.subtitle || "";
      sub.hidden = !brand.subtitle;
    }
    const search = $("#search");
    if (search) {
      const kinds = listTypes().slice(0, 3).map((t) => folderOf(t));
      search.placeholder = kinds.length ? `Search ${kinds.join(", ")}…` : "Search the brain…";
    }
  }

  function initTheme() {
    const saved = (() => {
      try { return localStorage.getItem("brain-theme"); } catch { return null; }
    })();
    const system = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = saved || system;
    $("#theme-toggle").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("brain-theme", next); } catch { /* private mode */ }
    });
  }

  function initEvents() {
    window.addEventListener("hashchange", route);

    const search = $("#search");
    search.addEventListener("input", () => renderSearch(search.value));
    search.addEventListener("focus", () => renderSearch(search.value));
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search")) $("#search-results").hidden = true;
      const gchip = e.target.closest(".chip[data-graph-type]");
      if (gchip) {
        const type = gchip.dataset.graphType;
        if (state.graph.hidden.has(type)) state.graph.hidden.delete(type);
        else state.graph.hidden.add(type);
        route();
        return;
      }
      const chip = e.target.closest(".chip[data-filter]");
      if (chip) {
        state.filters[chip.dataset.filter] = chip.dataset.value || null;
        route();
        return;
      }
      /* Clicking the card goes to the card. Clicking a link inside it — one of
         its references — goes there instead, which is the reason the card is a
         div: nested anchors are invalid and the parser tears the card apart. */
      if (e.target.closest("a")) return;
      const card = e.target.closest(".card-link[data-href]");
      if (card) location.hash = card.dataset.href;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const card = e.target.closest?.(".card-link[data-href]");
      if (card) location.hash = card.dataset.href;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== search) {
        e.preventDefault();
        search.focus();
      }
      if (e.key === "Escape") {
        $("#search-results").hidden = true;
        search.blur();
      }
    });
    $("#search-results").addEventListener("click", () => {
      $("#search-results").hidden = true;
      search.value = "";
    });
    $("#toast-reload").addEventListener("click", () => location.reload());
  }

  async function start() {
    initTheme();
    initEvents();
    try {
      await load(true);
    } catch (err) {
      $("#app").innerHTML = `<div class="empty-note">Could not load <code>data.json</code>: ${esc(err.message)}</div>`;
      return;
    }
    route();
    setInterval(() => load(false).catch(() => {}), REFRESH_MS);
  }

  start();
})();
