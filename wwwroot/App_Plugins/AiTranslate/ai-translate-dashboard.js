import { LitElement, css, html, nothing } from '@umbraco-cms/backoffice/external/lit';
import { UmbElementMixin } from '@umbraco-cms/backoffice/element-api';
import { UMB_AUTH_CONTEXT } from '@umbraco-cms/backoffice/auth';
import { UMB_NOTIFICATION_CONTEXT } from '@umbraco-cms/backoffice/notification';

const API_BASE = '/umbraco/management/api/v1/translation';

const CONFIG_KEY = 'umb:aiTranslate:config';
const DEFAULT_CONFIG = { profileAlias: 'content-assistant', promptAlias: 'ai-translate' };

const STEPS = [
    { n: 1, label: 'From' },
    { n: 2, label: 'To' },
    { n: 3, label: 'Pages' },
    { n: 4, label: 'Translate' },
];

const shortCode = (isoCode) => (isoCode ?? '').split('-')[0].toUpperCase();

const languageName = (lang) => {
    if (!lang) return '';
    const base = (lang.name ?? '').split('(')[0].trim();
    return base || lang.isoCode;
};

export class AiTranslateDashboardElement extends UmbElementMixin(LitElement) {
    static properties = {
        _languages: { state: true },
        _nodes: { state: true },
        _sourceCulture: { state: true },
        _targetCulture: { state: true },
        _loading: { state: true },
        _error: { state: true },
        _status: { state: true },
        _rechecking: { state: true },
        _config: { state: true },
        _settingsOpen: { state: true },
        _forceGuide: { state: true },
        _justVerified: { state: true },
        _step: { state: true },
        _selectedIds: { state: true },
        _overwrite: { state: true },
        _copyMedia: { state: true },
        _bulkRunning: { state: true },
        _bulkProgress: { state: true },
        _bulkResult: { state: true },
        _cancelRequested: { state: true },
        _createLangOpen: { state: true },
        _availableCultures: { state: true },
        _createLangIso: { state: true },
        _creatingLang: { state: true },
    };

    constructor() {
        super();

        this._languages = [];
        this._nodes = [];
        this._sourceCulture = '';
        this._targetCulture = '';
        this._loading = true;
        this._error = null;
        this._status = null;
        this._rechecking = false;
        this._config = this._loadConfig();
        this._settingsOpen = false;
        this._forceGuide = false;
        this._justVerified = false;
        this._step = 1;
        this._selectedIds = new Set();
        this._overwrite = false;
        this._copyMedia = true;
        this._bulkRunning = false;
        this._bulkProgress = { done: 0, total: 0, currentName: '' };
        this._bulkResult = null;
        this._cancelRequested = false;
        this._createLangOpen = false;
        this._availableCultures = [];
        this._createLangIso = '';
        this._creatingLang = false;

        this._authContext = null;
        this._notificationContext = null;

        this.consumeContext(UMB_AUTH_CONTEXT, (ctx) => {
            this._authContext = ctx;
        });

        this.consumeContext(UMB_NOTIFICATION_CONTEXT, (ctx) => {
            this._notificationContext = ctx;
        });
    }

    connectedCallback() {
        super.connectedCallback();
        this._load();
    }

    // --- config ---------------------------------------------------------

    _loadConfig() {
        try {
            const raw = localStorage.getItem(CONFIG_KEY);
            return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
        } catch {
            return { ...DEFAULT_CONFIG };
        }
    }

    _saveConfig(next) {
        this._config = { ...this._config, ...next };
        try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify(this._config));
        } catch {
            /* ignore storage failures */
        }
    }

    _configQuery() {
        const params = new URLSearchParams({
            profileAlias: this._config.profileAlias ?? '',
            promptAlias: this._config.promptAlias ?? '',
        });
        return `?${params.toString()}`;
    }

    // --- networking -----------------------------------------------------

    async _getToken() {
        const config = this._authContext?.getOpenApiConfiguration();
        const token = typeof config?.token === 'function' ? await config.token() : config?.token;
        return token;
    }

    async _fetch(path, options = {}) {
        const token = await this._getToken();
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(options.headers ?? {}),
            },
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
        }

        if (response.status === 204) return null;
        return response.json();
    }

    async _load() {
        this._loading = true;
        this._error = null;
        try {
            // Status can throw on the endpoint itself (not the AI) — don't let
            // that block the dashboard; only an explicit { configured:false }
            // gates the setup guide.
            const [languages, nodes, status] = await Promise.all([
                this._fetch('/languages'),
                this._fetch('/nodes'),
                this._fetch(`/status${this._configQuery()}`).catch(() => null),
            ]);
            this._languages = languages ?? [];
            this._nodes = nodes ?? [];
            this._status = status;

            const defaultLang = this._languages.find((l) => l.isDefault) ?? this._languages[0];
            this._sourceCulture = defaultLang?.isoCode ?? '';
            this._targetCulture = '';
            this._selectedIds = new Set();
            this._step = 1;
        } catch (error) {
            this._error = error?.message ?? String(error);
        } finally {
            this._loading = false;
        }
    }

    async _refreshNodes() {
        const nodes = await this._fetch('/nodes');
        this._nodes = nodes ?? [];
    }

    _openSettings() {
        this._settingsDraft = { ...this._config };
        this._settingsOpen = true;
    }

    _closeSettings() {
        this._settingsOpen = false;
    }

    async _saveSettings(draft) {
        this._saveConfig({
            profileAlias: (draft.profileAlias ?? '').trim() || DEFAULT_CONFIG.profileAlias,
            promptAlias: (draft.promptAlias ?? '').trim() || DEFAULT_CONFIG.promptAlias,
        });
        this._settingsOpen = false;
        await this._recheckStatus();
    }

    _openGuide() {
        this._settingsOpen = false;
        this._forceGuide = true;
        this._justVerified = false;
    }

    _closeGuide() {
        this._forceGuide = false;
        this._justVerified = false;
    }

    /** Leave the guide for the translator after a confirmed-OK check. */
    _proceedFromGuide() {
        this._justVerified = false;
        this._forceGuide = false;
    }

    async _recheckStatus() {
        this._rechecking = true;
        try {
            this._status = await this._fetch(`/status${this._configQuery()}`).catch(() => null);
            // Keep the guide on screen and show a clear success confirmation
            // rather than silently vanishing into the wizard.
            this._justVerified = !!this._status?.configured;
        } finally {
            this._rechecking = false;
        }
    }

    // --- wizard navigation ---------------------------------------------

    _sourceName() {
        return languageName(this._languages.find((l) => l.isoCode === this._sourceCulture)) || this._sourceCulture;
    }

    _targetName() {
        return languageName(this._languages.find((l) => l.isoCode === this._targetCulture)) || this._targetCulture;
    }

    _canAdvance() {
        switch (this._step) {
            case 1:
                return !!this._sourceCulture;
            case 2:
                return !!this._targetCulture && this._targetCulture !== this._sourceCulture;
            case 3:
                return this._selectedIds.size > 0;
            default:
                return false;
        }
    }

    _goNext() {
        if (!this._canAdvance() || this._step >= 4) return;
        this._step += 1;
    }

    _goBack() {
        if (this._step <= 1 || this._bulkRunning) return;
        this._step -= 1;
    }

    _goStep(n) {
        if (this._bulkRunning) return;
        if (n < this._step) this._step = n; // only jump backwards to completed steps
    }

    _onSourceChange(event) {
        const next = event.target.value;
        this._sourceCulture = next;
        if (this._targetCulture === next) this._targetCulture = '';
        this._selectedIds = new Set();
    }

    _onTargetChange(event) {
        this._targetCulture = event.target.value;
        this._selectedIds = new Set();
    }

    // --- node helpers ---------------------------------------------------

    /** Just the source and target languages, in that order — the only two
     *  that matter while choosing pages for a single translation pair. */
    _pairLanguages() {
        const source = this._languages.find((l) => l.isoCode === this._sourceCulture);
        const target = this._languages.find((l) => l.isoCode === this._targetCulture);
        return [source, target].filter(Boolean);
    }

    _hasSource(node) {
        return node.culturesWithContent.includes(this._sourceCulture);
    }

    _hasTarget(node) {
        return node.culturesWithContent.includes(this._targetCulture);
    }

    /** A node can be translated when it has translatable text, has source
     *  content, and — unless overwriting — does not already have a target. */
    _isEligible(node) {
        if (node.translatableProperties === 0) return false;
        if (!this._hasSource(node)) return false;
        if (!this._overwrite && this._hasTarget(node)) return false;
        return true;
    }

    _eligibleNodes() {
        return this._nodes.filter((n) => this._isEligible(n));
    }

    _statusFor(node) {
        if (node.translatableProperties === 0) {
            return { label: 'No translatable fields', color: 'default' };
        }
        if (!this._hasSource(node)) {
            return { label: 'No source content', color: 'default' };
        }
        if (this._hasTarget(node)) {
            return { label: 'Already translated', color: 'positive' };
        }
        return { label: 'Ready to translate', color: 'warning' };
    }

    /** Build a parent→children map and return the ordered roots. */
    _buildTree() {
        const byId = new Map(this._nodes.map((n) => [n.intId, n]));
        const childrenOf = new Map();
        const roots = [];

        for (const node of this._nodes) {
            if (byId.has(node.parentId)) {
                if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
                childrenOf.get(node.parentId).push(node);
            } else {
                roots.push(node);
            }
        }

        const sort = (a, b) => a.sortOrder - b.sortOrder;
        roots.sort(sort);
        for (const list of childrenOf.values()) list.sort(sort);

        return { roots, childrenOf };
    }

    // --- selection ------------------------------------------------------

    _toggleNode(node, checked) {
        const next = new Set(this._selectedIds);
        if (checked) next.add(node.id);
        else next.delete(node.id);
        this._selectedIds = next;
    }

    _selectAll() {
        this._selectedIds = new Set(this._eligibleNodes().map((n) => n.id));
    }

    _selectNone() {
        this._selectedIds = new Set();
    }

    _selectUntranslated() {
        this._selectedIds = new Set(
            this._eligibleNodes()
                .filter((n) => !this._hasTarget(n))
                .map((n) => n.id),
        );
    }

    _onOverwriteChange(event) {
        this._overwrite = event.target.checked;
        // Re-validate the current selection against the new eligibility rules.
        const eligible = new Set(this._eligibleNodes().map((n) => n.id));
        this._selectedIds = new Set([...this._selectedIds].filter((id) => eligible.has(id)));
    }

    // --- translation ----------------------------------------------------

    /** Translate a single node and update its culture state. */
    async _translateNode(node) {
        const result = await this._fetch('/translate', {
            method: 'POST',
            body: JSON.stringify({
                contentId: node.id,
                sourceCulture: this._sourceCulture,
                targetCulture: this._targetCulture,
                overwrite: this._overwrite,
                copyMedia: this._copyMedia,
                profileAlias: this._config.profileAlias,
                promptAlias: this._config.promptAlias,
            }),
        });

        this._nodes = this._nodes.map((n) =>
            n.id === node.id
                ? { ...n, culturesWithContent: result.culturesWithContent ?? n.culturesWithContent }
                : n,
        );

        return result;
    }

    async _startTranslate() {
        const nodes = this._eligibleNodes().filter((n) => this._selectedIds.has(n.id));
        await this._runBulk(nodes);
    }

    /** Translate a list of nodes sequentially, reporting progress and a
     *  summary at the end. Saves are drafts only. */
    async _runBulk(nodes) {
        if (!nodes.length || this._bulkRunning) return;
        if (!this._sourceCulture || !this._targetCulture || this._sourceCulture === this._targetCulture) {
            return;
        }

        this._bulkRunning = true;
        this._bulkResult = null;
        this._cancelRequested = false;
        this._bulkProgress = { done: 0, total: nodes.length, currentName: '' };

        let pagesTranslated = 0;
        let fieldsTranslated = 0;
        let mediaCopied = 0;
        let skipped = 0;
        const errors = [];

        try {
            for (const node of nodes) {
                if (this._cancelRequested) break;
                this._bulkProgress = { ...this._bulkProgress, currentName: node.name };
                try {
                    const result = await this._translateNode(node);
                    if (result.propertiesTranslated > 0) {
                        pagesTranslated++;
                        fieldsTranslated += result.propertiesTranslated;
                    }
                    mediaCopied += result.mediaCopied ?? 0;
                    skipped += result.propertiesSkipped ?? 0;
                    for (const message of result.errors ?? []) {
                        errors.push(`${node.name}: ${message}`);
                    }
                } catch (error) {
                    errors.push(`${node.name}: ${error?.message ?? String(error)}`);
                }
                this._bulkProgress = { ...this._bulkProgress, done: this._bulkProgress.done + 1 };
            }

            this._bulkResult = {
                pagesTranslated,
                fieldsTranslated,
                mediaCopied,
                skipped,
                errors,
                targetName: this._targetName(),
                cancelled: this._cancelRequested,
            };

            this._notificationContext?.peek(errors.length ? 'warning' : 'positive', {
                data: {
                    headline: `Translation finished${this._cancelRequested ? ' (cancelled)' : ''}`,
                    message: `${pagesTranslated} page${pagesTranslated === 1 ? '' : 's'} translated to ${this._targetName()} as drafts.`,
                },
            });
        } finally {
            this._bulkRunning = false;
            this._bulkProgress = { done: 0, total: 0, currentName: '' };
        }
    }

    _cancelBulk() {
        this._cancelRequested = true;
    }

    _startOver() {
        this._bulkResult = null;
        this._selectedIds = new Set();
        this._targetCulture = '';
        this._step = 1;
    }

    // --- create language ------------------------------------------------

    async _openCreateLanguage() {
        this._createLangOpen = true;
        this._createLangIso = '';
        this._availableCultures = [];
        try {
            const cultures = await this._fetch('/available-cultures');
            this._availableCultures = cultures ?? [];
        } catch (error) {
            this._notificationContext?.peek('danger', {
                data: { headline: 'Could not load cultures', message: error?.message ?? String(error) },
            });
        }
    }

    _closeCreateLanguage() {
        this._createLangOpen = false;
        this._creatingLang = false;
        this._createLangIso = '';
    }

    async _confirmCreateLanguage() {
        const iso = this._createLangIso;
        if (!iso) return;

        this._creatingLang = true;
        try {
            const created = await this._fetch('/languages', {
                method: 'POST',
                body: JSON.stringify({ isoCode: iso }),
            });

            const languages = await this._fetch('/languages');
            this._languages = languages ?? [];
            await this._refreshNodes();

            this._targetCulture = created?.isoCode ?? this._targetCulture;
            if (this._targetCulture === this._sourceCulture) {
                const other = this._languages.find((l) => l.isoCode !== this._targetCulture);
                if (other) this._sourceCulture = other.isoCode;
            }
            this._selectedIds = new Set();
            this._closeCreateLanguage();

            this._notificationContext?.peek('positive', {
                data: {
                    headline: 'Language created',
                    message: `${languageName(created) || created?.isoCode} is ready as a translation target.`,
                },
            });
        } catch (error) {
            this._notificationContext?.peek('danger', {
                data: { headline: 'Could not create language', message: error?.message ?? String(error) },
            });
        } finally {
            this._creatingLang = false;
        }
    }

    // --- rendering ------------------------------------------------------

    _renderStepper() {
        return html`
            <nav class="stepper" aria-label="Translation steps">
                ${STEPS.map((s, i) => {
                    const state = s.n === this._step ? 'active' : s.n < this._step ? 'done' : 'todo';
                    return html`
                        ${i > 0 ? html`<span class="stepper__bar ${s.n <= this._step ? 'stepper__bar--done' : ''}"></span>` : nothing}
                        <button
                            class="stepper__step stepper__step--${state}"
                            ?disabled=${s.n >= this._step || this._bulkRunning}
                            @click=${() => this._goStep(s.n)}>
                            <span class="stepper__num">${state === 'done' ? '✓' : s.n}</span>
                            <span class="stepper__label">${s.label}</span>
                        </button>
                    `;
                })}
            </nav>
        `;
    }

    _renderNav(nextLabel) {
        return html`
            <div class="step__nav">
                ${this._step > 1
                    ? html`<uui-button look="secondary" label="Back" @click=${() => this._goBack()}>Back</uui-button>`
                    : html`<span></span>`}
                <uui-button look="primary" color="positive" label=${nextLabel}
                    ?disabled=${!this._canAdvance()}
                    @click=${() => this._goNext()}>${nextLabel}</uui-button>
            </div>
        `;
    }

    _renderStepFrom() {
        const options = this._languages.map((l) => ({
            name: `${languageName(l)}${l.isDefault ? ' (default)' : ''}`,
            value: l.isoCode,
            selected: l.isoCode === this._sourceCulture,
        }));

        return html`
            <div class="step">
                <h2 class="step__title">What language are you translating <em>from</em>?</h2>
                <p class="step__hint">Pick the language that already has your content.</p>
                <uui-select
                    label="Translate from"
                    .options=${options}
                    @change=${(e) => this._onSourceChange(e)}></uui-select>
                ${this._renderNav('Next')}
            </div>
        `;
    }

    _renderStepTo() {
        const options = [
            { name: 'Select a language…', value: '', selected: !this._targetCulture, disabled: true },
            ...this._languages
                .filter((l) => l.isoCode !== this._sourceCulture)
                .map((l) => ({
                    name: languageName(l),
                    value: l.isoCode,
                    selected: l.isoCode === this._targetCulture,
                })),
        ];

        return html`
            <div class="step">
                <h2 class="step__title">What language are you translating <em>to</em>?</h2>
                <p class="step__hint">From <strong>${this._sourceName()}</strong> into a target language — or create a brand-new one.</p>
                <uui-select
                    label="Translate to"
                    .options=${options}
                    @change=${(e) => this._onTargetChange(e)}></uui-select>
                <div class="step__or">
                    <uui-button look="secondary" label="Create new language"
                        @click=${() => this._openCreateLanguage()}>
                        <uui-icon name="icon-add"></uui-icon>
                        Create new language
                    </uui-button>
                    <span class="step__or-hint">Adds a new language to Umbraco and selects it here.</span>
                </div>
                ${this._renderNav('Next')}
            </div>
        `;
    }

    _renderStepPages() {
        const eligible = this._eligibleNodes();
        const eligibleCount = eligible.length;
        const selectedCount = this._selectedIds.size;
        const allSelected = eligibleCount > 0 && eligible.every((n) => this._selectedIds.has(n.id));

        return html`
            <div class="step">
                <h2 class="step__title">Which pages do you want to translate?</h2>
                <p class="step__hint">
                    <strong>${this._sourceName()}</strong> → <strong>${this._targetName()}</strong>. Tick the pages to include.
                </p>

                <div class="pages-controls">
                    <div class="pages-controls__left">
                        <uui-checkbox
                            label="Select all translatable pages"
                            ?checked=${allSelected}
                            .indeterminate=${selectedCount > 0 && !allSelected}
                            ?disabled=${eligibleCount === 0}
                            @change=${(e) => (e.target.checked ? this._selectAll() : this._selectNone())}></uui-checkbox>
                        <span class="pages-controls__count">
                            ${selectedCount ? `${selectedCount} selected` : `${eligibleCount} translatable page${eligibleCount === 1 ? '' : 's'}`}
                        </span>
                        <button class="linkbtn" ?disabled=${eligibleCount === 0}
                            @click=${() => this._selectUntranslated()}>Untranslated only</button>
                    </div>
                    <div class="pages-controls__toggles">
                        <uui-toggle
                            label="Overwrite existing"
                            ?checked=${this._overwrite}
                            @change=${(e) => this._onOverwriteChange(e)}></uui-toggle>
                        <uui-toggle
                            label="Also copy images & media"
                            ?checked=${this._copyMedia}
                            @change=${(e) => { this._copyMedia = e.target.checked; }}></uui-toggle>
                    </div>
                </div>

                ${this._renderNodes()}
                ${this._renderNav('Next')}
            </div>
        `;
    }

    _renderStepTranslate() {
        if (this._bulkRunning) {
            const { done, total, currentName } = this._bulkProgress;
            const pct = total ? Math.round((done / total) * 100) : 0;
            return html`
                <div class="step">
                    <h2 class="step__title">Translating…</h2>
                    <div class="progress__head">
                        <span>${done} of ${total}${currentName ? ` — ${currentName}` : ''}</span>
                        <uui-button look="secondary" compact label="Cancel" @click=${() => this._cancelBulk()}>Cancel</uui-button>
                    </div>
                    <uui-loader-bar progress=${pct}></uui-loader-bar>
                </div>
            `;
        }

        if (this._bulkResult) {
            const r = this._bulkResult;
            return html`
                <div class="step step--center">
                    <div class="result__icon">${r.errors.length ? '⚠️' : '✅'}</div>
                    <h2 class="step__title">Translation finished${r.cancelled ? ' (cancelled)' : ''}</h2>
                    <p class="step__hint">
                        ${r.pagesTranslated} page${r.pagesTranslated === 1 ? '' : 's'}
                        (${r.fieldsTranslated} field${r.fieldsTranslated === 1 ? '' : 's'})
                        translated to <strong>${r.targetName}</strong> and saved as drafts.
                        ${r.mediaCopied ? html`<br />${r.mediaCopied} media field${r.mediaCopied === 1 ? '' : 's'} copied across.` : nothing}
                        ${r.skipped ? html`<br />${r.skipped} field${r.skipped === 1 ? '' : 's'} already had content and were kept.` : nothing}
                    </p>
                    ${r.errors.length
                        ? html`<div class="result__errors">
                            <strong>${r.errors.length} issue${r.errors.length === 1 ? '' : 's'}:</strong>
                            <ul>${r.errors.slice(0, 8).map((e) => html`<li>${e}</li>`)}</ul>
                        </div>`
                        : nothing}
                    <p class="step__hint">Open each page in the Content section to review and publish.</p>
                    <div class="step__nav step__nav--center">
                        <uui-button look="primary" color="positive" label="Translate more"
                            @click=${() => this._startOver()}>Translate more</uui-button>
                    </div>
                </div>
            `;
        }

        const count = this._eligibleNodes().filter((n) => this._selectedIds.has(n.id)).length;
        return html`
            <div class="step step--center">
                <div class="result__icon">🌐</div>
                <h2 class="step__title">Ready to translate</h2>
                <p class="step__hint">
                    <strong>${count}</strong> page${count === 1 ? '' : 's'} from
                    <strong>${this._sourceName()}</strong> to <strong>${this._targetName()}</strong>.
                    ${this._overwrite ? 'Existing translations will be overwritten.' : 'Existing translations are kept.'}
                    Everything is saved as drafts for you to review.
                </p>
                <div class="step__nav step__nav--center">
                    <uui-button look="secondary" label="Back" @click=${() => this._goBack()}>Back</uui-button>
                    <uui-button look="primary" color="positive" label="Translate"
                        ?disabled=${count === 0}
                        @click=${() => this._startTranslate()}>
                        Translate ${count} page${count === 1 ? '' : 's'}
                    </uui-button>
                </div>
            </div>
        `;
    }

    _renderStep() {
        switch (this._step) {
            case 1: return this._renderStepFrom();
            case 2: return this._renderStepTo();
            case 3: return this._renderStepPages();
            case 4: return this._renderStepTranslate();
            default: return nothing;
        }
    }

    _renderNode(node, depth) {
        const indent = `padding-left: calc(var(--uui-size-space-5) + ${depth} * var(--uui-size-space-6, 27px))`;

        if (node.translatableProperties === 0) {
            return html`
                <div class="row row--folder" style=${indent}>
                    <span class="row__folder-icon" aria-hidden="true">📁</span>
                    <span class="row__name">${node.name}</span>
                </div>
            `;
        }

        const status = this._statusFor(node);
        const eligible = this._isEligible(node);
        const checked = this._selectedIds.has(node.id);

        return html`
            <div class="row ${checked ? 'row--selected' : ''}" style=${indent}>
                <uui-checkbox
                    class="row__check"
                    label="Select ${node.name}"
                    ?checked=${checked}
                    ?disabled=${!eligible}
                    @change=${(e) => this._toggleNode(node, e.target.checked)}></uui-checkbox>
                <span class="row__name" title=${node.name}>${node.name}</span>
                <span class="row__cultures">
                    ${this._pairLanguages().map((lang) => {
                        const present = node.culturesWithContent.includes(lang.isoCode);
                        return html`<span class="lang-dot ${present ? 'lang-dot--on' : 'lang-dot--off'}"
                            title=${present
                                ? `Saved in ${languageName(lang)}`
                                : `Not yet translated to ${languageName(lang)}`}>${shortCode(lang.isoCode)}</span>`;
                    })}
                </span>
                <span class="row__status">
                    <uui-tag color=${status.color} look="primary">${status.label}</uui-tag>
                </span>
            </div>
        `;
    }

    _renderTreeLevel(nodes, childrenOf, depth, out) {
        for (const node of nodes) {
            out.push(this._renderNode(node, depth));
            const children = childrenOf.get(node.intId);
            if (children?.length) {
                this._renderTreeLevel(children, childrenOf, depth + 1, out);
            }
        }
    }

    _renderNodes() {
        if (this._nodes.length === 0) {
            return html`
                <section class="empty">
                    <div class="empty__icon">📄</div>
                    <h2>No pages yet</h2>
                    <p>Create a page with text fields that vary by language, and it will appear here.</p>
                </section>
            `;
        }

        const { roots, childrenOf } = this._buildTree();
        const rows = [];
        this._renderTreeLevel(roots, childrenOf, 0, rows);

        return html`<section class="nodes">${rows}</section>`;
    }

    _renderSetupGuide() {
        const alias = this._status?.requiredProfileAlias ?? this._config.profileAlias;

        // Success confirmation — shown when the profile is usable (after a
        // re-check, or when opening the guide while already connected).
        if (this._status?.configured) {
            return html`
                <section class="guide">
                    <div class="guide__icon guide__icon--ok" aria-hidden="true">✓</div>
                    <h2 class="guide__title">AI translation is ready</h2>
                    <p class="guide__lead">
                        Connected to the AI profile <code>${alias}</code>. You're good to translate.
                    </p>
                    <div class="guide__actions">
                        <uui-button look="primary" color="positive" label="Start translating"
                            @click=${() => this._proceedFromGuide()}>Start translating</uui-button>
                        <uui-button look="secondary" label="Re-check"
                            ?disabled=${this._rechecking}
                            @click=${() => this._recheckStatus()}>
                            ${this._rechecking ? 'Checking…' : 'Re-check'}
                        </uui-button>
                    </div>
                </section>
            `;
        }

        const checkedAndFailed = this._status && this._status.configured === false;
        return html`
            <section class="guide">
                <div class="guide__icon">🤖</div>
                <h2 class="guide__title">Set up AI translation first</h2>
                <p class="guide__lead">
                    AI Translate needs a working Umbraco AI profile before it can translate.
                    It looks for a profile with the alias <code>${alias}</code>.
                </p>
                <ol class="guide__steps">
                    <li>Open the <strong>AI</strong> section in the backoffice.</li>
                    <li>Create a <strong>connection</strong> to a provider (e.g. Anthropic) and paste its API key.</li>
                    <li>Create a <strong>profile</strong> with the alias <code>${alias}</code> and pick a model.</li>
                    <li>Come back here and re-check.</li>
                </ol>
                ${checkedAndFailed
                    ? html`<div class="guide__status guide__status--fail">
                        <span class="guide__status-dot" aria-hidden="true">!</span>
                        Still not connected. ${this._status?.message
                            ? html`<details class="guide__detail"><summary>Details</summary><pre>${this._status.message}</pre></details>`
                            : nothing}
                    </div>`
                    : nothing}
                <div class="guide__actions">
                    ${this._forceGuide
                        ? html`<uui-button look="secondary" label="Back"
                            @click=${() => this._closeGuide()}>Back to translator</uui-button>`
                        : nothing}
                    <uui-button look="primary" color="positive" label="Re-check"
                        ?disabled=${this._rechecking}
                        @click=${() => this._recheckStatus()}>
                        ${this._rechecking ? 'Checking…' : 'Re-check'}
                    </uui-button>
                </div>
            </section>
        `;
    }

    _renderSetup() {
        return html`
            <section class="hero hero--setup">
                <div class="hero__icon">🌐</div>
                <div class="hero__setup-text">
                    <h2>Add another language to get started</h2>
                    <p>AI Translate needs at least two languages. Create one below, or add it under <strong>Settings → Languages</strong>.</p>
                    <uui-button look="primary" color="positive" label="Create new language"
                        @click=${() => this._openCreateLanguage()}>
                        <uui-icon name="icon-add"></uui-icon>
                        Create new language
                    </uui-button>
                </div>
            </section>
        `;
    }

    _renderSettingsModal() {
        if (!this._settingsOpen) return nothing;
        const draft = this._settingsDraft;

        return html`
            <div class="overlay" @click=${(e) => { if (e.target === e.currentTarget) this._closeSettings(); }}>
                <div class="dialog" role="dialog" aria-modal="true" aria-label="AI Translate settings">
                    <h2 class="dialog__title">AI Translate settings</h2>
                    <p class="dialog__hint">Point the translator at your Umbraco AI profile and prompt. Leave blank to use the defaults.</p>

                    <label class="dialog__field">
                        <span>Profile alias</span>
                        <uui-input
                            .value=${draft.profileAlias}
                            placeholder=${DEFAULT_CONFIG.profileAlias}
                            @input=${(e) => { draft.profileAlias = e.target.value; }}></uui-input>
                    </label>

                    <label class="dialog__field">
                        <span>Prompt alias</span>
                        <uui-input
                            .value=${draft.promptAlias}
                            placeholder=${DEFAULT_CONFIG.promptAlias}
                            @input=${(e) => { draft.promptAlias = e.target.value; }}></uui-input>
                        <span class="dialog__sub">Create a prompt with this alias in the AI section to customise the translation instructions.</span>
                    </label>

                    <div class="dialog__actions dialog__actions--split">
                        <uui-button look="secondary" label="Set up AI section"
                            @click=${() => this._openGuide()}>Set up AI section…</uui-button>
                        <span class="spacer"></span>
                        <uui-button look="secondary" label="Cancel"
                            @click=${() => this._closeSettings()}>Cancel</uui-button>
                        <uui-button look="primary" color="positive" label="Save"
                            @click=${() => this._saveSettings(draft)}>Save</uui-button>
                    </div>
                </div>
            </div>
        `;
    }

    _renderCreateLanguageModal() {
        if (!this._createLangOpen) return nothing;

        const options = [
            { name: this._availableCultures.length === 0 ? 'Loading…' : 'Select a culture…', value: '', selected: !this._createLangIso, disabled: true },
            ...this._availableCultures.map((c) => ({
                name: `${c.englishName} — ${c.nativeName} (${c.isoCode})`,
                value: c.isoCode,
                selected: c.isoCode === this._createLangIso,
            })),
        ];

        return html`
            <div class="overlay" @click=${(e) => { if (e.target === e.currentTarget) this._closeCreateLanguage(); }}>
                <div class="dialog" role="dialog" aria-modal="true" aria-label="Create new language">
                    <h2 class="dialog__title">Create new language</h2>
                    <p class="dialog__hint">Pick a culture to add as an Umbraco language. It becomes available as a translation target.</p>

                    <uui-select
                        label="Culture"
                        ?disabled=${this._creatingLang || this._availableCultures.length === 0}
                        .options=${options}
                        @change=${(e) => { this._createLangIso = e.target.value; }}></uui-select>

                    <div class="dialog__actions">
                        <uui-button look="secondary" label="Cancel" ?disabled=${this._creatingLang}
                            @click=${() => this._closeCreateLanguage()}>Cancel</uui-button>
                        ${this._creatingLang
                            ? html`<uui-loader-circle></uui-loader-circle>`
                            : html`<uui-button look="primary" color="positive" label="Create" ?disabled=${!this._createLangIso}
                                @click=${() => this._confirmCreateLanguage()}>Create</uui-button>`}
                    </div>
                </div>
            </div>
        `;
    }

    render() {
        if (this._loading) {
            return html`<div class="loading"><uui-loader></uui-loader></div>`;
        }

        if (this._error) {
            return html`
                <section class="error">
                    <div class="error__icon">⚠️</div>
                    <h2>Something went wrong</h2>
                    <p>${this._error}</p>
                    <uui-button look="secondary" label="Retry" @click=${() => this._load()}>Try again</uui-button>
                </section>
            `;
        }

        const aiNotConfigured = this._status && this._status.configured === false;
        // _justVerified keeps the guide visible to show the success card after a
        // re-check instead of letting it vanish.
        const showGuide = aiNotConfigured || this._forceGuide || this._justVerified;
        const ready = this._languages.length >= 2;

        return html`
            <div class="topbar">
                <button class="cogbtn" title="Settings" aria-label="Settings"
                    @click=${() => this._openSettings()}>
                    <uui-icon name="icon-settings"></uui-icon>
                    Settings
                </button>
            </div>
            <header class="page-header">
                <h1>Translate content</h1>
                <p>A guided flow: choose your languages, pick the pages, and translate. Everything is saved as drafts for you to review.</p>
            </header>
            ${showGuide
                ? this._renderSetupGuide()
                : ready
                    ? html`
                        ${this._renderStepper()}
                        <section class="wizard">${this._renderStep()}</section>
                    `
                    : this._renderSetup()}
            ${this._renderSettingsModal()}
            ${this._renderCreateLanguageModal()}
        `;
    }

    static styles = css`
        :host {
            display: block;
            padding: var(--uui-size-layout-2);
            max-width: 960px;
            margin: 0 auto;
        }

        .topbar {
            display: flex;
            justify-content: flex-start;
            margin-bottom: var(--uui-size-space-2);
        }

        /* Plain button so the cog lines up exactly with the header text's
           left edge (uui-button adds its own horizontal padding). */
        .cogbtn {
            display: inline-flex;
            align-items: center;
            gap: var(--uui-size-space-2);
            border: none;
            background: none;
            padding: 0;
            font: inherit;
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--uui-color-text-alt);
            cursor: pointer;
        }

        .cogbtn:hover {
            color: var(--uui-color-text);
        }

        .cogbtn uui-icon {
            font-size: 1rem;
        }

        .page-header {
            margin-bottom: var(--uui-size-layout-1);
        }

        .page-header h1 {
            margin: 0 0 var(--uui-size-space-2);
            font-size: 1.75rem;
            font-weight: 600;
        }

        .page-header p {
            margin: 0;
            color: var(--uui-color-text-alt);
            font-size: 0.95rem;
        }

        .loading {
            display: flex;
            justify-content: center;
            padding: var(--uui-size-layout-3);
        }

        /* Stepper */

        .stepper {
            display: flex;
            align-items: center;
            gap: var(--uui-size-space-2);
            margin-bottom: var(--uui-size-layout-1);
        }

        .stepper__step {
            display: inline-flex;
            align-items: center;
            gap: var(--uui-size-space-2);
            border: none;
            background: none;
            padding: 0;
            font: inherit;
            color: var(--uui-color-text-alt);
            cursor: default;
        }

        .stepper__step--done {
            color: var(--uui-color-text);
            cursor: pointer;
        }

        .stepper__step--active {
            color: var(--uui-color-text);
            font-weight: 600;
        }

        .stepper__num {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            font-size: 0.85rem;
            font-weight: 700;
            background: var(--uui-color-surface-alt);
            border: 1px solid var(--uui-color-divider);
            color: var(--uui-color-text-alt);
        }

        .stepper__step--active .stepper__num {
            background: var(--uui-color-positive);
            border-color: var(--uui-color-positive);
            color: var(--uui-color-positive-contrast);
        }

        .stepper__step--done .stepper__num {
            background: var(--uui-color-positive);
            border-color: var(--uui-color-positive);
            color: var(--uui-color-positive-contrast);
        }

        .stepper__label {
            font-size: 0.9rem;
        }

        .stepper__bar {
            flex: 1;
            height: 2px;
            background: var(--uui-color-divider);
            min-width: 16px;
        }

        .stepper__bar--done {
            background: var(--uui-color-positive);
        }

        /* Wizard card */

        .wizard {
            background: var(--uui-color-surface);
            border: 1px solid var(--uui-color-divider);
            border-radius: var(--uui-border-radius);
            padding: var(--uui-size-layout-1);
        }

        .step {
            display: flex;
            flex-direction: column;
            gap: var(--uui-size-space-3);
        }

        .step--center {
            align-items: center;
            text-align: center;
        }

        .step__title {
            margin: 0;
            font-size: 1.3rem;
            font-weight: 600;
        }

        .step__title em {
            font-style: normal;
            color: var(--uui-color-positive);
        }

        .step__hint {
            margin: 0;
            color: var(--uui-color-text-alt);
            font-size: 0.95rem;
        }

        uui-select {
            width: 100%;
            max-width: 440px;
        }

        .step__or {
            display: flex;
            align-items: center;
            gap: var(--uui-size-space-4);
            flex-wrap: wrap;
            margin-top: var(--uui-size-space-2);
        }

        .step__or-hint {
            font-size: 0.85rem;
            color: var(--uui-color-text-alt);
        }

        .step__nav {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: var(--uui-size-space-3);
            margin-top: var(--uui-size-space-4);
            padding-top: var(--uui-size-space-4);
            border-top: 1px solid var(--uui-color-divider);
        }

        .step__nav--center {
            justify-content: center;
            border-top: none;
            padding-top: 0;
        }

        /* Pages step */

        .pages-controls {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: var(--uui-size-space-4);
            padding: var(--uui-size-space-3) var(--uui-size-space-4);
            background: var(--uui-color-surface-alt);
            border-radius: var(--uui-border-radius);
        }

        .pages-controls__left {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: var(--uui-size-space-4);
        }

        .pages-controls__toggles {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: var(--uui-size-space-4);
        }

        .pages-controls__count {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--uui-color-text);
        }

        .linkbtn {
            border: none;
            background: none;
            padding: 0;
            font: inherit;
            font-size: 0.85rem;
            color: var(--uui-color-interactive);
            cursor: pointer;
            text-decoration: underline;
        }

        .linkbtn:disabled {
            color: var(--uui-color-disabled-contrast);
            cursor: default;
            text-decoration: none;
        }

        .progress__head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--uui-size-space-4);
            font-size: 0.9rem;
            color: var(--uui-color-text);
        }

        /* Node list / tree */

        .nodes {
            border: 1px solid var(--uui-color-divider);
            border-radius: var(--uui-border-radius);
            overflow: hidden;
            max-height: 460px;
            overflow-y: auto;
        }

        .row {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto auto;
            align-items: center;
            gap: var(--uui-size-space-4);
            padding: var(--uui-size-space-3) var(--uui-size-space-5);
            border-top: 1px solid var(--uui-color-divider);
        }

        .row:first-child {
            border-top: none;
        }

        .row:hover {
            background: var(--uui-color-surface-alt);
        }

        .row--selected {
            background: var(--uui-color-current, rgba(0, 120, 220, 0.06));
        }

        .row--folder {
            display: flex;
            align-items: center;
            gap: var(--uui-size-space-2);
            color: var(--uui-color-text-alt);
            background: var(--uui-color-surface-alt);
            font-size: 0.9rem;
        }

        .row__folder-icon {
            font-size: 1rem;
            opacity: 0.7;
        }

        .row__name {
            font-weight: 600;
            color: var(--uui-color-text);
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .row__cultures {
            display: flex;
            flex-wrap: wrap;
            gap: var(--uui-size-space-1);
        }

        .row__status {
            display: flex;
            justify-content: flex-end;
        }

        .lang-dot {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 28px;
            height: 22px;
            padding: 0 6px;
            border-radius: 4px;
            font-size: 0.7rem;
            font-weight: 700;
            letter-spacing: 0.05em;
            border: 1px solid transparent;
        }

        .lang-dot--on {
            background: var(--uui-color-positive);
            color: var(--uui-color-positive-contrast);
            border-color: var(--uui-color-positive);
        }

        .lang-dot--off {
            background: transparent;
            color: var(--uui-color-text-alt);
            border-color: var(--uui-color-divider);
            border-style: dashed;
            opacity: 0.6;
        }

        /* Result */

        .result__icon {
            font-size: 3rem;
        }

        .result__errors {
            width: 100%;
            text-align: left;
            background: var(--uui-color-surface-alt);
            border-radius: var(--uui-border-radius);
            padding: var(--uui-size-space-4);
            font-size: 0.85rem;
        }

        .result__errors ul {
            margin: var(--uui-size-space-2) 0 0;
            padding-left: var(--uui-size-space-5);
        }

        /* AI setup guide */

        .guide {
            background: var(--uui-color-surface);
            border: 1px solid var(--uui-color-divider);
            border-radius: var(--uui-border-radius);
            padding: var(--uui-size-layout-1);
            max-width: 640px;
        }

        .guide__icon {
            font-size: 2.5rem;
            line-height: 1;
        }

        .guide__icon--ok {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: var(--uui-color-positive);
            color: var(--uui-color-positive-contrast);
            font-size: 1.8rem;
            font-weight: 700;
        }

        .guide__status {
            display: flex;
            align-items: center;
            gap: var(--uui-size-space-2);
            margin-bottom: var(--uui-size-space-4);
            font-size: 0.9rem;
        }

        .guide__status--fail {
            color: var(--uui-color-danger);
        }

        .guide__status-dot {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: var(--uui-color-danger);
            color: var(--uui-color-danger-contrast);
            font-weight: 700;
            font-size: 0.75rem;
            flex: none;
        }

        .guide__title {
            margin: var(--uui-size-space-3) 0 var(--uui-size-space-2);
            font-size: 1.3rem;
        }

        .guide__lead {
            margin: 0 0 var(--uui-size-space-4);
            color: var(--uui-color-text-alt);
        }

        .guide__steps {
            margin: 0 0 var(--uui-size-space-4);
            padding-left: var(--uui-size-space-5);
            display: flex;
            flex-direction: column;
            gap: var(--uui-size-space-2);
            color: var(--uui-color-text);
        }

        .guide code {
            background: var(--uui-color-surface-alt);
            border-radius: 4px;
            padding: 1px 6px;
            font-size: 0.85em;
        }

        .guide__detail {
            margin-bottom: var(--uui-size-space-4);
            font-size: 0.85rem;
            color: var(--uui-color-text-alt);
        }

        .guide__detail pre {
            white-space: pre-wrap;
            word-break: break-word;
            background: var(--uui-color-surface-alt);
            border-radius: var(--uui-border-radius);
            padding: var(--uui-size-space-3);
            margin: var(--uui-size-space-2) 0 0;
        }

        /* Setup / empty / error states */

        .hero--setup {
            display: flex;
            align-items: center;
            gap: var(--uui-size-space-5);
            background: var(--uui-color-surface);
            border: 1px solid var(--uui-color-divider);
            border-radius: var(--uui-border-radius);
            padding: var(--uui-size-layout-1);
        }

        .hero__icon {
            font-size: 2.5rem;
            line-height: 1;
        }

        .hero__setup-text h2 {
            margin: 0 0 var(--uui-size-space-2);
            font-size: 1.1rem;
        }

        .hero__setup-text p {
            margin: 0 0 var(--uui-size-space-4);
            color: var(--uui-color-text-alt);
        }

        .empty,
        .error {
            text-align: center;
            padding: var(--uui-size-layout-3) var(--uui-size-layout-1);
        }

        .empty__icon,
        .error__icon {
            font-size: 3rem;
            margin-bottom: var(--uui-size-space-4);
        }

        .empty h2,
        .error h2 {
            margin: 0 0 var(--uui-size-space-3);
            font-size: 1.2rem;
        }

        .empty p,
        .error p {
            margin: 0 auto var(--uui-size-space-5);
            color: var(--uui-color-text-alt);
            max-width: 50ch;
        }

        /* Create-language modal */

        .overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }

        .dialog {
            width: min(520px, 92vw);
            background: var(--uui-color-surface);
            border-radius: var(--uui-border-radius);
            padding: var(--uui-size-layout-1);
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
            display: flex;
            flex-direction: column;
            gap: var(--uui-size-space-4);
        }

        .dialog__title {
            margin: 0;
            font-size: 1.25rem;
        }

        .dialog__hint {
            margin: 0;
            color: var(--uui-color-text-alt);
            font-size: 0.9rem;
        }

        .dialog .dialog__actions {
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            align-items: center;
            gap: var(--uui-size-space-3);
        }

        .dialog__actions--split {
            justify-content: flex-start;
        }

        .dialog__actions--split .spacer {
            flex: 1;
        }

        .dialog__sub {
            font-size: 0.8rem;
            color: var(--uui-color-text-alt);
        }

        .dialog uui-input {
            width: 100%;
        }

        @media (max-width: 720px) {
            .row {
                grid-template-columns: auto minmax(0, 1fr);
                row-gap: var(--uui-size-space-2);
            }
            .row__cultures,
            .row__status {
                grid-column: 2 / -1;
                justify-content: flex-start;
            }
        }
    `;
}

customElements.define('ai-translate-dashboard', AiTranslateDashboardElement);

export default AiTranslateDashboardElement;
