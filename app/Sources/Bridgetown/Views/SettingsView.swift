import AppKit
import SwiftUI

struct SettingsView: View {
    enum Tab: String { case accounts, channels, triage, models, repos, behaviour, memory }

    @ViewState private var tab: Tab

    init(initialTab: Tab = .accounts) {
        _tab = ViewState(initialValue: initialTab)
    }

    var body: some View {
        TabView(selection: $tab) {
            AccountsTab()
                .tabItem { Label("Accounts", systemImage: "person.crop.circle") }
                .tag(Tab.accounts)
            DaemonSettings { ChannelsTab(settings: $0) }
                .tabItem { Label("Channels", systemImage: "number") }
                .tag(Tab.channels)
            DaemonSettings { TriageTab(settings: $0) }
                .tabItem { Label("Triage", systemImage: "slider.horizontal.3") }
                .tag(Tab.triage)
            DaemonSettings { ModelsTab(settings: $0) }
                .tabItem { Label("Models", systemImage: "cpu") }
                .tag(Tab.models)
            DaemonSettings { ReposTab(settings: $0) }
                .tabItem { Label("Repos", systemImage: "folder") }
                .tag(Tab.repos)
            DaemonSettings { MemoryTab(settings: $0) }
                .tabItem { Label("Memory", systemImage: "brain") }
                .tag(Tab.memory)
            DaemonSettings { BehaviourTab(settings: $0) }
                .tabItem { Label("Behaviour", systemImage: "moon") }
                .tag(Tab.behaviour)
        }
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// Shows `content` with live settings from the daemon, or a placeholder while disconnected.
/// Writes go through the Store, which applies them locally and POSTs `/settings`.
private struct DaemonSettings<Content: View>: View {
    @Environment(Store.self) private var store
    @ViewBuilder var content: (SettingsBinding) -> Content

    var body: some View {
        if let settings = store.snapshot?.settings {
            content(SettingsBinding(store: store, value: settings))
        } else {
            Form {
                Text("Connect to the daemon to edit these settings.")
                    .foregroundStyle(.secondary)
            }
            .formStyle(.grouped)
            .frame(minHeight: 120)
        }
    }
}

/// The settings as shown (rebuilt on every snapshot), and bindings into them by key path.
@MainActor
struct SettingsBinding {
    let store: Store
    let value: Settings

    /// With `debounce`, rapid edits (sliders, text fields) coalesce into one request.
    func binding<T>(_ key: WritableKeyPath<Settings, T>, debounce: Bool = false) -> Binding<T> {
        Binding(
            get: { value[keyPath: key] },
            set: { new in store.editSettings(debounce: debounce) { $0[keyPath: key] = new } }
        )
    }
}

// MARK: - Accounts

private struct AccountsTab: View {
    @Environment(DaemonProcess.self) private var daemon
    @ViewState private var slackToken = ""
    @ViewState private var typesafeKey = ""
    @ViewState private var savedSlack = ""
    @ViewState private var savedTypesafe = ""
    @ViewState private var launchAtLogin = LoginItem.isEnabled
    @ViewState private var loginError: String?
    @ViewState private var savedNote: String?

    private var dirty: Bool { slackToken != savedSlack || typesafeKey != savedTypesafe }

    var body: some View {
        Form {
            Section {
                SecureField("Slack user token", text: $slackToken, prompt: Text("xoxp-…"))
                SecureField("TypeSafe API key", text: $typesafeKey, prompt: Text("ts_…"))
            } header: {
                Text("Tokens")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Stored in your Keychain. The Slack token needs these user scopes (see slack-app-manifest.yml): `channels:history`, `groups:history`, `im:history`, `mpim:history`, `search:read`, `usergroups:read`, `users:read`, `reactions:read`, `chat:write`.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack {
                        if let savedNote {
                            Text(savedNote).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Save and restart daemon", action: save)
                            .disabled(!dirty)
                            .keyboardShortcut(.defaultAction)
                    }
                }
            }

            Section {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .disabled(!LoginItem.isSupported)
                    .onChange(of: launchAtLogin) { _, on in
                        guard on != LoginItem.isEnabled else { return }
                        loginError = LoginItem.setEnabled(on)
                        launchAtLogin = LoginItem.isEnabled
                    }
            } footer: {
                if !LoginItem.isSupported {
                    Text("Available when running from Bridgetown.app.").font(.caption).foregroundStyle(.secondary)
                } else if let loginError {
                    Text(loginError).font(.caption).foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: load)
    }

    /// Fields left empty when the Keychain refuses would read as "nothing saved".
    private func load() {
        guard let saved = Keychain.secrets() else {
            savedNote = "Couldn't read the Keychain"
            return
        }
        savedSlack = saved[.slackUserToken] ?? ""
        savedTypesafe = saved[.typesafeAPIKey] ?? ""
        slackToken = savedSlack
        typesafeKey = savedTypesafe
    }

    /// Only the fields you edited: one left empty because the Keychain refused to read
    /// would otherwise remove its secret once the Keychain allows the save.
    private func save() {
        var edits: [Keychain.Account: String] = [:]
        if slackToken != savedSlack { edits[.slackUserToken] = slackToken }
        if typesafeKey != savedTypesafe { edits[.typesafeAPIKey] = typesafeKey }
        guard Keychain.save(edits) else {
            savedNote = "Couldn't save to the Keychain"
            return
        }
        load()
        if daemon.mode.canManage {
            daemon.restart()
            savedNote = "Saved. Daemon restarting."
        } else {
            savedNote = "Saved. Restart the attached daemon to pick them up."
        }
    }
}

// MARK: - Channels

private struct ChannelsTab: View {
    let settings: SettingsBinding

    var body: some View {
        Form {
            Section {
                Toggle("Watch my mentions & DMs everywhere", isOn: settings.binding(\.inbox))
            } footer: {
                Text("Jev hands each mention or DM to an agent, or escalates it to you under Needs you.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                if settings.value.channels.isEmpty {
                    Text("No #alert-* channels found yet.").foregroundStyle(.secondary)
                }
                ForEach(settings.value.channels) { channel in
                    Toggle(isOn: settings.binding(\.[channel: channel.id])) {
                        Text("#\(channel.name)")
                    }
                }
            } header: {
                Text("Alert channels")
            } footer: {
                Text("Bot posts in these channels are triaged as alerts. A channel added in an update starts off.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Triage

private struct TriageTab: View {
    let settings: SettingsBinding

    var body: some View {
        Form {
            Section {
                Toggle("Start agents automatically", isOn: settings.binding(\.autoStart))
                stepper("Concurrent sessions", "\(settings.value.maxConcurrent)",
                        settings.binding(\.maxConcurrent), in: 1...8)
                stepper("Poll Slack every", "\(settings.value.pollSeconds)s",
                        settings.binding(\.pollSeconds, debounce: true), in: 10...600, step: 5)
            } footer: {
                Text("With auto-start off, every candidate waits for you under Needs you.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Auto-start when") {
                threshold("Actionable ≥", \.autoActionable)
                threshold("Agent-resolvable ≥", \.autoResolvable)
                threshold("Human on it ≤", \.autoHumanOnItMax)
            }

            Section("Suggest when") {
                threshold("Actionable ≥", \.suggestActionable)
                threshold("Agent-resolvable ≥", \.suggestResolvable)
            }

            Section {
                threshold("Real defect ≥", \.findingReal)
                threshold("Blocking ≥", \.findingBlocking)
                threshold("Answered by agent <", \.findingRebutted)
            } header: {
                Text("Review finding goes back to the agent when")
            } footer: {
                Text("Jev judges each finding from the adversarial review. Everything else is dropped as a nitpick.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func stepper(_ label: String, _ value: String, _ binding: Binding<Int>, in range: ClosedRange<Int>, step: Int = 1) -> some View {
        LabeledContent(label) {
            HStack(spacing: 6) {
                Text(value).monospacedDigit()
                Stepper(label, value: binding, in: range, step: step).labelsHidden()
            }
        }
    }

    private func threshold(_ label: String, _ key: WritableKeyPath<Settings.Thresholds, Double>) -> some View {
        let thresholds: WritableKeyPath<Settings, Settings.Thresholds> = \.thresholds
        let raw = settings.binding(thresholds.appending(path: key), debounce: true)
        let binding = Binding(get: { raw.wrappedValue }, set: { raw.wrappedValue = ($0 * 100).rounded() / 100 })
        return LabeledContent(label) {
            HStack(spacing: 10) {
                Slider(value: binding, in: 0...1)
                    .controlSize(.small)
                    .frame(width: 180)
                Text(Format.percent(binding.wrappedValue))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 36, alignment: .trailing)
            }
        }
    }
}

// MARK: - Repos

private struct ReposTab: View {
    let settings: SettingsBinding

    var body: some View {
        Form {
            Section {
                path("Monorepo", \.monorepoPath)
                path("Deployment repo", \.deploymentRepoPath)
            } footer: {
                Text("Agents work in git worktrees created from these checkouts.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func path(_ label: String, _ key: WritableKeyPath<Settings, String>) -> some View {
        let binding = settings.binding(key, debounce: true)
        return LabeledContent(label) {
            HStack(spacing: 6) {
                TextField(label, text: binding, prompt: Text("~/code/…"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                Button("Choose…") {
                    let panel = NSOpenPanel()
                    panel.canChooseDirectories = true
                    panel.canChooseFiles = false
                    panel.allowsMultipleSelection = false
                    panel.directoryURL = URL(fileURLWithPath: (binding.wrappedValue as NSString).expandingTildeInPath)
                    if panel.runModal() == .OK, let url = panel.url { binding.wrappedValue = url.path }
                }
                .controlSize(.small)
            }
        }
    }
}

// MARK: - Behaviour

private struct BehaviourTab: View {
    let settings: SettingsBinding

    var body: some View {
        Form {
            Section {
                Toggle("Dry run", isOn: settings.binding(\.dryRun))
            } footer: {
                Text("Agents still run, but nothing is posted to Slack.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                Toggle("Adversarial review", isOn: settings.binding(\.adversarialReview))
            } footer: {
                Text("Your configured review model reviews every fix an agent pushes, and the agent fixes what it finds, before the PR leaves draft. Off: PRs go straight to CI.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                Toggle("Watch prod", isOn: settings.binding(\.watchProd))
            } footer: {
                Text("Every 5 minutes, Bridgetown checks the overview's prod signals in Grafana for rises and spikes; every 10, it sweeps prod's error and warning logs for new, surging or risky patterns and has Jev judge them in one batch. Each anomaly no Slack alert covers gets an investigation, started the way Auto-start starts one for an alert; paused or with Auto-start off, it waits in Needs you. One Jev sees nothing in is only suggested.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                Toggle("Quiet hours", isOn: settings.binding(\.quietHours.enabled))
                if settings.value.quietHours.enabled {
                    DatePicker("From", selection: time(\.start), displayedComponents: .hourAndMinute)
                    DatePicker("Until", selection: time(\.end), displayedComponents: .hourAndMinute)
                }
            } footer: {
                Text("No notifications during quiet hours. Auto-start keeps running.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func time(_ key: WritableKeyPath<Settings.QuietHours, String>) -> Binding<Date> {
        let quietHours: WritableKeyPath<Settings, Settings.QuietHours> = \.quietHours
        let raw = settings.binding(quietHours.appending(path: key), debounce: true)
        return Binding(get: { Self.date(from: raw.wrappedValue) }, set: { raw.wrappedValue = Self.string(from: $0) })
    }

    private static func date(from hhmm: String) -> Date {
        let minutes = QuietHours.minutes(hhmm) ?? 0
        return Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: .now) ?? .now
    }

    private static func string(from date: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }
}

// MARK: - Memory

private struct MemoryTab: View {
    @Environment(Store.self) private var store
    let settings: SettingsBinding
    @ViewState private var status: MemoryStatus?
    @ViewState private var requestError: String?
    @ViewState private var submitting = false

    var body: some View {
        Form {
            Section {
                Toggle("Remember across messages and sessions", isOn: settings.binding(\.memory))
            } footer: {
                Text("Learns from newly watched messages, your answers and actions, and agent findings about once a minute; consolidates every six hours when there is new evidence. Choose its provider and model in Models → Memory. Learning stops after two minutes; consolidation after five. Claude jobs also have $0.50 and $1 spend limits, respectively.")
                    .font(.caption)
            }
            Section("Local memory") {
                if let status {
                    LabeledContent("Status", value: settings.value.memory ? status.label : "Disabled")
                    LabeledContent("Pending evidence", value: "\(status.pending)")
                    LabeledContent("Last learned", value: time(status.lastLearnedAt))
                    LabeledContent("Last consolidated", value: time(status.lastDreamedAt))
                    Text(status.path).font(.caption).textSelection(.enabled)
                    if let error = status.error {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                } else {
                    Text("Reading memory status…").foregroundStyle(.secondary)
                }
                HStack {
                    Button("Run now") { Task { await run() } }
                        .disabled(!settings.value.memory || submitting || status?.isWorking == true)
                    Button("Open memory folder") {
                        if let path = status?.path { NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true)) }
                    }
                    .disabled(status == nil)
                }
                if let requestError { Text(requestError).font(.caption).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .task {
            while !Task.isCancelled {
                await reload()
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }

    private func time(_ date: Date?) -> String {
        date?.formatted(date: .abbreviated, time: .shortened) ?? "Never"
    }

    @MainActor private func reload() async {
        do {
            status = try await store.fetch { try await $0.memoryStatus() }
            requestError = nil
        } catch { requestError = error.userMessage }
    }

    @MainActor private func run() async {
        submitting = true
        defer { submitting = false }
        do {
            status = try await store.fetch { try await $0.runMemory() }
            requestError = nil
        } catch { requestError = error.userMessage }
    }
}
