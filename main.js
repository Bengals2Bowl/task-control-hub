const {
  Plugin,
  ItemView,
  Setting,
  MarkdownView,
  TFile,
  PluginSettingTab,
  MarkdownRenderer,
} = require("obsidian");

const VIEW_TYPE_TASK_HUB = "task-control-hub-view";

class TaskControlHubPlugin extends Plugin {
  async onload() {
    console.log("Task Control Hub: loading");

    this.settings = {
      showFilePath: true,
      showDueOnly: false,
    };

    const saved = await this.loadData();
    if (saved) {
      this.settings = Object.assign(this.settings, saved);
    }

    this.registerView(
      VIEW_TYPE_TASK_HUB,
      (leaf) => new TaskControlHubView(leaf, this),
    );

    // Ribbon icon
    this.addRibbonIcon("check-square", "Open Task Control Hub", () => {
      this.activateRightSidebarView();
    });

    // Commands
    this.addCommand({
      id: "open-task-control-hub",
      name: "Open Task Control Hub",
      callback: () => this.activateRightSidebarView(),
    });

    this.addCommand({
      id: "open-task-control-hub-main",
      name: "Open Task Control Hub in main pane",
      callback: () => this.activateMainView(),
    });

    // Manual metadata append command
    this.addCommand({
      id: "task-control-hub-append-metadata",
      name: "Append @due, @person, @project to current task",
      editorCallback: (editor, view) => {
        this.appendMetadataToCurrentTask(editor);
      },
    });

    this.addSettingTab(new TaskControlHubSettingTab(this.app, this));

    // Refresh when vault changes
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.refreshViews();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.refreshViews();
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.refreshViews();
        }
      }),
    );
  }

  onunload() {
    console.log("Task Control Hub: unloading");
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK_HUB);
  }

  async activateRightSidebarView() {
    const { workspace } = this.app;

    let leaf = null;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_TASK_HUB);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        const active = workspace.getMostRecentLeaf();
        if (active && active.splitRight) {
          leaf = active.splitRight();
        } else {
          leaf = workspace.getLeaf(true);
        }
      }
      await leaf.setViewState({ type: VIEW_TYPE_TASK_HUB, active: true });
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async activateMainView() {
    const { workspace } = this.app;
    const leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_TASK_HUB, active: true });
    workspace.revealLeaf(leaf);
  }

  refreshViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_HUB);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof TaskControlHubView) {
        view.refresh();
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshViews();
  }

  // ---------- Task metadata helper (manual) ----------

  appendMetadataToCurrentTask(editor) {
    if (!editor) return;

    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);

    const taskPattern = /^\s*[-*]\s+\[\s\]\s+(.+)$/;
    const match = taskPattern.exec(line);
    if (!match) return;

    // Avoid double-append
    if (
      line.includes("@due(") ||
      line.includes("@person(") ||
      line.includes("@project(")
    ) {
      return;
    }

    const newLine = line + " @due() @person([[ ]]) @project([[ ]])";
    editor.replaceRange(
      newLine,
      { line: cursor.line, ch: 0 },
      { line: cursor.line, ch: line.length },
    );
  }
}

class TaskControlHubView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;

    this.tasks = [];
    this.isRefreshing = false;

    this.filterStatus = "All";
    this.filterPriority = "All";
    this.sortBy = "Due";
    this.quickFilter = "all"; // all | today | week | overdue
  }

  getViewType() {
    return VIEW_TYPE_TASK_HUB;
  }

  getDisplayText() {
    return "Task Control Hub";
  }

  getIcon() {
    return "check-square";
  }

  async onOpen() {
    const { containerEl } = this;
    containerEl.empty();

    this.rootEl = containerEl.createDiv("task-control-hub-root");

    this.headerEl = this.rootEl.createDiv("task-control-hub-header");
    this.controlsEl = this.rootEl.createDiv("task-control-hub-controls");
    this.listEl = this.rootEl.createDiv("task-control-hub-list");

    this.buildHeader();
    this.buildControls();

    this.listEl.setText("Scanning vault for open tasks…");
    await this.loadTasks();
    this.renderTasks();
  }

  onClose() {}

  buildHeader() {
    this.headerEl.empty();

    const titleWrap = this.headerEl.createDiv("task-control-hub-title-wrap");
    titleWrap.createEl("h4", { text: "Task Control Hub" });
    this.countEl = titleWrap.createSpan({ text: "" });
    this.countEl.addClass("task-control-hub-count");
  }

  buildControls() {
    this.controlsEl.empty();

    // Top row: Status + Priority
    const rowTop = this.controlsEl.createDiv("task-control-hub-control-row");

    rowTop.createSpan({ text: "Status: " });
    const statusSelect = rowTop.createEl("select");
    ["All", "Open", "In Progress", "Complete", "Canceled"].forEach((s) => {
      const opt = statusSelect.createEl("option", { text: s, value: s });
      if (s === this.filterStatus) opt.selected = true;
    });
    statusSelect.onchange = (evt) => {
      this.filterStatus = evt.target.value;
      this.renderTasks();
    };

    rowTop.createSpan({ text: "  Priority: " });
    const prioritySelect = rowTop.createEl("select");
    ["All", "High", "Medium", "Low"].forEach((p) => {
      const opt = prioritySelect.createEl("option", { text: p, value: p });
      if (p === this.filterPriority) opt.selected = true;
    });
    prioritySelect.onchange = (evt) => {
      this.filterPriority = evt.target.value;
      this.renderTasks();
    };

    // Second row: Sort by
    const rowBottom = this.controlsEl.createDiv("task-control-hub-control-row");

    rowBottom.createSpan({ text: "Sort by: " });
    const sortSelect = rowBottom.createEl("select");
    const sortOptions = [
      ["Created", "Created Date"],
      ["Due", "Due Date"],
      ["Priority", "Priority"],
      ["Status", "Status"],
    ];
    for (const [value, label] of sortOptions) {
      const opt = sortSelect.createEl("option", { text: label, value });
      if (value === this.sortBy) opt.selected = true;
    }
    sortSelect.onchange = (evt) => {
      this.sortBy = evt.target.value;
      this.renderTasks();
    };

    // Third row: quick due filters
    const rowQuick = this.controlsEl.createDiv("task-control-hub-control-row");
    rowQuick.createSpan({ text: "Due: " });

    const quickOptions = [
      ["all", "All"],
      ["today", "Today"],
      ["week", "This Week"],
      ["overdue", "Overdue"],
    ];

    quickOptions.forEach(([value, label]) => {
      const btn = rowQuick.createEl("button", {
        text: label,
      });
      btn.addClass("task-control-hub-chip");
      if (this.quickFilter === value) {
        btn.addClass("is-active");
      }
      btn.onclick = () => {
        this.quickFilter = value;
        this.buildControls(); // refresh chip active states
        this.renderTasks();
      };
    });
  }

  async refresh() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      await this.loadTasks();
      this.renderTasks();
    } finally {
      this.isRefreshing = false;
    }
  }

  async loadTasks() {
    const files = this.app.vault.getMarkdownFiles();
    const allTasks = [];
    const taskRegex = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;

    for (const file of files) {
      let content;
      try {
        content = await this.app.vault.read(file);
      } catch (e) {
        continue;
      }
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = taskRegex.exec(line);
        if (!m) continue;

        const checked = m[1].toLowerCase() === "x";
        const body = m[2].trim();

        const parsed = this.parseTaskLine(body);
        const status = parsed.status || (checked ? "Complete" : "Open");
        const priority = parsed.priority || "Medium";

        allTasks.push({
          filePath: file.path,
          lineNumber: i + 1,
          rawLine: line,
          checked,
          text: parsed.text,
          created: parsed.created || null,
          due: parsed.due || null,
          closed: parsed.closed || null,
          status,
          priority,
          project: parsed.project || null,
          people: parsed.people || [],
        });
      }
    }

    this.tasks = allTasks;
  }

  parseTaskLine(body) {
    const tokenRegex = /@(\w+)\(([^)]*)\)/g;
    const out = {
      text: body,
      created: null,
      due: null,
      closed: null,
      status: null,
      priority: null,
      project: null,
      people: [],
    };

    let match;
    let cleanText = body;
    while ((match = tokenRegex.exec(body)) !== null) {
      const key = match[1];
      const value = match[2];

      switch (key) {
        case "created":
          out.created = value;
          break;
        case "due":
          out.due = value;
          break;
        case "closed":
          out.closed = value;
          break;
        case "status":
          out.status = value;
          break;
        case "priority":
          out.priority = value;
          break;
        case "project":
          out.project = value;
          break;
        case "person":
          out.people.push(value);
          break;
      }
    }

    cleanText = cleanText.replace(tokenRegex, "").trim();
    out.text = cleanText;

    return out;
  }

  buildTaskBodyFromParsed(parsed) {
    const parts = [];

    if (parsed.text) parts.push(parsed.text);
    if (parsed.created) parts.push(`@created(${parsed.created})`);
    if (parsed.due) parts.push(`@due(${parsed.due})`);
    if (parsed.closed) parts.push(`@closed(${parsed.closed})`);
    if (parsed.status) parts.push(`@status(${parsed.status})`);
    if (parsed.priority) parts.push(`@priority(${parsed.priority})`);
    if (parsed.project) parts.push(`@project(${parsed.project})`);
    if (parsed.people && parsed.people.length > 0) {
      for (const p of parsed.people) {
        parts.push(`@person(${p})`);
      }
    }

    return parts.join(" ").trim();
  }

  renderTasks() {
    if (!this.listEl) return;
    this.listEl.empty();

    let tasks = this.tasks.slice();

    // Status / priority filter
    if (this.filterStatus !== "All") {
      tasks = tasks.filter((t) => t.status === this.filterStatus);
    }
    if (this.filterPriority !== "All") {
      tasks = tasks.filter((t) => t.priority === this.filterPriority);
    }

    // Quick due filter
    const today = getToday();
    if (this.quickFilter !== "all") {
      tasks = tasks.filter((t) => {
        const d = parseDateString(t.due);
        if (!d) return false;
        const day = stripTime(d);
        switch (this.quickFilter) {
          case "today":
            return day.getTime() === today.getTime();
          case "week": {
            const weekEnd = addDays(today, 7);
            return day >= today && day < weekEnd;
          }
          case "overdue":
            return day < today;
          default:
            return true;
        }
      });
    }

    // Sorting
    const sortBy = this.sortBy;
    tasks.sort((a, b) => {
      switch (sortBy) {
        case "Created":
          return (
            compareNullableDate(a.created, b.created) ||
            a.filePath.localeCompare(b.filePath)
          );
        case "Due":
          return (
            compareNullableDate(a.due, b.due) ||
            a.filePath.localeCompare(b.filePath)
          );
        case "Priority":
          return (
            priorityRank(a.priority) - priorityRank(b.priority) ||
            a.filePath.localeCompare(b.filePath)
          );
        case "Status":
          return (
            statusRank(a.status) - statusRank(b.status) ||
            a.filePath.localeCompare(b.filePath)
          );
        default:
          return a.filePath.localeCompare(b.filePath);
      }
    });

    this.countEl.setText(
      ` (${tasks.length} task${tasks.length === 1 ? "" : "s"})`,
    );

    if (tasks.length === 0) {
      const empty = this.listEl.createDiv("task-control-hub-empty");
      empty.setText("No tasks match the current filters.");
      return;
    }

    // Flat list
    for (const task of tasks) {
      this.renderTaskItem(task, this.listEl);
    }
  }

  renderTaskItem(task, parentEl) {
    const item = parentEl.createDiv("task-control-hub-item");

    // Row 1: Status + Priority + Due
    const topRow = item.createDiv("task-control-hub-main-row");
    const badges = topRow.createDiv("task-control-hub-badges");

    // Status dropdown
    const statusSelect = badges.createEl("select", {
      cls: "task-control-hub-select task-control-hub-status-select",
    });
    const statusOptions = ["Open", "In Progress", "Complete", "Canceled"];
    for (const s of statusOptions) {
      const opt = statusSelect.createEl("option", { text: s, value: s });
      if (s === task.status) opt.selected = true;
    }
    this.applyStatusColorClass(statusSelect, task.status);
    statusSelect.onclick = (evt) => evt.stopPropagation();
    statusSelect.onchange = async (evt) => {
      evt.stopPropagation();
      const newStatus = evt.target.value;
      await this.updateTaskStatus(task, newStatus);
    };

    // Priority dropdown
    const prioritySelect = badges.createEl("select", {
      cls: "task-control-hub-select task-control-hub-priority-select",
    });
    const priorityOptions = ["High", "Medium", "Low"];
    for (const p of priorityOptions) {
      const opt = prioritySelect.createEl("option", { text: p, value: p });
      if (p === task.priority) opt.selected = true;
    }
    prioritySelect.onclick = (evt) => evt.stopPropagation();
    prioritySelect.onchange = async (evt) => {
      evt.stopPropagation();
      const newPriority = evt.target.value;
      await this.updateTaskPriority(task, newPriority);
    };

    // Due date inline editor
    const dueContainer = badges.createDiv("task-control-hub-due-container");

    const dueDisplay = dueContainer.createSpan("task-control-hub-due-display");
    dueDisplay.setText(
      task.due ? formatDateMMDDYYYY(task.due) : "No due date",
    );

    const dueInput = dueContainer.createEl("input", {
      type: "date",
      cls: "task-control-hub-due-input",
    });

    if (task.due) {
      const d = parseDateString(task.due);
      if (d) {
        dueInput.value = formatDateISO(stripTime(d));
      }
    }

    dueInput.onclick = (evt) => evt.stopPropagation();
    dueInput.onchange = async (evt) => {
      evt.stopPropagation();
      const iso = evt.target.value || "";
      await this.updateTaskDue(task, iso);
      dueDisplay.setText(
        iso ? formatDateMMDDYYYY(iso) : "No due date",
      );
      dueInput.style.display = "none";
      dueDisplay.style.display = "inline";
    };
    dueInput.onblur = () => {
      dueInput.style.display = "none";
      dueDisplay.style.display = "inline";
    };

    dueDisplay.onclick = (evt) => {
      evt.stopPropagation();
      dueDisplay.style.display = "none";
      dueInput.style.display = "inline-block";
      dueInput.focus();
    };

    // Row 2: task text rendered as Markdown (for [[links]])
const textRow = item.createDiv("task-control-hub-text-row");
const textContainer = textRow.createDiv("task-control-hub-text");

// Use Obsidian's Markdown renderer so [[wiki-links]] look right
MarkdownRenderer.renderMarkdown(
  task.text,
  textContainer,
  task.filePath,
  this,
);

// Make the rendered [[links]] actually open notes
this.registerDomEvent(textContainer, "click", (evt) => {
  const target = evt.target;
  if (!target) return;

  // Find the closest internal link <a>
  const linkEl = target.closest("a.internal-link");
  if (!linkEl) return;

  evt.preventDefault();
  evt.stopPropagation();

  const linkTarget =
    linkEl.getAttribute("data-href") || linkEl.getAttribute("href");
  if (!linkTarget) return;

  this.app.workspace.openLinkText(linkTarget, task.filePath, true);
});

    // Row 3: meta info
    const metaRow = item.createDiv("task-control-hub-meta-row");
    const metaParts = [];

    if (task.due) metaParts.push(`Due ${formatDateMMDDYYYY(task.due)}`);
    if (task.created) metaParts.push(`Created ${task.created}`);
    if (task.project) metaParts.push(`Project: ${task.project}`);
    if (task.people && task.people.length > 0) {
      metaParts.push(`People: ${task.people.join(", ")}`);
    }

    metaParts.push(this.shortPath(task.filePath));
    metaRow.setText(metaParts.join(" • "));

    // Open note only when clicking outside controls
    item.onclick = (evt) => {
      const tag = evt.target.tagName.toLowerCase();
      if (
        tag === "select" ||
        tag === "option" ||
        tag === "input" ||
        tag === "button" ||
        tag === "a"
      ) {
        return;
      }
      evt.preventDefault();
      this.openTask(task);
    };
  }

  applyStatusColorClass(selectEl, status) {
    selectEl.removeClass("status-open");
    selectEl.removeClass("status-in-progress");
    selectEl.removeClass("status-complete");
    selectEl.removeClass("status-canceled");

    const s = (status || "").toLowerCase();
    if (s === "open") selectEl.addClass("status-open");
    else if (s === "in progress") selectEl.addClass("status-in-progress");
    else if (s === "complete") selectEl.addClass("status-complete");
    else if (s === "canceled" || s === "cancelled")
      selectEl.addClass("status-canceled");
  }

  shortPath(path) {
    const parts = path.split("/");
    if (parts.length <= 2) return path;
    return parts.slice(parts.length - 2).join("/");
  }

  async openTask(task) {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file, { active: true });

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.editor) {
      const lineIndex = Math.max(0, task.lineNumber - 1);
      view.editor.setCursor({ line: lineIndex, ch: 0 });
      view.editor.scrollIntoView(
        {
          from: { line: lineIndex, ch: 0 },
          to: { line: lineIndex + 1, ch: 0 },
        },
        true,
      );
    }
  }

  async updateTaskStatus(task, newStatus) {
    task.status = newStatus;

    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;

    let content;
    try {
      content = await this.app.vault.read(file);
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    const idx = task.lineNumber - 1;
    if (idx < 0 || idx >= lines.length) return;

    const line = lines[idx];
    const m = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.*)$/.exec(line);
    if (!m) return;

    const leading = m[1];
    let checkboxChar = m[2];
    const spacer = m[3];
    const body = m[4];

    const parsed = this.parseTaskLine(body);
    parsed.status = newStatus;

    // auto-closed date when done/canceled
    if (
      (newStatus === "Complete" || newStatus === "Canceled") &&
      !parsed.closed
    ) {
      parsed.closed = formatDateISO(getToday());
    }

    if (newStatus === "Complete" || newStatus === "Canceled") {
      checkboxChar = "x";
    } else {
      checkboxChar = " ";
    }

    const newBody = this.buildTaskBodyFromParsed(parsed);
    lines[idx] = `${leading}${checkboxChar}${spacer}${newBody}`;

    await this.app.vault.modify(file, lines.join("\n"));
    await this.refresh();
  }

  async updateTaskPriority(task, newPriority) {
    task.priority = newPriority;

    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;

    let content;
    try {
      content = await this.app.vault.read(file);
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    const idx = task.lineNumber - 1;
    if (idx < 0 || idx >= lines.length) return;

    const line = lines[idx];
    const m = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.*)$/.exec(line);
    if (!m) return;

    const leading = m[1];
    const checkboxChar = m[2];
    const spacer = m[3];
    const body = m[4];

    const parsed = this.parseTaskLine(body);
    parsed.priority = newPriority;

    const newBody = this.buildTaskBodyFromParsed(parsed);
    lines[idx] = `${leading}${checkboxChar}${spacer}${newBody}`;

    await this.app.vault.modify(file, lines.join("\n"));
    await this.refresh();
  }

  async updateTaskDue(task, isoDate) {
    task.due = isoDate || null;

    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;

    let content;
    try {
      content = await this.app.vault.read(file);
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    const idx = task.lineNumber - 1;
    if (idx < 0 || idx >= lines.length) return;

    const line = lines[idx];
    const m = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.*)$/.exec(line);
    if (!m) return;

    const leading = m[1];
    const checkboxChar = m[2];
    const spacer = m[3];
    const body = m[4];

    const parsed = this.parseTaskLine(body);
    parsed.due = isoDate || null;

    const newBody = this.buildTaskBodyFromParsed(parsed);
    lines[idx] = `${leading}${checkboxChar}${spacer}${newBody}`;

    await this.app.vault.modify(file, lines.join("\n"));
    await this.refresh();
  }
}

// ---------- Date & sort helpers ----------

function parseDateString(str) {
  if (!str) return null;
  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
    );
  }
  // MM-DD-YYYY
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(str);
  if (m) {
    return new Date(
      Number(m[3]),
      Number(m[1]) - 1,
      Number(m[2]),
    );
  }
  return null;
}

function formatDateMMDDYYYY(strOrIso) {
  const d = parseDateString(strOrIso);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getToday() {
  return stripTime(new Date());
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return stripTime(d);
}

function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function compareNullableDate(a, b) {
  const da = parseDateString(a);
  const db = parseDateString(b);
  if (!da && !db) return 0;
  if (!da && db) return 1;
  if (da && !db) return -1;
  if (da < db) return -1;
  if (da > db) return 1;
  return 0;
}

function priorityRank(p) {
  switch ((p || "").toLowerCase()) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    default:
      return 3;
  }
}

function statusRank(s) {
  switch ((s || "").toLowerCase()) {
    case "open":
      return 0;
    case "in progress":
      return 1;
    case "complete":
      return 2;
    case "canceled":
    case "cancelled":
      return 3;
    default:
      return 4;
  }
}

class TaskControlHubSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Task Control Hub Settings" });

    new Setting(containerEl)
      .setName("Show file path")
      .setDesc("Display the file path under each task.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showFilePath)
          .onChange(async (value) => {
            this.plugin.settings.showFilePath = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Only show tasks with @due(...)")
      .setDesc(
        "If enabled, tasks without a @due(YYYY-MM-DD) tag will be hidden.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showDueOnly)
          .onChange(async (value) => {
            this.plugin.settings.showDueOnly = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}

module.exports = TaskControlHubPlugin;