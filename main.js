
const { Plugin, ItemView, Setting, MarkdownView, TFile, PluginSettingTab } = require('obsidian');

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
			(leaf) => new TaskControlHubView(leaf, this)
		);

		this.addRibbonIcon("checklist", "Open Task Control Hub", () => {
			this.activateRightSidebarView();
		});

		this.addCommand({
			id: "open-task-control-hub",
			name: "Open Task Control Hub",
			callback: () => this.activateRightSidebarView()
		});

		this.addCommand({
			id: "open-task-control-hub-main",
			name: "Open Task Control Hub in main pane",
			callback: () => this.activateMainView()
		});

		this.addSettingTab(new TaskControlHubSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.refreshViews();
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.refreshViews();
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.refreshViews();
				}
			})
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
	}

	getViewType() {
		return VIEW_TYPE_TASK_HUB;
	}

	getDisplayText() {
		return "Task Control Hub";
	}

	getIcon() {
		return "checklist";
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
		this.headerEl.createEl("h4", { text: "Task Control Hub" });
		this.countEl = this.headerEl.createSpan({ text: "" });
		this.countEl.addClass("task-control-hub-count");
	}

	buildControls() {
		this.controlsEl.empty();
		const row = this.controlsEl.createDiv("task-control-hub-control-row");

		row.createSpan({ text: "Status: " });
		const statusSelect = row.createEl("select");
		["All", "Open", "In Progress", "Complete", "Canceled"].forEach((s) => {
			const opt = statusSelect.createEl("option", { text: s, value: s });
			if (s === this.filterStatus) opt.selected = true;
		});
		statusSelect.onchange = (evt) => {
			this.filterStatus = evt.target.value;
			this.renderTasks();
		};

		row.createSpan({ text: "  Priority: " });
		const prioritySelect = row.createEl("select");
		["All", "High", "Medium", "Low"].forEach((p) => {
			const opt = prioritySelect.createEl("option", { text: p, value: p });
			if (p === this.filterPriority) opt.selected = true;
		});
		prioritySelect.onchange = (evt) => {
			this.filterPriority = evt.target.value;
			this.renderTasks();
		};

		row.createSpan({ text: "  Sort by: " });
		const sortSelect = row.createEl("select");
		const sortOptions = [
			["Created", "Created Date"],
			["Due", "Due Date"],
			["Priority", "Priority"],
			["Status", "Status"]
		];
		for (const [value, label] of sortOptions) {
			const opt = sortSelect.createEl("option", { text: label, value });
			if (value === this.sortBy) opt.selected = true;
		}
		sortSelect.onchange = (evt) => {
			this.sortBy = evt.target.value;
			this.renderTasks();
		};
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
			people: []
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

	renderTasks() {
		if (!this.listEl) return;
		this.listEl.empty();

		let tasks = this.tasks.slice();

		if (this.filterStatus !== "All") {
			tasks = tasks.filter(t => t.status === this.filterStatus);
		}
		if (this.filterPriority !== "All") {
			tasks = tasks.filter(t => t.priority === this.filterPriority);
		}

		const sortBy = this.sortBy;
		tasks.sort((a, b) => {
			switch (sortBy) {
				case "Created":
					return compareNullableDate(a.created, b.created) || a.filePath.localeCompare(b.filePath);
				case "Due":
					return compareNullableDate(a.due, b.due) || a.filePath.localeCompare(b.filePath);
				case "Priority":
					return priorityRank(a.priority) - priorityRank(b.priority) || a.filePath.localeCompare(b.filePath);
				case "Status":
					return statusRank(a.status) - statusRank(b.status) || a.filePath.localeCompare(b.filePath);
				default:
					return a.filePath.localeCompare(b.filePath);
			}
		});

		this.countEl.setText(` (${tasks.length} task${tasks.length === 1 ? "" : "s"})`);

		if (tasks.length === 0) {
			const empty = this.listEl.createDiv("task-control-hub-empty");
			empty.setText("No tasks match the current filters.");
			return;
		}

		for (const task of tasks) {
			const item = this.listEl.createDiv("task-control-hub-item");

			const topRow = item.createDiv("task-control-hub-main-row");

			const badges = topRow.createDiv("task-control-hub-badges");
			const statusBadge = badges.createSpan("task-control-hub-badge task-control-hub-status");
			statusBadge.setText(task.status);

			const priorityBadge = badges.createSpan("task-control-hub-badge task-control-hub-priority");
			priorityBadge.setText(task.priority);

			const textSpan = topRow.createSpan("task-control-hub-text");
			textSpan.setText(task.text);

			const metaRow = item.createDiv("task-control-hub-meta-row");
			const metaParts = [];

			if (task.due) metaParts.push(`Due ${task.due}`);
			if (task.created) metaParts.push(`Created ${task.created}`);
			if (task.project) metaParts.push(`Project: ${task.project}`);
			if (task.people && task.people.length > 0) {
				metaParts.push(`People: ${task.people.join(", ")}`);
			}

			metaParts.push(this.shortPath(task.filePath));
			metaRow.setText(metaParts.join(" • "));

			item.onclick = (evt) => {
				evt.preventDefault();
				this.openTask(task);
			};
		}
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
				{ from: { line: lineIndex, ch: 0 }, to: { line: lineIndex + 1, ch: 0 } },
				true
			);
		}
	}
}

function compareNullableDate(a, b) {
	if (!a && !b) return 0;
	if (!a && b) return 1;
	if (a && !b) return -1;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function priorityRank(p) {
	switch ((p || "").toLowerCase()) {
		case "high": return 0;
		case "medium": return 1;
		case "low": return 2;
		default: return 3;
	}
}

function statusRank(s) {
	switch ((s || "").toLowerCase()) {
		case "open": return 0;
		case "in progress": return 1;
		case "complete": return 2;
		case "canceled":
		case "cancelled": return 3;
		default: return 4;
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
					})
			);

		new Setting(containerEl)
			.setName("Only show tasks with @due(...)")
			.setDesc("If enabled, tasks without a @due(YYYY-MM-DD) tag will be hidden.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showDueOnly)
					.onChange(async (value) => {
						this.plugin.settings.showDueOnly = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

module.exports = TaskControlHubPlugin;
