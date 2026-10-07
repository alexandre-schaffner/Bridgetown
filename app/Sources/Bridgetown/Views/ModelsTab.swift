import SwiftUI

struct ModelsTab: View {
    @Environment(Store.self) private var store
    let settings: SettingsBinding
    @ViewState private var catalog: ModelCatalog?
    @ViewState private var loading = false
    @ViewState private var error: String?

    var body: some View {
        Form {
            ModelRoleSection(title: "Monitoring", note: "Investigates and fixes Slack and Grafana findings. Changes apply to new sessions; existing sessions keep their model.",
                             selection: settings.binding(\.models.monitoring), catalog: catalog, loading: loading)
            ModelRoleSection(title: "Reviewing", note: "Reviews pushed fixes before the PR leaves draft. Changes apply to the next review. Jev continues judging findings.",
                             selection: settings.binding(\.models.reviewing), catalog: catalog, loading: loading)
            Section {
                HStack {
                    Text(loading ? "Reading installed providers…" : "Models come from your installed Codex and Claude Code.")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Refresh models") { Task { await load(refresh: true) } }
                        .disabled(loading)
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .task { await load() }
    }

    private func load(refresh: Bool = false) async {
        loading = true
        defer { loading = false }
        do { catalog = try await store.fetch { try await $0.models(refresh: refresh) }; error = nil }
        catch { self.error = error.userMessage }
    }
}

private struct ModelRoleSection: View {
    let title: String
    let note: String
    @Binding var selection: ModelSelection
    let catalog: ModelCatalog?
    let loading: Bool
    @ViewState private var provider = "automatic"
    @ViewState private var model = ""
    @ViewState private var effort = ""
    @ViewState private var custom = false
    @ViewState private var customID = ""

    private var vendor: AgentProvider? { AgentProvider(rawValue: provider) }
    private var available: ProviderCatalog? { catalog?.providers.first { $0.provider == vendor } }
    private var known: AvailableModel? { available?.models.first { $0.id == model } }
    private var efforts: [String] {
        if let known { return known.efforts }
        if vendor == .claude { return ["low", "medium", "high", "xhigh", "max"] }
        return Array(Set(catalog?.providers.first { $0.provider == .codex }?.models.flatMap(\.efforts) ?? ["low", "medium", "high", "xhigh"]))
            .sorted { order($0) < order($1) }
    }

    var body: some View {
        Section {
            Picker("Provider", selection: Binding(get: { provider }, set: { chooseProvider($0) })) {
                Text("Automatic").tag("automatic")
                ForEach(AgentProvider.allCases, id: \.rawValue) { Text($0.name).tag($0.rawValue) }
            }
            .accessibilityIdentifier("models.\(title.lowercased()).provider")
            if vendor != nil {
                Picker("Model", selection: Binding(get: { custom ? "__custom__" : model }, set: { chooseModel($0) })) {
                    ForEach(available?.models ?? []) { Text($0.name).tag($0.id) }
                    if !model.isEmpty && known == nil && !custom { Text(model).tag(model) }
                    Text("Custom model…").tag("__custom__")
                }
                .accessibilityIdentifier("models.\(title.lowercased()).model")
                if custom {
                    HStack {
                        TextField("Model ID", text: $customID, prompt: Text("Exact model ID"))
                            .textFieldStyle(.roundedBorder)
                            .onSubmit(commitCustom)
                            .accessibilityIdentifier("models.\(title.lowercased()).custom")
                        Button("Use model", action: commitCustom)
                            .disabled(customID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                Picker("Effort", selection: Binding(get: { effort }, set: { chooseEffort($0) })) {
                    Text("Provider default").tag("")
                    ForEach(efforts, id: \.self) { Text(effortName($0)).tag($0) }
                    if !effort.isEmpty && !efforts.contains(effort) { Text(effortName(effort)).tag(effort) }
                }
                .disabled(model.isEmpty)
                .accessibilityIdentifier("models.\(title.lowercased()).effort")
            }
        } header: {
            Text(title)
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text(provider == "automatic" ? "Automatic uses the existing quick, standard and deep task profiles." : note)
                if let error = available?.error { Text(error).foregroundStyle(.red) }
                if vendor != nil && available == nil && loading { Text("Loading models. You can also enter a custom model ID.") }
                if vendor != nil && model.isEmpty { Text("Choose a model to save this provider.") }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .onAppear(perform: sync)
        .onChange(of: selection) { _, _ in sync() }
        .onChange(of: available?.models) { _, models in
            if custom && customID == model && models?.contains(where: { $0.id == model }) == true { custom = false }
        }
    }

    private func sync() {
        provider = selection.provider?.rawValue ?? "automatic"
        model = selection.model
        effort = selection.effort ?? ""
        customID = model
        custom = !model.isEmpty && !(available?.models.contains { $0.id == model } ?? false)
    }

    private func chooseProvider(_ value: String) {
        provider = value
        effort = ""
        if value == "automatic" { model = ""; custom = false; selection = .automatic; return }
        if let candidate = available?.models.first(where: \.isDefault) ?? available?.models.first {
            model = candidate.id; custom = false; save()
        } else {
            model = ""; customID = ""; custom = true
        }
    }

    private func chooseModel(_ value: String) {
        if value == "__custom__" { custom = true; customID = model; return }
        model = value
        custom = false
        if !effort.isEmpty && !efforts.contains(effort) { effort = "" }
        save()
    }

    private func chooseEffort(_ value: String) { effort = value; save() }
    private func commitCustom() {
        let value = customID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        model = value
        if !effort.isEmpty && !efforts.contains(effort) { effort = "" }
        save()
    }
    private func save() {
        guard let vendor, !model.isEmpty else { return }
        selection = .manual(provider: vendor, model: model, effort: effort.isEmpty ? nil : effort)
    }
    private func order(_ value: String) -> Int { ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].firstIndex(of: value) ?? 99 }
    private func effortName(_ value: String) -> String { value == "xhigh" ? "Extra high" : value.capitalized }
}
