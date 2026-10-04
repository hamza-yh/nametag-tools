/* ============================================================
   CORE CONVERSION FUNCTION — wcifToCsv(wcif)
   This is the piece meant to be lifted into another program.
   It has no dependencies and no DOM/network calls.
   ============================================================ */
function wcifToCsv(wcif) {

  // ---- 1. Flatten schedule activities (including nested child
  //         activities / groups) into a lookup by activity id,
  //         and record which room each activity lives in. ----
  const activityById = new Map();   // activityId -> { activityCode, roomId }
  const roomNameById = new Map();   // roomId -> room name
  let totalRoomCount = 0;

  function walkActivities(activities, roomId) {
    for (const act of activities || []) {
      activityById.set(act.id, { activityCode: act.activityCode, roomId });
      if (act.childActivities && act.childActivities.length) {
        walkActivities(act.childActivities, roomId);
      }
    }
  }

  const venues = (wcif.schedule && wcif.schedule.venues) || [];
  for (const venue of venues) {
    for (const room of venue.rooms || []) {
      totalRoomCount++;
      roomNameById.set(room.id, room.name);
      walkActivities(room.activities, room.id);
    }
  }

  // Room letter is only included when there are more than 2 rooms
  // in the whole WCIF (per spec).
  const useRoomLetter = totalRoomCount > 2;
  function roomLetter(roomId) {
    const name = roomNameById.get(roomId) || '';
    return name.charAt(0).toUpperCase();
  }

  // ---- 2. activityCode parser: "333-r1-g2" -> {eventId, round, group} ----
  const CODE_RE = /^([0-9a-z]+)-r(\d+)(?:-g(\d+))?$/;
  function parseActivityCode(code) {
    const m = CODE_RE.exec(code || '');
    if (!m) return null; // e.g. "other-lunch" — not a competition event
    return { eventId: m[1], round: Number(m[2]), group: m[3] ? Number(m[3]) : null };
  }

  // ---- 3. Which events get columns, and in what order ----
  const eventIds = (wcif.events || []).map(e => e.id);

  // ---- 4. Name parsing: "First Middle Last (localized)" ----
  function parseName(fullName) {
    const m = /\s*\(([^)]*)\)\s*$/.exec(fullName || '');
    const localizedName = m ? m[1] : '';
    const westernName = m ? fullName.slice(0, m.index) : (fullName || '');
    const spaceIdx = westernName.indexOf(' ');
    const firstName = spaceIdx === -1 ? westernName : westernName.slice(0, spaceIdx);
    const lastName  = spaceIdx === -1 ? '' : westernName.slice(spaceIdx + 1);
    return { firstName, lastName, localizedName };
  }

  // ---- 5. Role formatting: capitalize first character only,
  //         space-separated, e.g. ["delegate"] -> "Delegate". Any
  //         role containing "staff" (e.g. "staff-dataentry") is
  //         collapsed to the single word "Staff". Duplicates that
  //         result from that collapsing (e.g. two staff-* roles)
  //         are removed, preserving first-seen order. ----
  function formatRoles(roles) {
    if (!roles || roles.length === 0) return '';
    const formatted = roles.map(r =>
      r.toLowerCase().includes('staff') ? 'Staff' : (r.charAt(0).toUpperCase() + r.slice(1))
    );
    return [...new Set(formatted)].join(' ');
  }

  // Roles that force a row even with 0 assignments.
  const FORCE_INCLUDE_ROLES = new Set(['delegate', 'trainee-delegate']);

  // ---- 6. Build header row ----
  const header = ['registrantId', 'name', 'firstname', 'lastname', 'localizedName', 'wcaId', 'role', 'country_iso'];
  for (const eventId of eventIds) {
    header.push(eventId, `${eventId}_station_number`, `${eventId}_staff`);
  }

  const rows = [header];

  // ---- 7. One row per included person ----
  for (const person of wcif.persons || []) {
    const roles = person.roles || [];
    const allAssignments = person.assignments || [];

    // This tool only cares about round 1 of each event — drop any
    // assignment whose activity is round 2 or later. Assignments on
    // non-round activities (e.g. "other-lunch") aren't affected by
    // this rule since they have no round to compare.
    const assignments = allAssignments.filter(a => {
      const activity = activityById.get(a.activityId);
      if (!activity) return false;
      const parsed = parseActivityCode(activity.activityCode);
      return !parsed || parsed.round === 1;
    });

    const forceInclude = roles.some(r => FORCE_INCLUDE_ROLES.has(r));
    if (assignments.length === 0 && !forceInclude) continue;

    const { firstName, lastName, localizedName } = parseName(person.name);
    const wcaId = person.wcaId || 'Newcomer';
    const roleStr = formatRoles(roles);
    const countryIso = person.countryIso2 || '';

    // Per-event buckets. Multiple assignments in the same event
    // (e.g. competing in round 1 AND round 2) are not something a
    // single cell can represent unambiguously, so — most basic
    // implementation — every match found is appended in the order
    // it appears in the person's assignments array, space-separated.
    const perEvent = {};
    for (const eventId of eventIds) {
      // staffAssignments is a flat list of {letter, group} entries, sorted
      // by group number (ascending) at output time — so e.g. S1 R2, never
      // R2 S1 just because an R-task happened to be seen first.
      perEvent[eventId] = { groups: [], stations: [], staffAssignments: [] };
    }

    for (const a of assignments) {
      const activity = activityById.get(a.activityId);
      if (!activity) continue;
      const parsed = parseActivityCode(activity.activityCode);
      if (!parsed || !perEvent[parsed.eventId]) continue; // not a tracked event (e.g. "other-*")

      const bucket = perEvent[parsed.eventId];

      if (a.assignmentCode === 'competitor') {
        if (parsed.group !== null) {
          const letter = useRoomLetter ? roomLetter(activity.roomId) : '';
          bucket.groups.push(`${letter}${parsed.group}`);
        }
        if (a.stationNumber !== null && a.stationNumber !== undefined) {
          bucket.stations.push(String(a.stationNumber));
        }
      } else if (a.assignmentCode && a.assignmentCode.startsWith('staff-')) {
        if (parsed.group !== null) {
          const taskLetter = a.assignmentCode.slice('staff-'.length).charAt(0).toUpperCase();
          bucket.staffAssignments.push({ letter: taskLetter, group: parsed.group });
        }
      }
    }

    const row = [person.registrantId, person.name || '', firstName, lastName, localizedName, wcaId, roleStr, countryIso];
    for (const eventId of eventIds) {
      const bucket = perEvent[eventId];
      row.push(bucket.groups.join(' '));
      row.push(bucket.stations.join(' '));

      const staffParts = bucket.staffAssignments
        .slice()
        .sort((a, b) => a.group - b.group || a.letter.localeCompare(b.letter))
        .map(s => `${s.letter}${s.group}`);
      row.push(staffParts.join(' '));
    }
    rows.push(row);
  }

  // ---- 8. Order rows: everyone with a WCA ID first, "Newcomer"s
  //         after, each group alphabetical by firstname then
  //         lastname. ----
  const dataRows = rows.slice(1);
  const withWcaId = dataRows.filter(r => r[5] !== 'Newcomer');
  const newcomers  = dataRows.filter(r => r[5] === 'Newcomer');

  function byName(a, b) {
    const nameOf = r => `${r[2]} ${r[3]}`.trim().toLowerCase(); // "firstname lastname"
    return nameOf(a).localeCompare(nameOf(b));
  }
  withWcaId.sort(byName);
  newcomers.sort(byName);

  const orderedRows = [header, ...withWcaId, ...newcomers];

  // ---- 9. Serialize to CSV ----
  function csvEscape(value) {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  return orderedRows.map(r => r.map(csvEscape).join(',')).join('\n');
}
/* ============================================================
   End of wcifToCsv — everything below is just the tab's UI.
   ============================================================ */

const compIdInput = document.getElementById('csv-compId');
const fetchBtn = document.getElementById('csv-fetchBtn');
const pasteToggle = document.getElementById('csv-pasteToggle');
const pasteArea = document.getElementById('csv-pasteArea');
const pasteJson = document.getElementById('csv-pasteJson');
const pasteBtn = document.getElementById('csv-pasteBtn');
const statusEl = document.getElementById('csv-status');
const metaEl = document.getElementById('csv-meta');
const downloadBtn = document.getElementById('csv-downloadBtn');

pasteToggle.addEventListener('click', () => {
  pasteArea.classList.toggle('open');
});

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function renderResult(wcif, csv, sourceLabel) {
  const rowCount = csv.split('\n').length - 1; // minus header
  const roomCount = (wcif.schedule && wcif.schedule.venues || [])
    .reduce((sum, v) => sum + (v.rooms ? v.rooms.length : 0), 0);
  const eventCount = (wcif.events || []).length;

  setStatus(`Converted ${sourceLabel}. ${rowCount} competitor row(s) generated.`, 'ok');

  metaEl.style.display = 'grid';
  metaEl.innerHTML = `
    <div><b>Competition</b><br>${wcif.name || wcif.id || '(unknown)'}</div>
    <div><b>Persons in WCIF</b><br>${(wcif.persons || []).length}</div>
    <div><b>Rows in CSV</b><br>${rowCount}</div>
    <div><b>Events</b><br>${eventCount}</div>
    <div><b>Rooms</b><br>${roomCount} (room letter ${roomCount > 2 ? 'ON' : 'off'})</div>
  `;

  // Prepend a UTF-8 BOM. Without it, Excel (esp. on Windows) guesses the
  // wrong legacy codepage and mangles any non-Latin characters (e.g.
  // localized names in Arabic, Chinese, Korean, etc.) into garbled text.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  downloadBtn.href = url;
  downloadBtn.download = `${wcif.id || 'competitors'}.csv`;
  downloadBtn.removeAttribute('disabled');
}

async function handleFetch() {
  const compId = compIdInput.value.trim();
  if (!compId) {
    setStatus('Enter a competition ID first.', 'error');
    return;
  }
  fetchBtn.disabled = true;
  downloadBtn.setAttribute('disabled', 'disabled');
  setStatus('Fetching WCIF…');
  try {
    const url = `https://www.worldcubeassociation.org/api/v0/competitions/${encodeURIComponent(compId)}/wcif/public`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`WCA API returned ${res.status}. Check the competition ID.`);
    }
    const wcif = await res.json();
    const csv = wcifToCsv(wcif);
    renderResult(wcif, csv, `"${wcif.name || compId}"`);
  } catch (err) {
    setStatus(
      `Could not fetch/convert: ${err.message}\nIf this is a CORS error in the console, use "paste WCIF JSON instead" below.`,
      'error'
    );
  } finally {
    fetchBtn.disabled = false;
  }
}

function handlePaste() {
  const raw = pasteJson.value.trim();
  if (!raw) {
    setStatus('Paste some WCIF JSON first.', 'error');
    return;
  }
  try {
    const wcif = JSON.parse(raw);
    const csv = wcifToCsv(wcif);
    renderResult(wcif, csv, 'pasted WCIF');
  } catch (err) {
    setStatus(`Could not parse/convert pasted JSON: ${err.message}`, 'error');
  }
}

fetchBtn.addEventListener('click', handleFetch);
compIdInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleFetch(); });
pasteBtn.addEventListener('click', handlePaste);
