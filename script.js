"use strict";

const byId = (id) => document.getElementById(id);
const config = window.SIMS_CONFIG ?? {};
const cloudMode = Boolean(config.supabaseUrl || config.supabasePublishableKey);
const storageKey = "sims-demo-v1";
const form = byId("student-form");
const authForm = byId("sign-in-form");
const pages = ["dashboard", "students", "enrollment", "clearance", "settings", "library-activity"];
const enrollmentStatuses = ["Enrolled", "Not Enrolled"];
const clearanceStatuses = ["Pending", "Cleared", "Not Cleared"];
const fields = [
  ["studentId", "Student number"],
  ["name", "Full name"],
  ["course", "Course"],
  ["year", "Year level"],
  ["contact", "Contact number"],
  ["status", "Enrollment status"],
];

const samples = [
  { id: 1, studentId: "2026-001", name: "Alex Santos", course: "BSIT", year: 1, contact: "000-000-0001", status: "Enrolled", clearance: "Cleared", deletedAt: null },
  { id: 2, studentId: "2026-002", name: "Sam Reyes", course: "BSCS", year: 2, contact: "000-000-0002", status: "Enrolled", clearance: null, deletedAt: null },
  { id: 3, studentId: "2026-003", name: "Jamie Cruz", course: "BSIS", year: 3, contact: "000-000-0003", status: "Not Enrolled", clearance: "Not Cleared", deletedAt: null },
];

let records = [];
let cloud;
let staff = null;
let busy = false;
let editing = null;
let removing = null;
let storageSnapshot = null;
let storageError = "";

function message(id, text) {
  const element = byId(id);
  element.textContent = text;
  element.hidden = !text;
}

function loadDemo() {
  try {
    storageSnapshot = localStorage.getItem(storageKey);
    if (storageSnapshot === null) return samples;

    const saved = JSON.parse(storageSnapshot);
    const valid = Array.isArray(saved) && saved.every((student) =>
      student &&
      Number.isSafeInteger(student.id) &&
      student.id > 0 &&
      ["studentId", "name", "course", "contact"].every(
        (key) => typeof student[key] === "string" && student[key].trim()
      ) &&
      Number.isSafeInteger(student.year) && student.year >= 1 &&
      enrollmentStatuses.includes(student.status) &&
      (student.clearance == null || clearanceStatuses.includes(student.clearance)) &&
      (student.deletedAt == null ||
        (typeof student.deletedAt === "string" && !Number.isNaN(Date.parse(student.deletedAt))))
    );

    if (!valid ||
        new Set(saved.map((student) => student.id)).size !== saved.length ||
        new Set(saved.map((student) => student.studentId.trim().toLowerCase())).size !== saved.length) {
      throw new Error("Invalid stored records");
    }
    return saved;
  } catch {
    storageError = "Saved records could not be opened. Sample records are read-only.";
    return samples;
  }
}

function saveDemo(nextRecords) {
  if (storageError) throw new Error(storageError);

  try {
    if (localStorage.getItem(storageKey) !== storageSnapshot) {
      throw Object.assign(new Error("Records changed in another tab. Refresh and try again."), {
        code: "DEMO_CONFLICT",
      });
    }
    const nextSnapshot = JSON.stringify(nextRecords);
    localStorage.setItem(storageKey, nextSnapshot);
    storageSnapshot = nextSnapshot;
  } catch (error) {
    if (error.code === "DEMO_CONFLICT") throw error;
    throw new Error("Browser storage is full or unavailable. Changes were not saved.");
  }

  records = nextRecords;
  render();
}

function showPage() {
  const requested = location.hash.slice(1).split("?")[0];
  const page = pages.includes(requested) ? requested : "dashboard";
  const canView = !cloudMode || Boolean(staff);

    for (const id of pages) {
      const section = byId(id);
    if (section) section.hidden = !canView || id !== page;
  }

  byId("sign-in").hidden = !cloudMode || canView;
  byId("cloud-controls").hidden = !cloudMode || !canView;
  document.querySelector("nav").hidden = !canView;

  for (const link of document.querySelectorAll("[data-page]")) {
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  message("notice", storageError);
    if (page === "enrollment" && canView) loadEnrollments();
  if (page === "library-activity" && canView) loadClearanceHistory();
  if (page === "settings" && canView) {
    byId("settings-email").textContent = staff?.email ?? "";
    byId("settings-account").hidden = !staff?.email;
    byId("library-integration-title").closest("section").hidden = !cloudMode || !staff;
  }
}

function activeStudents() {
  return records.filter((student) => !student.deletedAt);
}

function clearance(student) {
  return student.clearance ?? "Pending";
}

function badge(status) {
  const colors = {
    Enrolled: "good",
    Cleared: "good",
    Pending: "waiting",
    "Not Cleared": "blocked",
  };
  const label = document.createElement("span");
  label.className = "badge";
  if (colors[status]) label.classList.add(colors[status]);
  label.textContent = status;
  return label;
}

function actionButton(label, student, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = label;
  button.setAttribute("aria-label", `${label} ${student.name}`);
  button.addEventListener("click", () => {
    if (!busy) action(student);
  });
  return button;
}

const clearancePreferenceKey = "sinag-clearance-notifications";
const clearanceToggle = byId("clearance-notifications");
const clearanceTimestamp = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short",
});
let previousClearances = null;

try {
  clearanceToggle.checked = localStorage.getItem(clearancePreferenceKey) === "on";
} catch {
  clearanceToggle.checked = false;
}

clearanceToggle.addEventListener("change", () => {
  if (!clearanceToggle.checked) message("clearance-alert", "");

  try {
    localStorage.setItem(clearancePreferenceKey, clearanceToggle.checked ? "on" : "off");
    message("clearance-preference-message", "");
  } catch {
    message("clearance-preference-message", "This preference applies until you close the tab.");
  }
});

let historyRequest = 0;

async function loadClearanceHistory() {
  if (!cloud || !staff) {
    message("clearance-history-status", "Sign in to view clearance activity.");
    return;
  }

  const request = ++historyRequest;
  const session = staff;
  const rows = byId("clearance-history-rows");
  rows.replaceChildren();
  message("clearance-history-status", "Loading clearance activity...");

  try {
    const { data, error } = await cloud.client.from("clearance_activity")
      .select("student_number,previous_status,new_status,changed_at,source")
      .order("id", { ascending: false })
      .limit(50);

    if (request !== historyRequest || staff !== session ||
        location.hash !== "#library-activity") return;
    if (error) throw error;

    rows.replaceChildren(...data.map((entry) => {
      const row = document.createElement("tr");
      const values = [
        entry.student_number,
        entry.previous_status,
        entry.new_status,
        clearanceTimestamp.format(new Date(entry.changed_at)) + " PHT",
        entry.source,
      ];
      for (const value of values) row.insertCell().textContent = value;
      return row;
    }));

    message("clearance-history-status", data.length
      ? `Showing ${data.length} recent clearance changes.`
      : "No clearance changes recorded yet.");
  } catch {
    if (request === historyRequest && staff === session &&
        location.hash === "#library-activity") {
      message("clearance-history-status", "Could not load activity. Go back to Settings and reopen Library Integration.");
    }
  }
}


function updateLibraryIntegration(students) {
  if (!cloudMode || !staff) {
    previousClearances = null;
    historyRequest += 1;


    byId("clearance-history-rows").replaceChildren();
    message("clearance-history-status", "");
    message("clearance-alert", "");
    return;
  }

  const current = new Map();
  let latest = null;
  let changed = 0;

  for (const student of students) {
    const status = clearance(student);
    current.set(student.id, status);

    if (previousClearances?.has(student.id) && previousClearances.get(student.id) !== status) {
      changed += 1;
    }

    const timestamp = Date.parse(student.clearanceUpdatedAt);
    if (Number.isFinite(timestamp) && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }

  previousClearances = current;
  byId("library-last-update").textContent = latest === null
    ? "No clearance updates yet."
    : clearanceTimestamp.format(latest) + " PHT";

  if (clearanceToggle.checked && changed > 0) {
    message("clearance-alert", changed === 1
      ? "Library clearance changed for 1 student."
      : `Library clearance changed for ${changed} students.`);
  }
}


function render() {
  const students = activeStudents();
  updateLibraryIntegration(students);
  byId("total").textContent = students.length;
  byId("enrolled").textContent = students.filter(
    (student) => student.status === "Enrolled"
  ).length;

  for (const status of clearanceStatuses) {
    byId(status.replace(" ", "-")).textContent = students.filter(
      (student) => clearance(student) === status
    ).length;
  }

  renderStudentRecords(students);
  renderClearance();
}

function renderStudentRecords(students = activeStudents()) {
  const search = byId("student-search");
  const query = (search?.value ?? "").trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const course = byId("student-course-filter")?.value ?? "";
  const year = byId("student-year-filter")?.value ?? "";
  const status = byId("student-status-filter")?.value ?? "";

  const matches = students.filter((student) => {
    const searchable = [
      student.studentId, student.name, student.surname,
      student.firstName, student.middleName, student.suffix,
    ].join(" ").toLowerCase();

    return terms.every((term) => searchable.includes(term))
      && (!course || savedCourseOption(student.course) === course)
      && (!year || String(student.year) === year)
      && (!status || student.status === status);
  });

  const rows = matches.map((student) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = student.studentId;

       row.insertCell().textContent = student.name;

    for (const key of ["course", "year", "contact", "status"]) {
      const cell = row.insertCell();
      if (key === "status") cell.append(badge(student.status));
      else cell.textContent = studentFieldLabel(student, key);
    }

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(
      actionButton("View", student, viewStudent),
      actionButton("Edit", student, openEditor),
      actionButton("Remove", student, requestRemove)
    );
    row.insertCell().append(actions);
    return row;
  });

  byId("student-rows").replaceChildren(...rows);
  const empty = byId("student-empty");
  empty.hidden = rows.length > 0;
  empty.textContent = students.length
    ? "No students match your search or filters."
    : "No active student records.";
}

function selectedClearanceStatus() {
  const [page, params] = location.hash.slice(1).split("?");
  if (page !== "clearance") return "";
  const status = new URLSearchParams(params).get("status");
  return clearanceStatuses.includes(status) ? status : "";
}

function renderClearance() {
  const query = byId("clearance-search").value.trim().toLowerCase();
  const status = selectedClearanceStatus();
  clearanceFilter.value = status;

  if (query !== previousClearanceQuery || status !== previousClearanceStatus) {
    clearancePage = 1;
    previousClearanceQuery = query;
    previousClearanceStatus = status;
  }

  const matches = activeStudents().filter((student) => {
    const matchesStatus = !status || clearance(student) === status;
    const matchesSearch = !query ||
      student.studentId.toLowerCase() === query ||
      student.name.toLowerCase().includes(query);
    return matchesStatus && matchesSearch;
  });

  const pageCount = Math.max(1, Math.ceil(matches.length / clearancePageSize));
  clearancePage = Math.min(Math.max(clearancePage, 1), pageCount);
  const start = (clearancePage - 1) * clearancePageSize;
  const end = Math.min(start + clearancePageSize, matches.length);

  const rows = matches.slice(start, end).map((student) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = student.studentId;
    row.insertCell().textContent = student.name;
    row.insertCell().append(badge(clearance(student)));
    return row;
  });

  byId("clearance-rows").replaceChildren(...rows);
  byId("clearance-empty").hidden = matches.length > 0;
  clearancePager.hidden = matches.length === 0;
  clearancePageSummary.textContent = matches.length
    ? `Showing ${start + 1}–${end} of ${matches.length} students`
    : "";
  clearancePrevious.disabled = clearancePage === 1;
  clearanceNext.disabled = clearancePage === pageCount;
}

function studentFieldLabel(student, key) {
  if (key !== "course") return student[key];

  const courseCode = savedCourseOption(student.course);
  const options = form.elements.namedItem("course").options;
  const course = Array.from(options).find(
    (option) => courseCode && option.value === courseCode
  );

  return course?.textContent ?? student.course;
}


function viewStudent(student) {
  const details = byId("student-details");
  details.replaceChildren();

  for (const [key, label] of fields) {
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = label;
    value.textContent = studentFieldLabel(student, key);
    details.append(term, value);
  }

  byId("details").showModal();
}

function savedCourseOption(course) {
  const code = course.trim().toUpperCase();
  const courses = new Map([
    ["IT", "IT"], ["BSIT", "IT"],
    ["CS", "CS"], ["BSCS", "CS"],
    ["HM", "HM"], ["BSHM", "HM"],
    ["PSYCH", "Psych"], ["BSPSYCH", "Psych"], ["PSYCHOLOGY", "Psych"],
    ["CIVIL ENGINEERING", "Civil Engineering"], ["BSCE", "Civil Engineering"],
  ]);
  return courses.get(code) ?? "";
}


function openEditor(student = null) {
  editing = student;
  const courseSelect = form.elements.namedItem("course");
  courseSelect.querySelector("[data-saved-course]")?.remove();
  form.reset();
  message("form-error", "");
  byId("editor-title").textContent = student ? "Edit student" : "Add student";

    const nameFields = {
    surname: student?.surname ?? "",
    firstName: student?.firstName ?? "",
    middleName: student?.middleName ?? "",
    suffix: student?.suffix ?? "",
  };

  if (student && !nameFields.surname && !nameFields.firstName) {
    const parts = student.name.trim().split(/\s+/).filter(Boolean);
    const suffixKey = parts.at(-1)?.replace(/\./g, "").toUpperCase();
    const suffixes = { JR: "Jr.", SR: "Sr.", II: "II", III: "III", IV: "IV", V: "V" };

    if (parts.length > 2 && Object.hasOwn(suffixes, suffixKey)) {
      nameFields.suffix = suffixes[suffixKey];
      parts.pop();
    }

    if (parts.length > 1) nameFields.surname = parts.pop();
    if (parts.length > 1 && /^[A-Z]\.$/i.test(parts.at(-1))) {
      nameFields.middleName = parts.pop();
    }
    nameFields.firstName = parts.join(" ");
  }

  byId("legacy-student-name").hidden = true;
  for (const [key, value] of Object.entries(nameFields)) {
    form.elements.namedItem(key).value = value;
  }
  form.elements.namedItem("surname").required = true;
  form.elements.namedItem("firstName").required = true;

  if (student) {
    for (const [key] of fields) {
      if (key !== "course" && key !== "name") {
        form.elements.namedItem(key).value = student[key];
      }
    }

    const courseCode = savedCourseOption(student.course);
    if (courseCode) {
      courseSelect.value = courseCode;
    } else {
      const savedOption = new Option(student.course, student.course);
      savedOption.dataset.savedCourse = "";
      courseSelect.add(savedOption);
      savedOption.selected = true;
    }
  }

  byId("editor").showModal();
}

function requestRemove(student) {
  removing = student;
  byId("delete-message").textContent =
    `${student.name} will be removed from the active list. The saved record will be retained.`;
  byId("delete-dialog").showModal();
}

function readStudent() {
  const values = new FormData(form);

  const student = {
    year: Number(values.get("year")),
    contact: String(values.get("contact") ?? ""),
    status: String(values.get("status") ?? "").trim(),
  };

  const surname = String(values.get("surname") ?? "").trim();
  const firstName = String(values.get("firstName") ?? "").trim();
  const middleName = String(values.get("middleName") ?? "").trim();
  const enteredSuffix = String(values.get("suffix") ?? "").trim();
  const suffix = /^n\/a$/i.test(enteredSuffix) ? "" : enteredSuffix;
  if (suffix.length > 16) {
    throw new Error("Suffix must be 16 characters or fewer.");
  }
  const hasLegacyName = editing && !editing.surname && !editing.firstName;

  if (!hasLegacyName || surname || firstName || middleName || suffix) {
    if (!surname || !firstName) {
      throw new Error("Enter both the surname and first name.");
    }

    const name = [firstName, middleName, surname, suffix].filter(Boolean).join(" ");
    if (name.length > 120) {
      throw new Error("The combined name must be 120 characters or fewer.");
    }

    Object.assign(student, { name, surname, firstName, middleName, suffix });
  }

  const course = String(values.get("course") ?? "");
  const savedCourse = editing && (savedCourseOption(editing.course) || editing.course);
  if (!editing || course !== savedCourse) {
    if (!["IT", "CS", "HM", "Psych", "Civil Engineering"].includes(course)) {
      throw new Error("Choose a course from the list.");
    }
    student.course = course;
  }

  if (!Number.isInteger(student.year) || student.year < 1 || student.year > 6) {
    throw new Error("Choose a year level from the list.");
  }

  if (!enrollmentStatuses.includes(student.status)) {
    throw new Error("Choose a valid enrollment status.");
  }

  if (!/^[0-9]{11}$/.test(student.contact)) {
    throw new Error("Contact number must be exactly 11 digits.");
  }


  if (editing) {
    student.studentId = editing.studentId;
  } else if (!cloudMode) {
    const usedNumbers = new Set(
      records.map((record) => record.studentId.trim().toLowerCase())
    );
    let number = records.reduce((max, record) => Math.max(max, record.id), 0) + 1;

    while (usedNumbers.has(`sims-${number}`)) {
      number += 1;
    }

    student.studentId = `SIMS-${number}`;
  }

  return student;
}

function cloudError(error) {
  if (error.code === "23505") return "This student ID is already in use, including removed records.";
  if (["23514", "23502", "22003", "22P02"].includes(error.code)) {
    return "The database rejected a field. Review the student information.";
  }
  if (error.code === "SIMS_CONFLICT") return "This record changed. Refresh records and try again.";
  if (error.code === "42501" || [401, 403].includes(error.status)) {
    return "Your session or staff access is unavailable. Sign out and sign in again.";
  }
  return "Could not complete the request. Check your connection and refresh before retrying.";
}

async function runAction(task, onError) {
  if (busy) return;
  busy = true;

  const controls = document.querySelectorAll(
    "button[type='submit'], #sign-out, #refresh-records, #confirm-delete"
  );
  for (const button of controls) button.disabled = true;

  try {
    await task();
  } catch (error) {
    onError(error);
  } finally {
    busy = false;
    for (const button of controls) button.disabled = false;
  }
}

async function refreshRecords() {
  const latest = await cloud.listRecords();
  if (!staff) return;
  records = latest;
  render();
}

async function afterSave(text) {
  try {
    if (cloudMode) await refreshRecords();
  } catch {
    text += " The list could not refresh. Use Refresh records.";
  }
  if (!cloudMode || staff) {
    const confirmation = byId("student-save-confirmation");
    byId("student-confirmation-text").textContent = text;
    message("notice", "");
    if (!confirmation.open) confirmation.showModal();
  }
}

// Match the contact field's typing and paste rules to its save validation.
{
  const contact = form.elements.namedItem("contact");
  const contactInputError = "Contact number accepts up to 11 digits only.";

  function checkContactInsertion(event, inserted) {
    const start = contact.selectionStart ?? contact.value.length;
    const end = contact.selectionEnd ?? start;
    const result = contact.value.slice(0, start) + inserted + contact.value.slice(end);

    if (!/^[0-9]{0,11}$/.test(result)) {
      event.preventDefault();
      message("form-error", contactInputError);
    }
  }

  contact.addEventListener("beforeinput", (event) => {
    if (event.cancelable && event.inputType.startsWith("insert") && event.data !== null) {
      checkContactInsertion(event, event.data);
    }
  });

  contact.addEventListener("paste", (event) => {
    if (event.clipboardData) {
      checkContactInsertion(event, event.clipboardData.getData("text/plain"));
    }
  });

  contact.addEventListener("input", () => {
    if (byId("form-error").textContent === contactInputError) {
      message("form-error", "");
    }
  });
}


form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || (cloudMode && !staff)) return;
  message("form-error", "");

  let student;
  try {
    student = readStudent();
  } catch (error) {
    message("form-error", error.message);
    return;
  }

  const existing = editing;
  runAction(async () => {
    if (cloudMode) {
      await cloud.saveStudent(student, existing);
    } else if (existing) {
      saveDemo(records.map((item) =>
        item.id === existing.id ? { ...item, ...student } : item
      ));
    } else {
      const id = records.reduce((max, item) => Math.max(max, item.id), 0) + 1;
      saveDemo([...records, { ...student, id, clearance: null, deletedAt: null }]);
    }

    byId("editor").close();
    byId("add-student").focus();
    await afterSave(existing ? "Student record updated." : "Student record added.");
  }, (error) => message("form-error", cloudMode ? cloudError(error) : error.message));
});

byId("confirm-delete").addEventListener("click", () => {
  if (!removing || busy || (cloudMode && !staff)) return;
  const student = removing;
  byId("delete-dialog").close();
  byId("add-student").focus();

  runAction(async () => {
    if (cloudMode) {
      await cloud.removeStudent(student);
    } else {
      const deletedAt = new Date().toISOString();
      saveDemo(records.map((item) =>
        item.id === student.id ? { ...item, deletedAt } : item
      ));
    }
    await afterSave("Student record removed from the active list.");
  }, (error) => message("notice", cloudMode ? cloudError(error) : error.message));
});

function clearSession() {
  staff = null;
  records = [];
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  render();
  showPage();
}

async function loadStaffSession() {
  const user = await cloud.staffUser();
  if (!user) return;
  const latest = await cloud.listRecords();
  staff = user;
  records = latest;
  render();
  showPage();
}

async function startCloud() {
  byId("app-mode").textContent = "Supabase";
  showPage();

  const signInButton = authForm.querySelector("button[type='submit']");
  signInButton.disabled = true;

  try {
    cloud = await SimsCloud.connect(config);
  } catch {
    message("auth-error", "Could not connect to Supabase. Check config.js and your internet connection.");
    return;
  }

  cloud.client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") clearSession();
  });

  try {
    await loadStaffSession();
  } catch {
    message("auth-error", "Could not load your session. Try signing in again.");
  } finally {
    signInButton.disabled = false;
  }

  authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = new FormData(authForm);
    message("auth-error", "");
    runAction(async () => {
      await cloud.signIn(
        String(values.get("email")).trim(),
        String(values.get("password"))
      );
      authForm.reset();
      await loadStaffSession();
    }, () => message("auth-error", "Sign-in failed. Check your email, password, and staff access."));
  });

  byId("refresh-records").addEventListener("click", () => {
    runAction(async () => {
      if (!(await cloud.staffUser())) {
        clearSession();
        message("auth-error", "Your session ended. Sign in again.");
        return;
      }
      await refreshRecords();
      if (staff) message("notice", "Student records refreshed.");
    }, (error) => message("notice", cloudError(error)));
  });

  byId("sign-out").addEventListener("click", () => {
    runAction(async () => {
      await cloud.signOut();
      clearSession();
      message("auth-error", "");
    }, (error) => message("notice", cloudError(error)));
  });
}

const clearancePageSize = 10;
let clearancePage = 1;
let previousClearanceQuery = "";
let previousClearanceStatus = "";

const clearanceFilter = document.createElement("select");
clearanceFilter.add(new Option("All statuses", ""));
for (const status of clearanceStatuses) {
  clearanceFilter.add(new Option(status, status));
}

const clearanceFilterLabel = document.createElement("label");
clearanceFilterLabel.textContent = "Clearance status";
clearanceFilterLabel.append(clearanceFilter);
const clearanceSearchInput = byId("clearance-search");
const clearanceSearchBar = clearanceSearchInput.closest(".search");
const clearanceTableCard = clearanceSearchBar.closest(".table-card");
const clearanceSearchLabel = clearanceSearchBar.querySelector("label");

clearanceSearchLabel.textContent = "Search students";
clearanceSearchInput.placeholder = "Student number or name";
clearanceSearchLabel.append(clearanceSearchInput);

clearanceSearchBar.classList.remove("search");
clearanceSearchBar.style.cssText =
  "display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr)); gap:.75rem; margin-block:1rem;";
clearanceSearchBar.append(clearanceFilterLabel);
clearanceTableCard.before(clearanceSearchBar);

clearanceFilter.addEventListener("change", () => {
  location.hash = clearanceFilter.value
    ? `clearance?status=${encodeURIComponent(clearanceFilter.value)}`
    : "clearance";
});

const clearancePager = document.createElement("div");
clearancePager.className = "student-records-pager";
clearancePager.hidden = true;
clearancePager.setAttribute("role", "group");
clearancePager.setAttribute("aria-label", "Library clearance pagination");

const clearancePageSummary = document.createElement("p");
clearancePageSummary.setAttribute("role", "status");

const clearanceButtons = document.createElement("div");
const clearancePrevious = document.createElement("button");
const clearanceNext = document.createElement("button");

for (const [button, label, direction] of [
  [clearancePrevious, "Previous", -1],
  [clearanceNext, "Next", 1],
]) {
  button.type = "button";
  button.className = "secondary";
  button.textContent = label;
  button.addEventListener("click", () => {
    clearancePage += direction;
    renderClearance();
  });
  clearanceButtons.append(button);
}

clearancePager.append(clearancePageSummary, clearanceButtons);
byId("clearance-empty").after(clearancePager);

for (const status of clearanceStatuses) {
  const card = byId(status.replace(" ", "-")).closest("article");
  const link = document.createElement("a");
  link.className = "metric-link";
  link.href = `#clearance?status=${encodeURIComponent(status)}`;
  link.textContent = "View students";
  link.setAttribute("aria-label", `View students with ${status} clearance`);
  link.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    byId("clearance-search").value = "";
    if (location.hash === link.hash) renderClearance();
  });
  card.append(link);
}

window.addEventListener("hashchange", () => {
  showPage();
  renderClearance();
  if (location.hash === "#settings" && !byId("settings").hidden) {
    byId("settings-title").focus();
  }
});
byId("clearance-search").addEventListener("input", renderClearance);
byId("add-student").addEventListener("click", () => {
  if (!busy) openEditor();
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => byId(button.dataset.close).close());
}


// Sign-in background and validation
{
  const loginForm = document.getElementById("sign-in-form");

  if (loginForm) {

    const email = loginForm.elements.namedItem("email");
    const password = loginForm.elements.namedItem("password");
    const loginFields = [email, password];
    const fieldErrors = new Map();

    for (const field of loginFields) {
      const error = document.createElement("span");
      error.id = `login-${field.name}-error`;
      error.className = "login-field-error";
      error.hidden = true;
      field.after(error);
      field.setAttribute("aria-describedby", error.id);
      fieldErrors.set(field, error);

      field.addEventListener("input", () => {
        if (field.validity.valid) showFieldError(field, "");
      });
    }

    function showFieldError(field, message) {
      const error = fieldErrors.get(field);
      error.textContent = message;
      error.hidden = !message;

      if (message) field.setAttribute("aria-invalid", "true");
      else field.removeAttribute("aria-invalid");
    }

    email.spellcheck = false;
    loginForm.noValidate = true;

    loginForm.addEventListener("submit", (event) => {
      document.getElementById("auth-error").hidden = true;

      for (const field of loginFields) showFieldError(field, "");

      const invalidField = loginFields.find((field) => !field.validity.valid);
      if (!invalidField) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const message = invalidField === password
        ? "Enter your password."
        : email.validity.valueMissing
          ? "Enter your email address."
          : "Enter a valid email address.";

      showFieldError(invalidField, message);
      invalidField.focus();
    }, true);
  }
}

// Sinag logo, dashboard clock, and display settings
{
  const sidebar = document.querySelector(".sidebar");
  const brandIcon = sidebar.querySelector(".brand-icon");
  const dashboardHeader = document.querySelector("#dashboard .hero header");
  const signInLogo = document.querySelector("#sign-in .school-seal");


  // Reuse the same logo file that already loads on the sign-in page.
  if (brandIcon && signInLogo) {
    const logo = document.createElement("img");
    logo.className = "sidebar-seal";
    logo.src = signInLogo.src;
    logo.alt = "";
    brandIcon.replaceChildren(logo);
  }

  const clock = document.createElement("time");
  clock.className = "dashboard-clock";
  dashboardHeader.append(clock);

  const settingsKey = "sinag-display-settings-v1";
  const dateFormatter = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let motionEnabled = true;

  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || "{}");
    motionEnabled = saved?.motionEnabled !== false;
  } catch {
    // Use the default settings if browser storage is unavailable.
  }

  let timeFormatter;

  function updateClock() {
    const now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent =
      `${dateFormatter.format(now)} · ${timeFormatter.format(now)}`;
  }

  function applySettings() {
    timeFormatter = new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });

    document.documentElement.dataset.sinagMotion =
      motionEnabled ? "on" : "off";

    updateClock();
  }

  const settingsForm = byId("display-settings-form");
  const motion = settingsForm.elements.namedItem("motion");
  const settingsMessage = byId("settings-message");

  motion.checked = motionEnabled;

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    motionEnabled = motion.checked;
    applySettings();

    try {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({ motionEnabled })
      );
      message("settings-message", "Display preferences saved.");
    } catch {
      message("settings-message", "Applied for now. This browser could not save your settings.");
    }
  });

  applySettings();
  window.setInterval(updateClock, 1000);
}

// White sidebar, module icons, and dashboard branding
{
  const sidebar = document.querySelector(".sidebar");
  const dashboardHeader = document.querySelector("#dashboard .hero header");
  const subtitle = sidebar.querySelector(".brand small");
  const sidebarFooter = sidebar.querySelector(".demo");
  const settings = sidebar.querySelector(".settings-button");

  if (subtitle && dashboardHeader) {
    subtitle.classList.add("dashboard-system-name");
    dashboardHeader.prepend(subtitle);
  }

  if (settings && sidebarFooter) {
    sidebarFooter.prepend(settings);
  }


}

// Restore the navy sidebar and update its icons.
{
  const sidebar = document.querySelector(".sidebar");
  const iconPaths = {
    dashboard:
      '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1"/>' +
      '<rect x="14" y="14" width="7" height="7" rx="1"/>',
    students:
      '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
      '<circle cx="8.5" cy="10" r="1.5"/>' +
      '<path d="M6 15c.5-2 4.5-2 5 0m3-5h4m-4 4h4"/>',
    clearance:
      '<path d="M7 3h8l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>' +
      '<path d="M14 3v5h5m-10 6 2 2 4-4"/>',
    refresh:
      '<path d="M20 7v5h-5M4 17v-5h5"/>' +
      '<path d="M6.1 7a7 7 0 0 1 11.7-1L20 9M4 15l2.2 3A7 7 0 0 0 18 17"/>',
    settings:
      '<path d="M4 6h5m4 0h7M4 12h9m4 0h3M4 18h2m4 0h10"/>' +
      '<circle cx="11" cy="6" r="2"/>' +
      '<circle cx="15" cy="12" r="2"/>' +
      '<circle cx="8" cy="18" r="2"/>',
    signOut:
      '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5"/>' +
      '<path d="M9 12h11m-4-4 4 4-4 4"/>',
  };

  function addSidebarIcon(control, iconName) {
    if (!control) return;

    const icon = document.createElement("span");
    icon.className = "sidebar-action-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
           focusable="false">
        ${iconPaths[iconName]}
      </svg>
    `;

    const oldIcon = control.querySelector(".sidebar-module-icon");
    if (oldIcon) oldIcon.replaceWith(icon);
    else control.prepend(icon);
  }

  for (const link of sidebar.querySelectorAll("nav [data-page]")) {
    if (iconPaths[link.dataset.page]) {
      addSidebarIcon(link, link.dataset.page);
    }
  }

  const refresh = sidebar.querySelector("#refresh-records");
  const settings = sidebar.querySelector(".settings-button");
  const signOut = sidebar.querySelector("#sign-out");
  const cloudControls = sidebar.querySelector("#cloud-controls");

  addSidebarIcon(refresh, "refresh");
  addSidebarIcon(settings, "settings");
  addSidebarIcon(signOut, "signOut");

  // Keep keyboard navigation in the same order as the buttons on screen.
  if (cloudControls && settings && signOut) {
    if (window.SIMS_CONFIG?.supabaseUrl || window.SIMS_CONFIG?.supabasePublishableKey) {
      cloudControls.insertBefore(settings, signOut);
    }
  }

}

// Automatically sync student records and library clearance.
{
  if (cloudMode) {
    const refreshButton = document.getElementById("refresh-records");
    if (refreshButton) refreshButton.hidden = true;

    async function syncStudentRecords() {
      if (
        !staff ||
        !cloud ||
        busy ||
        document.hidden ||
        document.querySelector("dialog[open]")
      ) {
        return;
      }

      const currentSession = staff;
      const currentRecords = records;

      try {
        const latestRecords = await cloud.listRecords();

        // Skip a response if a save or sign-out happened while it was loading.
        if (staff !== currentSession || records !== currentRecords || busy) {
          return;
        }

        if (JSON.stringify(latestRecords) !== JSON.stringify(currentRecords)) {
          records = latestRecords;
          render();
        }
      } catch {
        // Keep showing the last loaded records. The next check will retry.
      }
    }

    let syncInProgress = false;

    async function checkForRecordUpdates() {
      if (syncInProgress) return;
      syncInProgress = true;

      try {
        await syncStudentRecords();
      } finally {
        syncInProgress = false;
      }
    }

    window.setInterval(checkForRecordUpdates, 15000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkForRecordUpdates();
    });
  }
}

// Change password for the signed-in admin.
{
  const changeButton = byId("change-password");
  const passwordDialog = byId("change-password-dialog");

  if (changeButton && passwordDialog) {

    const passwordForm = passwordDialog.querySelector("form");
    const errorMessage = passwordForm.querySelector(".error");
    const successMessage = passwordForm.querySelector(".password-success");
    const submitButton = passwordForm.querySelector('[type="submit"]');
    const closeButton = passwordForm.querySelector("[data-close-password]");
    let savingPassword = false;

    function showPasswordError(text) {
      errorMessage.textContent = text;
      errorMessage.hidden = !text;
    }

    changeButton.addEventListener("click", () => {
      if (!staff?.email || !cloud) return;

      passwordForm.reset();
      showPasswordError("");
      successMessage.hidden = true;
      submitButton.hidden = false;
      passwordDialog.showModal();
    });

    closeButton.addEventListener("click", () => passwordDialog.close());

    passwordDialog.addEventListener("cancel", (event) => {
      if (savingPassword) event.preventDefault();
    });

    passwordDialog.addEventListener("close", () => passwordForm.reset());

    passwordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (savingPassword) return;

      const email = staff?.email;
      const fields = new FormData(passwordForm);
      const currentPassword = fields.get("currentPassword");
      const newPassword = fields.get("newPassword");
      const confirmPassword = fields.get("confirmPassword");
      showPasswordError("");

      if (!email || !cloud) {
        showPasswordError("Your session ended. Sign in again.");
        return;
      }

      if (newPassword !== confirmPassword) {
        showPasswordError("The new passwords do not match.");
        passwordForm.elements.namedItem("confirmPassword").focus();
        return;
      }

      if (newPassword === currentPassword) {
        showPasswordError("Choose a different new password.");
        return;
      }

      savingPassword = true;
      submitButton.disabled = true;
      closeButton.disabled = true;

      try {
        await cloud.signIn(email, currentPassword);

        const { error } = await cloud.client.auth.updateUser({
          password: newPassword,
        });

        if (error) throw error;

        passwordForm.reset();
        submitButton.hidden = true;
        successMessage.textContent =
          "Password updated. Use the new password the next time you sign in.";
        successMessage.hidden = false;
        closeButton.focus();
      } catch (error) {
        if (error.code === "invalid_credentials") {
          showPasswordError("The current password is incorrect.");
        } else if (error.code === "weak_password") {
          showPasswordError("Choose a stronger password.");
        } else {
          showPasswordError(
            "Could not update your password. Try signing in again before retrying."
          );
        }
      } finally {
        savingPassword = false;
        submitButton.disabled = false;
        closeButton.disabled = false;
      }
    });
  }
}

// Student records pagination and display preference.
{
  const studentRows = document.getElementById("student-rows");
  const tableCard = studentRows?.closest(".table-card");
  const pager = tableCard?.querySelector(".student-records-pager");

  if (studentRows && pager) {
    const storageKey = "sinag-student-rows-per-page";
    const pageSizes = [10, 25, 50];
    let rowsPerPage = 10;
    let page = 1;

    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (pageSizes.includes(saved)) rowsPerPage = saved;
    } catch {
      // Use the default when browser storage is unavailable.
    }

    const pageSizeSelect = pager.querySelector("[name=studentRowsPerPage]");
    pageSizeSelect.value = String(rowsPerPage);

    const summary = pager.querySelector("[data-page-summary]");
    const previous = pager.querySelector("[data-previous]");
    const next = pager.querySelector("[data-next]");

    function showPageOfStudents() {
      const rows = Array.from(studentRows.rows);
      const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
      page = Math.min(page, pageCount);

      const start = (page - 1) * rowsPerPage;
      const end = Math.min(start + rowsPerPage, rows.length);

      rows.forEach((row, index) => {
        row.hidden = index < start || index >= end;
      });

      pager.hidden = rows.length === 0;
      summary.textContent = rows.length
        ? `Showing ${start + 1}–${end} of ${rows.length} students`
        : "";

      previous.disabled = page <= 1;
      next.disabled = page >= pageCount;
    }

    previous.addEventListener("click", () => {
      if (page > 1) {
        page -= 1;
        showPageOfStudents();
      }
    });

    next.addEventListener("click", () => {
      if (!next.disabled) {
        page += 1;
        showPageOfStudents();
      }
    });

    pageSizeSelect.addEventListener("change", () => {
      const selected = Number(pageSizeSelect.value);
      if (!pageSizes.includes(selected)) return;

      if (selected !== rowsPerPage) {
        rowsPerPage = selected;
        page = 1;
        showPageOfStudents();
      }

      try {
        localStorage.setItem(storageKey, String(rowsPerPage));
      } catch {
        // Keep the selection for this tab even if it cannot be saved.
      }
    });
    for (const id of [
      "student-search",
      "student-course-filter",
      "student-year-filter",
      "student-status-filter",
    ]) {
      const control = byId(id);
      control?.addEventListener(id === "student-search" ? "input" : "change", () => {
        page = 1;
        renderStudentRecords();
      });
    }
    // Reapply pagination after an add, edit, remove, or automatic sync.
    new MutationObserver(showPageOfStudents).observe(studentRows, {
      childList: true,
    });

    showPageOfStudents();
  }
}
const enrollmentForm = byId("enrollment-form");
const enrollmentSubmit = enrollmentForm?.querySelector("button[type=submit]");
let enrollmentRequest = 0;
let savingEnrollment = false;

async function loadEnrollments() {
  if (!enrollmentForm) return;

  const select = enrollmentForm.elements.student;
  const selected = select.value;
  const students = activeStudents();
  const studentsById = new Map(students.map((student) => [String(student.id), student]));

  select.replaceChildren(new Option("Select student", ""));
  for (const [id, student] of studentsById) {
    select.add(new Option(`${student.studentId} · ${student.name}`, id));
  }
  if (studentsById.has(selected)) select.value = selected;
  enrollmentSubmit.disabled = !staff || !students.length || savingEnrollment;

  if (!staff) {
    message("enrollment-message", "Sign in to save enrollments.");
    return;
  }

  const session = staff;
  const request = ++enrollmentRequest;
  const rows = [];
  const pageSize = 100;

  try {
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await cloud.client.from("student_enrollments")
        .select("id,student_record_id,school_year,semester,year_level,subjects,subject_details")
        .order("id", { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (session !== staff || request !== enrollmentRequest) return;
      if (error) throw error;

      rows.push(...data);
      if (data.length < pageSize) break;
    }

    byId("enrollment-rows").replaceChildren(...rows.map((enrollment) => {
      const row = document.createElement("tr");
      const student = studentsById.get(String(enrollment.student_record_id));
      const label = student ? `${student.studentId} · ${student.name}` : "Inactive student";
      const year = enrollmentForm.elements.year.options[enrollment.year_level].text;

      for (const value of [
        label,
        enrollment.school_year,
        enrollment.semester,
        year,
        enrollment.subjects.join(", "),
      ]) {
        row.insertCell().textContent = value;
      }
            const view = document.createElement("button");
      view.type = "button";
      view.className = "secondary";
      view.textContent = "View";
      view.addEventListener("click", () => viewEnrolledSubjects(enrollment, label, year));
      row.insertCell().append(view);
      return row;
    }));
  } catch (error) {
    if (session === staff && request === enrollmentRequest) {
      message("enrollment-message", cloudError(error));
    }
  }
}

enrollmentForm?.elements.student.addEventListener("change", () => {
  const id = enrollmentForm.elements.student.value;
  const student = activeStudents().find((item) => String(item.id) === id);
  enrollmentForm.elements.year.value = student ? String(student.year) : "";
});

const sampleCurriculum = {
  IT: [
    ["Introduction to Computing", "Computer Programming 1"],
    ["Computer Programming 2", "Discrete Mathematics"],
    ["Data Structures and Algorithms", "Object-Oriented Programming"],
    ["Information Management", "Networking 1"],
    ["Web Development", "Networking 2"],
    ["Mobile App Development", "Information Assurance"],
    ["Capstone Project 1", "Systems Administration and Maintenance"],
    ["Capstone Project 2", "IT Internship"],
  ],
  CS: [
    ["Introduction to Computing", "Computer Programming 1"],
    ["Computer Programming 2", "Discrete Mathematics"],
    ["Data Structures and Algorithms", "Computer Organization"],
    ["Design and Analysis of Algorithms", "Database Systems"],
    ["Operating Systems", "Theory of Computation"],
    ["Artificial Intelligence", "Software Engineering"],
    ["Computer Science Thesis 1", "Distributed Computing"],
    ["Computer Science Thesis 2", "CS Internship"],
  ],
  HM: [
    ["Introduction to Hospitality", "Food Safety and Sanitation"],
    ["Culinary Fundamentals", "Food and Beverage Service"],
    ["Front Office Operations", "Housekeeping Operations"],
    ["Baking and Pastry", "Hospitality Marketing"],
    ["Event Management", "Cost Control"],
    ["Restaurant Operations", "Hospitality Entrepreneurship"],
    ["Hospitality Research", "Hotel Operations Management"],
    ["Hospitality Practicum", "Hospitality Strategic Management"],
  ],
  Psych: [
    ["Introduction to Psychology", "Understanding the Self"],
    ["Developmental Psychology", "Psychological Statistics"],
    ["Social Psychology", "Personality Theories"],
    ["Experimental Psychology", "Research Methods"],
    ["Abnormal Psychology", "Psychological Assessment"],
    ["Industrial Psychology", "Cognitive Psychology"],
    ["Psychology Research 1", "Counseling Psychology"],
    ["Psychology Research 2", "Psychology Practicum"],
  ],
  "Civil Engineering": [
    ["Engineering Drawing", "Calculus 1"],
    ["Calculus 2", "Physics for Engineers"],
    ["Engineering Mechanics", "Surveying"],
    ["Mechanics of Materials", "Construction Materials"],
    ["Structural Analysis", "Geotechnical Engineering"],
    ["Hydraulics", "Reinforced Concrete Design"],
    ["Steel Design", "Construction Project Management"],
    ["Civil Engineering Design Project", "Civil Engineering Practicum"],
  ],
};

if (enrollmentForm) {
  const { student, year, semester, subjects } = enrollmentForm.elements;
  const selectedSubjects = [];
  const subjectsLabel = subjects.closest("label");
  subjectsLabel.hidden = true;
  subjects.required = false;

  const picker = document.createElement("div");
  picker.style.marginTop = "1rem";
  picker.innerHTML = `
    <label>Subject
      <select data-subject></select>
    </label>
    <label data-other-label hidden>Other subject
      <input type="text" data-other maxlength="120">
    </label>
    <button type="button" class="secondary" data-add>Add subject</button>
    <p role="status" data-subject-message></p>
    <ul aria-label="Selected subjects" data-selected></ul>
  `;
  subjectsLabel.after(picker);

  const subjectSelect = picker.querySelector("[data-subject]");
  const otherLabel = picker.querySelector("[data-other-label]");
  const otherInput = picker.querySelector("[data-other]");
  const subjectMessage = picker.querySelector("[data-subject-message]");
  const selectedList = picker.querySelector("[data-selected]");
  const addSubject = picker.querySelector("[data-add]");

  function renderSelectedSubjects() {
    subjects.value = selectedSubjects.join("\n");
    selectedList.replaceChildren();

    for (const [index, title] of selectedSubjects.entries()) {
      const item = document.createElement("li");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${title}`);
      remove.addEventListener("click", () => {
        selectedSubjects.splice(index, 1);
        renderSelectedSubjects();
      });
      item.append(title, " ", remove);
      selectedList.append(item);
    }
  }

  function loadSubjectOptions() {
    const record = activeStudents().find((item) => String(item.id) === student.value);
    const ready = Boolean(record && year.value && semester.value);
    const term = ["First Semester", "Second Semester"].indexOf(semester.value);
    const course = record ? savedCourseOption(record.course) : "";
    const index = (Number(year.value) - 1) * 2 + term;
    const options = ready && term >= 0 ? sampleCurriculum[course]?.[index] ?? [] : [];

    subjectSelect.replaceChildren(new Option("Select subject", ""));
    for (const title of options) subjectSelect.add(new Option(title, title));
    if (ready) subjectSelect.add(new Option("Other…", "__other__"));

    subjectSelect.disabled = !ready;
    addSubject.disabled = !ready;
    otherLabel.hidden = true;
    otherInput.value = "";
    selectedSubjects.length = 0;
    renderSelectedSubjects();

    subjectMessage.textContent = ready && !options.length
      ? "No sample subjects for this term. Select Other… to enter one."
      : "";
  }

  for (const field of [student, year, semester]) {
    field.addEventListener("change", loadSubjectOptions);
  }

  subjectSelect.addEventListener("change", () => {
    otherLabel.hidden = subjectSelect.value !== "__other__";
    if (!otherLabel.hidden) otherInput.focus();
  });

  addSubject.addEventListener("click", () => {
    const title = subjectSelect.value === "__other__"
      ? otherInput.value.trim()
      : subjectSelect.value;

    if (!title) {
      subjectMessage.textContent = "Choose or enter a subject first.";
      return;
    }
    if (selectedSubjects.some((item) => item.toLowerCase() === title.toLowerCase())) {
      subjectMessage.textContent = "That subject is already on the list.";
      return;
    }
    if (selectedSubjects.length >= 15) {
      subjectMessage.textContent = "You can add up to 15 subjects.";
      return;
    }

    selectedSubjects.push(title);
    renderSelectedSubjects();
    subjectMessage.textContent = "";
    subjectSelect.value = "";
    otherInput.value = "";
    otherLabel.hidden = true;
  });

  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "add-enrollment-title");
  dialog.innerHTML = `<h2 id="add-enrollment-title">Add Enrollment</h2>`;
  enrollmentForm.before(dialog);

  const notice = byId("enrollment-message");
  enrollmentForm.append(notice);
  dialog.append(enrollmentForm);

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "Add Enrollment";
  byId("enrollment").querySelector(".page-header").append(openButton);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  enrollmentForm.querySelector(".actions").prepend(cancel);

  openButton.addEventListener("click", () => {
    loadSubjectOptions();
        const dateParts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "numeric",
    }).formatToParts(new Date());

    const year = Number(dateParts.find((part) => part.type === "year").value);
    const month = Number(dateParts.find((part) => part.type === "month").value);
    const schoolYearStartMonth = 8; // August
    const startYear = month >= schoolYearStartMonth ? year : year - 1;

    const schoolYearInput = enrollmentForm.elements.namedItem("schoolYear");
    schoolYearInput.value = `${startYear}-${startYear + 1}`;
    schoolYearInput.readOnly = true;
    dialog.showModal();
  });
  cancel.addEventListener("click", () => dialog.close());

  enrollmentForm.addEventListener("reset", () => {
    queueMicrotask(() => {
      loadSubjectOptions();
      if (dialog.open) dialog.close();
    });
  });

  loadSubjectOptions();
}
const subjectDetailsByTitle = new Map();

function viewEnrolledSubjects(enrollment, student, year) {
  const record = activeStudents().find(
    (item) => String(item.id) === String(enrollment.student_record_id)
  );
  const details = enrollment.subject_details
    ?? enrollment.subjects.map((title) => ({ title }));
  const sections = [...new Set(details.map((subject) => subject.section).filter(Boolean))];

  const dialog = document.createElement("dialog");
  dialog.style.width = "min(72rem, calc(100% - 2rem))";
  dialog.setAttribute("aria-labelledby", "enrollment-report-title");
  dialog.innerHTML = `
    <h2 id="enrollment-report-title">Enrollment Details</h2>

    <section aria-labelledby="report-student-title">
      <h3 id="report-student-title">Student Information</h3>
      <div class="table-card">
        <div class="table-scroll">
          <table aria-labelledby="report-student-title">
            <thead><tr>
              <th scope="col">Student Number</th>
              <th scope="col">Student Name</th>
              <th scope="col">School Year</th>
              <th scope="col">Semester</th>
              <th scope="col">Course</th>
              <th scope="col">Year Level</th>
              <th scope="col">Section</th>
            </tr></thead>
            <tbody data-student-info></tbody>
          </table>
        </div>
      </div>
    </section>

    <section aria-labelledby="report-subjects-title" style="margin-top:1.25rem">
      <h3 id="report-subjects-title">Enrolled Subjects</h3>
      <div class="table-card">
        <div class="table-scroll">
          <table aria-labelledby="report-subjects-title">
            <thead><tr>
              <th scope="col">Course Code</th>
              <th scope="col">Course Title</th>
              <th scope="col">Units</th>
              <th scope="col">Section</th>
              <th scope="col">Instructor</th>
            </tr></thead>
            <tbody data-enrolled-subjects></tbody>
          </table>
        </div>
      </div>
      <p data-total-units style="margin-top:.75rem;text-align:right;font-weight:700"></p>
    </section>

    <form method="dialog" class="actions">
      <button type="submit" class="secondary">Close</button>
    </form>
  `;

  const infoRow = dialog.querySelector("[data-student-info]").insertRow();
  for (const value of [
    record?.studentId,
    record?.name ?? student,
    enrollment.school_year,
    enrollment.semester,
    record ? studentFieldLabel(record, "course") : null,
    year,
    sections.join(", "),
  ]) {
    infoRow.insertCell().textContent = value || "—";
  }

  const subjectBody = dialog.querySelector("[data-enrolled-subjects]");
  for (const subject of details) {
    const row = subjectBody.insertRow();
    const units = Number.isFinite(subject.units) ? subject.units.toFixed(2) : "—";
    for (const value of [subject.code, subject.title, units, subject.section, subject.instructor]) {
      row.insertCell().textContent = value ?? "—";
    }
  }

  const hasCompleteUnits = details.length > 0
    && details.every((subject) => Number.isFinite(subject.units));
  const total = details.reduce((sum, subject) => sum + (subject.units ?? 0), 0);
  dialog.querySelector("[data-total-units]").textContent = hasCompleteUnits
    ? `Total Units: ${total.toFixed(2)}`
    : "Total Units: Not recorded";

  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

if (enrollmentForm) {
  const header = byId("enrollment-rows").closest("table").tHead.rows[0];
  const actionsHeading = document.createElement("th");
  actionsHeading.scope = "col";
  actionsHeading.textContent = "Actions";
  header.append(actionsHeading);

  const picker = enrollmentForm.querySelector("[data-subject]").closest("div");
  const subjectSelect = picker.querySelector("[data-subject]");
  const addSubject = picker.querySelector("[data-add]");
  const fields = document.createElement("div");
  fields.className = "fields";
  fields.hidden = true;
  fields.style.marginBlock = ".75rem";
  fields.innerHTML = `
    <label>Course Code <input data-code maxlength="30"></label>
    <label>Units <input type="number" data-units min="0" max="12" step="0.5"></label>
    <label>Section <input data-section maxlength="40"></label>
    <label>Instructor <input data-instructor maxlength="120"></label>
  `;
  addSubject.before(fields);

  const code = fields.querySelector("[data-code]");
  const units = fields.querySelector("[data-units]");
  const section = fields.querySelector("[data-section]");
  const instructor = fields.querySelector("[data-instructor]");
  const termFields = enrollmentForm.elements;

  subjectSelect.addEventListener("change", () => {
    fields.hidden = !subjectSelect.value;
    const sample = subjectSelect.value && subjectSelect.value !== "__other__";
    const student = activeStudents().find(
      (record) => String(record.id) === termFields.student.value
    );
    const course = student ? savedCourseOption(student.course) : "";
    const prefix = course === "Civil Engineering" ? "CE" : course.toUpperCase();
    const semester = termFields.semester.value === "First Semester" ? 1 : 2;
    code.value = sample ? `${prefix}${termFields.year.value}${semester}${subjectSelect.selectedIndex}` : "";
    units.value = sample ? "3" : "";
    section.value = sample ? `${prefix}-${termFields.year.value}A` : "";
    instructor.value = sample ? "Prof. Alex Reyes (Sample)" : "";
  });

  addSubject.addEventListener("click", (event) => {
    const title = subjectSelect.value === "__other__"
      ? picker.querySelector("[data-other]").value.trim()
      : subjectSelect.value;
    if (!title) return;

    if (!code.value.trim() || !Number.isFinite(units.valueAsNumber) ||
        !units.checkValidity() || !section.value.trim() || !instructor.value.trim()) {
      event.stopImmediatePropagation();
      picker.querySelector("[data-subject-message]").textContent =
        "Enter a course code, units, section, and instructor.";
      return;
    }

    const details = {
      code: code.value.trim(),
      title,
      units: units.valueAsNumber,
      section: section.value.trim(),
      instructor: instructor.value.trim(),
    };

    queueMicrotask(() => {
      if (subjectSelect.value === "") {
        subjectDetailsByTitle.set(title, details);
        fields.hidden = true;
        units.value = "";
      }
    });
  }, true);

  for (const field of [termFields.student, termFields.year, termFields.semester]) {
    field.addEventListener("change", () => {
      fields.hidden = true;
      units.value = "";
      subjectDetailsByTitle.clear();
    });
  }
  enrollmentForm.addEventListener("reset", () => {
    fields.hidden = true;
    subjectDetailsByTitle.clear();
  });
}
enrollmentForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!staff || savingEnrollment) return;

  const session = staff;
  const values = new FormData(enrollmentForm);
  const schoolYear = String(values.get("schoolYear")).trim();
  const [start, end] = schoolYear.split("-").map(Number);
  const subjects = String(values.get("subjects")).split(/\r?\n/)
    .map((subject) => subject.trim()).filter(Boolean);

  if (!/^\d{4}-\d{4}$/.test(schoolYear) || end !== start + 1) {
    message("enrollment-message", "Enter consecutive school years, such as 2026-2027.");
    return;
  }
  if (!subjects.length || subjects.length > 15 ||
      subjects.some((subject) => subject.length > 120) ||
      new Set(subjects.map((subject) => subject.toLowerCase())).size !== subjects.length) {
    message("enrollment-message", "Enter 1–15 unique subjects, up to 120 characters each.");
    return;
  }

  savingEnrollment = true;
  enrollmentSubmit.disabled = true;

  try {
    const { error } = await cloud.client.from("student_enrollments").insert({
      student_record_id: values.get("student"),
      school_year: schoolYear,
      semester: values.get("semester"),
      year_level: Number(values.get("year")),
      subjects,
      subject_details: subjects.map((title) => subjectDetailsByTitle.get(title) ?? { title }),
    });

    if (session !== staff) return;
    if (error) throw error;

    enrollmentForm.reset();
    message("enrollment-message", "Enrollment saved.");
    await loadEnrollments();
  } catch (error) {
    if (session === staff) {
      message("enrollment-message", error.code === "23505"
        ? "This student is already enrolled for that school year and semester."
        : cloudError(error));
    }
  } finally {
    savingEnrollment = false;
    enrollmentSubmit.disabled = !staff || !activeStudents().length;
  }
});
if (cloudMode) {
  startCloud();
} else {
  records = loadDemo();
  showPage();
  render();
}


// Data privacy acknowledgement on sign-in.
{
  const login = document.getElementById("sign-in-form");
  const agreement = document.getElementById("privacy-agreement");
  const error = document.getElementById("privacy-agreement-error");
  const policy = document.getElementById("privacy-policy-dialog");

  document.getElementById("open-privacy-policy").addEventListener("click", () => {
    policy.showModal();
  });

  function clearPrivacyError() {
    agreement.removeAttribute("aria-invalid");
    error.textContent = "";
    error.hidden = true;
  }

  agreement.addEventListener("change", clearPrivacyError);
  login.addEventListener("reset", clearPrivacyError);

  login.addEventListener("submit", (event) => {
    if (agreement.checked) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    agreement.setAttribute("aria-invalid", "true");
    error.textContent = "Agree to the Data Privacy Policy before signing in.";
    error.hidden = false;
    agreement.focus();
  }, true);
}

// Show or hide the password on the sign-in form.
{
  const password = document.getElementById("login-password");
  const toggle = document.getElementById("toggle-login-password");

  function setPasswordVisibility(visible) {
    password.type = visible ? "text" : "password";
    const label = visible ? "Hide password" : "Show password";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.dataset.visible = String(visible);
  }

  toggle.addEventListener("click", () => {
    setPasswordVisibility(password.type === "password");
  });

  password.form.addEventListener("reset", () => setPasswordVisibility(false));
}
