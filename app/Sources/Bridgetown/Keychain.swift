import Foundation
import Security

/// Bridgetown's secrets, kept in one generic-password item (service `xyz.merkl.bridgetown`,
/// account `credentials`) holding a small JSON object, and read at most once per launch.
///
/// One item means one Keychain approval instead of one per secret. Because the app creates
/// the item itself, its own code signature is on the item's access list and later reads
/// don't prompt, as long as the signing identity stays the same across builds: `make app`
/// signs with the Makefile's `SIGN_IDENTITY` when that certificate is in your keychain, and
/// ad hoc otherwise (a new signature every build, so the Keychain asks again).
enum Keychain {
    enum Account: String, CaseIterable, Codable {
        case slackUserToken = "slack-user-token"
        case typesafeAPIKey = "typesafe-api-key"
    }

    static let service = "xyz.merkl.bridgetown"
    private static let credentialsAccount = "credentials"

    @MainActor private static var cache: [String: String]?

    @MainActor
    static func read(_ account: Account) -> String? {
        let value = credentials()[account.rawValue]
        return value?.isEmpty == false ? value : nil
    }

    /// Saves `value`, or removes it when `value` is empty.
    @MainActor @discardableResult
    static func write(_ value: String, for account: Account) -> Bool {
        var next = credentials()
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        next[account.rawValue] = trimmed.isEmpty ? nil : trimmed
        #if DEBUG
        if inMemory != nil {
            inMemory = next
            return true
        }
        #endif
        guard store(next) else { return false }
        cache = next
        return true
    }

    // MARK: Storage

    #if DEBUG
    /// Stands in for the Keychain item while set: an e2e run (`E2EHarness`) never reads or
    /// writes the real tokens, and a rebuilt debug binary, a new signature, would put up a
    /// Keychain prompt that blocks it.
    @MainActor static var inMemory: [String: String]?
    #endif

    @MainActor
    private static func credentials() -> [String: String] {
        #if DEBUG
        if let inMemory { return inMemory }
        #endif
        if let cache { return cache }
        let loaded = loadCombined() ?? migrateLegacyItems()
        cache = loaded
        return loaded
    }

    private static func loadCombined() -> [String: String]? {
        guard let data = readData(account: credentialsAccount) else { return nil }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    /// Earlier builds kept one item per secret. Read them once, fold them into the
    /// combined item, and delete them so they never prompt again.
    @MainActor
    private static func migrateLegacyItems() -> [String: String] {
        var merged: [String: String] = [:]
        for account in Account.allCases {
            if let data = readData(account: account.rawValue), let value = String(data: data, encoding: .utf8), !value.isEmpty {
                merged[account.rawValue] = value
            }
        }
        if !merged.isEmpty, store(merged) {
            for account in Account.allCases { deleteItem(account: account.rawValue) }
        }
        return merged
    }

    private static func store(_ values: [String: String]) -> Bool {
        guard let data = try? JSONEncoder().encode(values) else { return false }
        let query = baseQuery(account: credentialsAccount)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status != errSecItemNotFound { return status == errSecSuccess }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        add[kSecAttrLabel as String] = "Bridgetown credentials"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    private static func readData(account: String) -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func deleteItem(account: String) {
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
