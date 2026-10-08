import Foundation

enum AgentProvider: String, Codable, Sendable, CaseIterable {
    case claude, codex
    var name: String { self == .claude ? "Claude Code" : "Codex" }
}

enum ModelSelection: Codable, Sendable, Equatable {
    case automatic
    case manual(provider: AgentProvider, model: String, effort: String?)

    enum CodingKeys: String, CodingKey { case mode, provider, model, effort }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .mode) {
        case "automatic": self = .automatic
        case "manual": self = .manual(provider: try c.decode(AgentProvider.self, forKey: .provider), model: try c.decode(String.self, forKey: .model), effort: try c.decodeIfPresent(String.self, forKey: .effort))
        default: throw DecodingError.dataCorruptedError(forKey: .mode, in: c, debugDescription: "Unknown model configuration mode")
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .automatic: try c.encode("automatic", forKey: .mode)
        case let .manual(provider, model, effort):
            try c.encode("manual", forKey: .mode)
            try c.encode(provider, forKey: .provider)
            try c.encode(model, forKey: .model)
            try c.encode(effort, forKey: .effort)
        }
    }
    var provider: AgentProvider? { if case let .manual(provider, _, _) = self { provider } else { nil } }
    var model: String { if case let .manual(_, model, _) = self { model } else { "" } }
    var effort: String? { if case let .manual(_, _, effort) = self { effort } else { nil } }
}

struct ModelSettings: Codable, Sendable, Equatable {
    var monitoring: ModelSelection = .automatic
    var reviewing: ModelSelection = .automatic
}

struct ModelCatalog: Codable, Sendable, Equatable {
    var providers: [ProviderCatalog]
}
struct ProviderCatalog: Codable, Sendable, Equatable {
    var provider: AgentProvider
    var models: [AvailableModel]
    var error: String?
}
struct AvailableModel: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var efforts: [String]
    var defaultEffort: String?
    var isDefault: Bool
}
