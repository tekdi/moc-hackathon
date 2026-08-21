/* Hackathon Brain visualiser.
 *
 * Reads data.json (produced by scripts/build_site.py from the wiki's own
 * markdown) and renders it. There is no server, no framework and no state
 * that outlives a reload — everything on screen comes from the repo.
 */

(() => {
  "use strict";

  const REFRESH_MS = 60000;
  const state = {
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

  const listOf = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0]).join("").toUpperCase();
  }

  function personName(slug) {
    const p = get("person", slug);
    return p ? p.fm.name || p.title : titleCase(slug);
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

  const STATUS_TONE = {
    "demo-ready": "good", demoed: "good", building: "accent", forming: "warm",
    dropped: "quiet", "in-progress": "accent", unclaimed: "quiet", parked: "warm",
    worked: "good", failed: "bad", surprised: "alt", "wasted-time": "warm", reusable: "accent",
    blocker: "bad", demo: "good", metric: "alt", progress: "accent",
  };
  const pill = (value, tone) =>
    value ? `<span class="pill ${tone || STATUS_TONE[value] || ""}">${esc(titleCase(value))}</span>` : "";

  /* ---------------- indexing ---------------- */

  const RECORD_DATE = { update: "date", decision: "decided_on", learning: "learned_on" };
  const RECORD_ACTOR = { update: "reported_by", decision: "decided_by", learning: "learned_by" };

  function index(data) {
    state.byId.clear();
    state.updatesByTeam.clear();
    for (const [type, list] of Object.entries(data.entities || {})) {
      for (const e of list) state.byId.set(key(type, e.id), e);
    }
    const records = [];
    for (const type of ["update", "decision", "learning"]) {
      for (const e of data.entities[type] || []) {
        const date = e.fm[RECORD_DATE[type]] || e.fm.date || e.fm.last_updated || "";
        records.push({ ...e, date });
        const team = e.fm.team;
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

  const teams = () => state.data.entities.team || [];
  const ideas = () => state.data.entities.idea || [];
  const people = () => state.data.entities.person || [];

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

  function memberAvatars(team, max = 7) {
    const slugs = [team.fm.captain, ...listOf(team.fm.members)].filter(Boolean);
    const shown = slugs.slice(0, max);
    const rest = slugs.length - shown.length;
    return `<span class="avatars">${shown
      .map((s) => `<span class="avatar" title="${esc(personName(s))}">${esc(initials(personName(s)))}</span>`)
      .join("")}${rest > 0 ? `<span class="avatar" title="${rest} more">+${rest}</span>` : ""}</span>`;
  }

  /* ---------------- view: pulse ---------------- */

  function viewPulse() {
    const t = teams(), i = ideas(), p = people();
    const stages = state.data.vocabularies.stage || [];
    const reporting = t.filter((x) => (state.updatesByTeam.get(x.id) || []).length > 0);
    const claimed = i.filter((x) => listOf(x.fm.picked_by).length > 0);
    const withStatus = t.filter((x) => x.fm.status);
    const counts = {
      update: (state.data.entities.update || []).length,
      decision: (state.data.entities.decision || []).length,
      learning: (state.data.entities.learning || []).length,
    };

    const statusCounts = countBy(t, (x) => x.fm.status || "not-said");
    const statusOrder = [...(state.data.vocabularies.team_status || []), "not-said"];
    const statusColors = {
      forming: "var(--warm)", building: "var(--accent)", "demo-ready": "var(--good)",
      demoed: "var(--accent-2)", dropped: "var(--bad)", "not-said": "var(--line)",
    };
    const statusTotal = t.length || 1;

    const stageCounts = countBy(t, (x) => x.fm.stage_gate);
    const stageMax = Math.max(1, ...stageCounts.values());

    const silent = t.filter((x) => !(state.updatesByTeam.get(x.id) || []).length);

    return `
      <div class="stats">
        ${stat(t.length, "Teams", `${reporting.length} ${reporting.length === 1 ? "has" : "have"} logged something`)}
        ${stat(i.length, "Ideas", `${claimed.length} claimed by a team`, "accent")}
        ${stat(p.length, "People", `${new Set(t.flatMap((x) => [x.fm.captain, ...listOf(x.fm.members)]).filter(Boolean)).size} on a team`)}
        ${stat(counts.update, "Updates", "progress, blockers, demos", "good")}
        ${stat(counts.decision, "Decisions", "with options and trade-offs", "warm")}
        ${stat(counts.learning, "Learnings", "what worked, what didn't", "accent")}
      </div>

      <div class="section-head"><h2>Where the teams are</h2>
        <span class="note">${withStatus.length} of ${t.length} teams have said</span></div>
      <div class="grid cols-2 top">
        <div class="card">
          <div class="card-sub" style="margin-bottom:10px">Team status</div>
          <div class="stack">${statusOrder
            .map((s) => {
              const n = statusCounts.get(s) || 0;
              return n ? `<span style="width:${(n / statusTotal) * 100}%;background:${statusColors[s] || "var(--line)"}" title="${esc(titleCase(s))}: ${n}"></span>` : "";
            })
            .join("")}</div>
          <div class="legend">${statusOrder
            .filter((s) => statusCounts.get(s))
            .map((s) => `<span><i style="background:${statusColors[s] || "var(--line)"}"></i>${esc(titleCase(s))} · ${statusCounts.get(s)}</span>`)
            .join("")}</div>
        </div>
        <div class="card">
          <div class="card-sub" style="margin-bottom:10px">Ideas by problem area</div>
          ${barsHtml(countBy(i, (x) => x.fm.problem_area), null, "alt")}
        </div>
      </div>

      <div class="section-head"><h2>SDLC stage reached</h2>
        <span class="note">teams at each stage gate — blank stages are expected</span></div>
      <div class="card">
        <div class="rail">${stages
          .map((s) => {
            const n = stageCounts.get(s) || 0;
            return `<div class="rail-step ${n ? "on" : "dim"}" title="${esc(titleCase(s))}: ${n}">
              <div class="rail-bar"><span style="height:${n ? Math.max(12, (n / stageMax) * 100) : 3}%"></span></div>
              <div class="rail-label">${esc(titleCase(s))}</div>
            </div>`;
          })
          .join("")}</div>
      </div>

      <div class="grid cols-2 top" style="margin-top:14px">
        <div>
          <div class="section-head"><h2>Latest from the teams</h2>
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
        <span class="note">no update, decision or learning — probably heads-down, not stopped</span></div>
      <div class="grid cols-4">${silent.map(teamCardCompact).join("")}</div>` : ""}
    `;
  }

  const stat = (n, k, sub, tone) =>
    `<div class="stat ${tone || ""}"><div class="n">${n}</div><div class="k">${esc(k)}</div>${
      sub ? `<div class="sub">${esc(sub)}</div>` : ""
    }</div>`;

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

  /* ---------------- view: teams ---------------- */

  function teamCard(team) {
    const recs = state.updatesByTeam.get(team.id) || [];
    const idea = team.fm.idea ? get("idea", team.fm.idea) : null;
    const last = recs[0];
    return `<a class="card" href="#/team/${encodeURI(team.id)}">
      <div class="card-head">
        <div>
          <h3 class="card-title">${esc(team.title)}</h3>
          <div class="card-sub">${team.fm.team_number ? `Team ${team.fm.team_number} · ` : ""}${
            team.fm.captain ? `${esc(personName(team.fm.captain))} (captain)` : "no captain recorded"
          }</div>
        </div>
        ${pill(team.fm.status || "not-said", team.fm.status ? null : "quiet")}
      </div>
      <div class="card-body">${
        idea ? esc(idea.title) : team.fm.idea_label_as_stated ? esc(team.fm.idea_label_as_stated) : "<em>Idea not recorded</em>"
      }</div>
      <div class="card-foot">
        ${memberAvatars(team)}
        ${team.fm.stage_gate ? pill(team.fm.stage_gate, "accent") : ""}
        <span class="pill quiet">${recs.length} logged</span>
        ${last ? `<span class="pill quiet">${esc(relTime(last.date))}</span>` : ""}
      </div>
    </a>`;
  }

  const teamCardCompact = (team) =>
    `<a class="card" href="#/team/${encodeURI(team.id)}">
      <h3 class="card-title" style="font-size:14px">${esc(team.title)}</h3>
      <div class="card-sub">${team.fm.captain ? esc(personName(team.fm.captain)) : "—"}</div>
    </a>`;

  function viewTeams() {
    const statuses = [...new Set(teams().map((t) => t.fm.status).filter(Boolean))];
    const active = state.filters.teamStatus;
    const shown = active ? teams().filter((t) => t.fm.status === active) : teams();
    const ordered = [...shown].sort(
      (a, b) =>
        (state.updatesByTeam.get(b.id) || []).length - (state.updatesByTeam.get(a.id) || []).length ||
        (a.fm.team_number || 99) - (b.fm.team_number || 99)
    );
    return `
      <div class="chips">
        <button class="chip ${!active ? "on" : ""}" data-filter="teamStatus" data-value="">All ${teams().length}</button>
        ${statuses
          .map(
            (s) =>
              `<button class="chip ${active === s ? "on" : ""}" data-filter="teamStatus" data-value="${esc(s)}">${esc(
                titleCase(s)
              )}</button>`
          )
          .join("")}
      </div>
      <div class="grid cols-3">${ordered.map(teamCard).join("")}</div>`;
  }

  /* ---------------- view: ideas ---------------- */

  function ideaCard(idea) {
    const pickedBy = listOf(idea.fm.picked_by);
    return `<a class="card" href="#/idea/${encodeURI(idea.id)}">
      <div class="card-head">
        <h3 class="card-title">${esc(idea.title)}</h3>
        ${pill(idea.fm.status || "unclaimed")}
      </div>
      <div class="card-sub">${
        listOf(idea.fm.proposed_by).length
          ? esc(listOf(idea.fm.proposed_by).map(personName).join(", "))
          : "submitter not recorded"
      }</div>
      <div class="card-body">${(() => {
        const blurb = idea.fm.demo_promise || idea.fm.beneficiaries || "";
        return esc(blurb.slice(0, 165)) + (blurb.length > 165 ? "…" : "");
      })()}</div>
      <div class="card-foot">
        ${idea.fm.problem_area ? pill(idea.fm.problem_area, "alt") : ""}
        ${pickedBy.length ? `<span class="pill accent">${esc(pickedBy.map((s) => entityName("team", s)).join(", "))}</span>` : ""}
      </div>
    </a>`;
  }

  function viewIdeas() {
    const areas = state.data.vocabularies.problem_area || [];
    const { ideaArea, ideaStatus } = state.filters;
    let shown = ideas();
    if (ideaArea) shown = shown.filter((x) => x.fm.problem_area === ideaArea);
    if (ideaStatus) shown = shown.filter((x) => (x.fm.status || "unclaimed") === ideaStatus);
    const statuses = state.data.vocabularies.idea_status || [];
    return `
      <div class="chips">
        <button class="chip ${!ideaArea ? "on" : ""}" data-filter="ideaArea" data-value="">All areas</button>
        ${areas
          .filter((a) => ideas().some((x) => x.fm.problem_area === a))
          .map(
            (a) =>
              `<button class="chip ${ideaArea === a ? "on" : ""}" data-filter="ideaArea" data-value="${esc(a)}">${esc(
                titleCase(a)
              )}</button>`
          )
          .join("")}
      </div>
      <div class="chips">
        <button class="chip ${!ideaStatus ? "on" : ""}" data-filter="ideaStatus" data-value="">Any status</button>
        ${statuses
          .map(
            (s) =>
              `<button class="chip ${ideaStatus === s ? "on" : ""}" data-filter="ideaStatus" data-value="${esc(s)}">${esc(
                titleCase(s)
              )}</button>`
          )
          .join("")}
      </div>
      <div class="section-head"><h2>${shown.length} idea${shown.length === 1 ? "" : "s"}</h2></div>
      <div class="grid cols-3">${shown.map(ideaCard).join("")}</div>`;
  }

  /* ---------------- view: people ---------------- */

  function viewPeople() {
    const sorted = [...people()].sort((a, b) => a.title.localeCompare(b.title));
    return `
      <div class="section-head"><h2>${sorted.length} people</h2>
        <span class="note">team membership and proposed ideas are generated from the team and idea files</span></div>
      <div class="grid cols-4">${sorted
        .map((p) => {
          const teamRoles = listOf(p.fm.teams);
          return `<a class="card" href="#/person/${encodeURI(p.id)}">
            <div style="display:flex;gap:11px;align-items:center">
              <span class="avatar lg">${esc(initials(p.title))}</span>
              <div>
                <h3 class="card-title" style="font-size:14.5px">${esc(p.title)}</h3>
                <div class="card-sub">${
                  teamRoles.length
                    ? esc(teamRoles.map((t) => (typeof t === "string" ? titleCase(t) : entityName("team", t.team))).join(", "))
                    : "no team recorded"
                }</div>
              </div>
            </div>
            ${
              listOf(p.fm.proposed_ideas).length
                ? `<div class="card-foot"><span class="pill accent">${listOf(p.fm.proposed_ideas).length} idea${
                    listOf(p.fm.proposed_ideas).length === 1 ? "" : "s"
                  } proposed</span></div>`
                : ""
            }
          </a>`;
        })
        .join("")}</div>`;
  }

  /* ---------------- view: activity ---------------- */

  function feedHtml(records) {
    if (!records.length) return `<div class="empty-note">Nothing logged yet.</div>`;
    return `<div class="feed">${records
      .map((r) => {
        const actor = r.fm[RECORD_ACTOR[r.type]];
        const summary =
          r.type === "update" ? r.fm.what_changed
          : r.type === "decision" ? r.fm.chosen_because
          : r.fm.evidence;
        return `<div class="feed-item">
          <div class="feed-when">${esc(fmtDate(r.date))}</div>
          <div class="feed-main">
            ${link(r.type, r.id, r.title, "feed-title")}
            <div class="feed-meta">
              <span class="pill ${r.type === "decision" ? "warm" : r.type === "learning" ? "alt" : "accent"}">${esc(r.type)}</span>
              ${r.fm.team ? link("team", r.fm.team, entityName("team", r.fm.team)) : ""}
              ${r.fm.stage ? pill(r.fm.stage, "quiet") : ""}
              ${r.fm.record_kind ? pill(r.fm.record_kind) : ""}
              ${r.fm.kind ? pill(r.fm.kind) : ""}
              ${r.fm.decision_type ? pill(r.fm.decision_type, "quiet") : ""}
              ${actor ? `<span class="pill quiet">${esc(personName(actor))}</span>` : ""}
            </div>
            ${summary && summary !== r.title ? `<div class="feed-text">${esc(String(summary).slice(0, 220))}</div>` : ""}
          </div>
        </div>`;
      })
      .join("")}</div>`;
  }

  function viewActivity() {
    const kinds = ["update", "decision", "learning"];
    const active = state.filters.activityKind;
    const shown = active ? state.records.filter((r) => r.type === active) : state.records;
    return `
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

  /* ---------------- view: detail ---------------- */

  const HIDE_FACTS = new Set([
    "schema_version", "type", "slug", "title", "name", "sources", "picked_by",
    "members", "captain", "teams", "proposed_ideas", "what_changed", "decision", "learning",
  ]);

  function factValue(k, v) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return "";
    if (k === "team") return link("team", v, entityName("team", v));
    if (k === "idea") return link("idea", v, entityName("idea", v));
    if (["reported_by", "decided_by", "learned_by", "logged_by"].includes(k)) {
      return get("person", v) ? link("person", v, personName(v)) : esc(titleCase(v));
    }
    if (k === "proposed_by") return listOf(v).map((s) => link("person", s, personName(s))).join(", ");
    if (Array.isArray(v)) {
      return v
        .map((item) =>
          typeof item === "object" && item !== null
            ? `<span class="pill quiet">${esc(Object.values(item).join(" · "))}</span>`
            : /^https?:/.test(item)
            ? `<a href="${esc(item)}" target="_blank" rel="noopener noreferrer">${esc(String(item).slice(0, 46))}…</a>`
            : `<span class="pill">${esc(titleCase(item))}</span>`
        )
        .join(" ");
    }
    if (typeof v === "object") return `<span class="pill quiet">${esc(JSON.stringify(v))}</span>`;
    if (/^https?:/.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`;
    if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return esc(String(v));
    return String(v).length > 60 ? esc(v) : pill(v) || esc(v);
  }

  function factsHtml(fm) {
    const rows = Object.entries(fm)
      .filter(([k, v]) => !HIDE_FACTS.has(k) && v != null && v !== "" && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `<div class="fact"><span class="k">${esc(titleCase(k))}</span><span class="v">${factValue(k, v)}</span></div>`);
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

  function relatedHtml(entity) {
    const blocks = [];
    if (entity.type === "team") {
      const recs = state.updatesByTeam.get(entity.id) || [];
      if (recs.length) blocks.push(["Logged by this team", feedHtml(recs)]);
      const members = [entity.fm.captain, ...listOf(entity.fm.members)].filter(Boolean);
      if (members.length)
        blocks.push([
          "Members",
          `<div class="rel-list">${members
            .map((m) => `<div>${link("person", m, personName(m))}${m === entity.fm.captain ? " <span class=\"pill quiet\">captain</span>" : ""}</div>`)
            .join("")}</div>`,
        ]);
    }
    if (entity.type === "idea") {
      const picked = listOf(entity.fm.picked_by);
      if (picked.length)
        blocks.push([
          "Picked up by",
          `<div class="rel-list">${picked.map((t) => `<div>${link("team", t, entityName("team", t))}</div>`).join("")}</div>`,
        ]);
    }
    if (entity.type === "person") {
      const memberOf = teams().filter(
        (t) => t.fm.captain === entity.id || listOf(t.fm.members).includes(entity.id)
      );
      if (memberOf.length)
        blocks.push([
          "Teams",
          `<div class="rel-list">${memberOf
            .map((t) => `<div>${link("team", t.id, t.title)}${t.fm.captain === entity.id ? " <span class=\"pill quiet\">captain</span>" : ""}</div>`)
            .join("")}</div>`,
        ]);
      const proposed = listOf(entity.fm.proposed_ideas);
      if (proposed.length)
        blocks.push([
          "Proposed ideas",
          `<div class="rel-list">${proposed.map((i) => `<div>${link("idea", i, entityName("idea", i))}</div>`).join("")}</div>`,
        ]);
      const authored = state.records.filter((r) => r.fm[RECORD_ACTOR[r.type]] === entity.id);
      if (authored.length) blocks.push(["Reported by this person", feedHtml(authored)]);
    }
    return blocks
      .map(([title, body]) => `<div class="section-head"><h2>${esc(title)}</h2></div><div class="card">${body}</div>`)
      .join("");
  }

  function viewDetail(type, id) {
    const entity = get(type, id);
    if (!entity) return `<div class="empty-note">Nothing here with the id <code>${esc(id)}</code>.</div>`;
    const repo = state.data.repo;
    const ghUrl = repo ? `https://github.com/${repo}/blob/main/${entity.path}` : null;
    return `
      <div class="detail">
        <div class="detail-top">
          <a class="back" href="#/${type === "person" ? "people" : type === "idea" ? "ideas" : type === "team" ? "teams" : "activity"}">← back</a>
          <span class="kicker">${esc(type)}</span>
          ${entity.fm.status ? pill(entity.fm.status) : ""}
          ${entity.fm.stage ? pill(entity.fm.stage, "quiet") : ""}
        </div>
        <h1>${esc(entity.title)}</h1>
        <div class="card-sub" style="margin-bottom:18px">
          ${ghUrl ? `<a href="${esc(ghUrl)}" target="_blank" rel="noopener noreferrer">${esc(entity.path)}</a>` : esc(entity.path)}
        </div>
        <div class="detail-grid">
          <div>
            <div class="card prose">${entity.body || "<p><em>No prose in this file yet.</em></p>"}</div>
            ${relatedHtml(entity)}
          </div>
          <div>
            <div class="card">
              <div class="card-sub" style="margin-bottom:8px">Recorded facts</div>
              ${factsHtml(entity.fm) || '<div class="empty-note">Nothing recorded.</div>'}
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
    const detailTypes = ["team", "idea", "person", "update", "decision", "learning"];

    let html;
    if (detailTypes.includes(head) && rest.length) {
      html = viewDetail(head, decodeURI(rest.join("/")));
    } else {
      const views = { pulse: viewPulse, teams: viewTeams, ideas: viewIdeas, people: viewPeople, activity: viewActivity };
      html = (views[head] || viewPulse)();
    }
    app.innerHTML = html;
    window.scrollTo({ top: 0 });

    const tab = detailTypes.includes(head)
      ? { team: "teams", idea: "ideas", person: "people" }[head] || "activity"
      : head;
    document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === tab));
  }

  /* ---------------- data loading ---------------- */

  async function load(initial) {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`data.json: ${res.status}`);
    const data = await res.json();
    if (!initial && state.data && data.commit !== state.data.commit) {
      $("#toast").hidden = false;
    }
    state.data = data;
    index(data);
    $("#freshness-text").textContent = `built ${relTime(data.built_at)} · ${data.commit || ""}`;
    $("#freshness").title = `Built ${new Date(data.built_at).toLocaleString()} from commit ${data.commit}`;
    if (data.repo) {
      $("#footer-repo").innerHTML = `Generated from <a href="https://github.com/${esc(data.repo)}" target="_blank" rel="noopener noreferrer">${esc(
        data.repo
      )}</a> · schema v${esc(data.schema_version)}`;
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
      const chip = e.target.closest(".chip[data-filter]");
      if (chip) {
        state.filters[chip.dataset.filter] = chip.dataset.value || null;
        route();
      }
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
